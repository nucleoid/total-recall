import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { accessLevelSql } from '../auth.js';
import { logAudit } from '../audit.js';
import { dbScopeFromAuth, queryScoped, withScopedClient, type ScopedClient } from '../db.js';
import { embedWithProfile, serializeEmbeddingVector } from '../embedding.js';
import { AuthorizationError, MemoryConflictError, MemoryNotFoundError } from '../errors.js';
import {
  MEMORY_CONTENT_MAX_CHARS,
  TAG_MAX_CHARS,
  TAG_MAX_COUNT,
  metadataSchema,
} from '../http-limits.js';
import type { AuthContext, Memory } from '../types.js';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const updateContent = z.string().max(MEMORY_CONTENT_MAX_CHARS).refine(
  value => value.trim().length > 0,
  'Content must not be blank',
);

export const updateSchema = z.object({
  id: uuid,
  content: updateContent.optional(),
  tags: z.array(z.string().max(TAG_MAX_CHARS)).max(TAG_MAX_COUNT).optional(),
  metadata: metadataSchema.optional(),
  supersedes: uuid.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.content === undefined && value.tags === undefined && value.metadata === undefined && value.supersedes === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one update field is required' });
  }
  if (value.supersedes === value.id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['supersedes'], message: 'A memory cannot supersede itself' });
  }
});

export type MemoryUpdateParams = z.infer<typeof updateSchema>;

type UpdateRow = Memory & {
  embedding: string | null;
  embedding_provider: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  supersedes_id: string | null;
  superseded_at: Date | null;
  revision: number;
};

function updateResultColumns(validitySchema: boolean): string {
  const validityColumns = validitySchema
    ? 'm.memory_kind, m.valid_from, m.valid_to,'
    : "'unspecified'::text AS memory_kind, NULL::timestamptz AS valid_from, NULL::timestamptz AS valid_to,";
  return `m.id, m.content, m.source, m.namespace, m.tags, m.metadata,
  m.access_level, m.created_at, m.updated_at, m.document_id, m.chunk_index,
  ${validityColumns}
  m.superseded_at, m.revision, m.expires_at,
  (SELECT predecessor.id FROM memories predecessor
   WHERE predecessor.id = m.supersedes_id
     AND predecessor.deleted_at IS NULL
     AND (predecessor.expires_at IS NULL OR predecessor.expires_at > statement_timestamp())
     AND predecessor.namespace = m.namespace
     AND predecessor.namespace = ANY($2::text[])
     AND ${accessLevelSql('predecessor.access_level', '$3')}
   LIMIT 1) AS supersedes_id,
  (m.superseded_at IS NOT NULL) AS is_superseded`;
}

function notFound(): never {
  throw new MemoryNotFoundError();
}

async function readCurrentTarget(id: string, auth: AuthContext): Promise<UpdateRow> {
  const result = await queryScoped<UpdateRow>(
    dbScopeFromAuth(auth),
    `SELECT m.*, m.embedding::text AS embedding
     FROM memories m
     WHERE m.id = $1::uuid
       AND m.deleted_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
       AND m.superseded_at IS NULL
       AND to_jsonb(m)->>'consolidated_into_id' IS NULL
       AND to_jsonb(m)->>'memory_kind' IS DISTINCT FROM 'consolidation'
       AND m.namespace = ANY($2::text[])
       AND ${accessLevelSql('m.access_level', '$3')}`,
    [id, auth.namespaces, auth.maxAccessLevel],
  );
  if (result.rows.length === 0) notFound();
  return result.rows[0];
}

async function assertNoCycle(client: ScopedClient, targetId: string, predecessorId: string): Promise<void> {
  const result = await client.query<{ id: string; depth: number }>(
    `WITH RECURSIVE ancestors(id, supersedes_id, depth) AS (
       SELECT id, supersedes_id, 1 FROM memories WHERE id = $1::uuid
       UNION ALL
       SELECT m.id, m.supersedes_id, a.depth + 1
       FROM memories m
       JOIN ancestors a ON m.id = a.supersedes_id
       WHERE a.depth < 101
     )
     SELECT id, depth FROM ancestors WHERE id = $2::uuid OR depth = 101 LIMIT 1`,
    [predecessorId, targetId],
  );
  if (result.rows.length > 0) {
    throw new MemoryConflictError(result.rows[0].depth === 101
      ? 'Supersession chain is too deep or cyclic'
      : 'Supersession would create a cycle');
  }
}

/** Patch an active current memory and optionally close the predecessor it supersedes. */
export async function memoryUpdate(input: unknown, auth: AuthContext, expectedUpdatedAt?: string): Promise<Memory> {
  const params = updateSchema.parse(input);
  if (!auth.permissions.includes('write')) {
    throw new AuthorizationError("Permission denied: requires 'write'");
  }
  const scope = dbScopeFromAuth(auth);

  // Embedding providers are called before locks are held. The revision guard
  // below makes the resulting content/vector pair optimistic but atomic.
  let initial: UpdateRow | undefined;
  let vector: string | undefined;
  let descriptor: unknown[] | undefined;
  if (params.content !== undefined) {
    initial = await readCurrentTarget(params.id, auth);
    if (params.content !== initial.content) {
      const embedding = await embedWithProfile(params.content);
      vector = serializeEmbeddingVector(embedding.vector);
      descriptor = [embedding.provider, embedding.model, embedding.dimensions];
    }
  }

  try {
    return await withScopedClient(scope, async client => {
      const lockIds = [params.id, ...(params.supersedes ? [params.supersedes] : [])].sort();
      const locked = await client.query<UpdateRow>(
        `SELECT m.*, m.embedding::text AS embedding
         FROM memories m
         WHERE m.id = ANY($1::uuid[])
           AND m.deleted_at IS NULL
           AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
           AND m.superseded_at IS NULL
           AND to_jsonb(m)->>'consolidated_into_id' IS NULL
           AND to_jsonb(m)->>'memory_kind' IS DISTINCT FROM 'consolidation'
           AND m.namespace = ANY($2::text[])
           AND ${accessLevelSql('m.access_level', '$3')}
         ORDER BY m.id
         FOR UPDATE`,
        [lockIds, auth.namespaces, auth.maxAccessLevel],
      );
      const rows = new Map(locked.rows.map(row => [row.id, row]));
      const target = rows.get(params.id);
      if (!target) notFound();
      const predecessor = params.supersedes ? rows.get(params.supersedes) : undefined;
      if (params.supersedes && !predecessor) notFound();

      if (expectedUpdatedAt !== undefined &&
          new Date(target.updated_at).getTime() !== new Date(expectedUpdatedAt).getTime()) {
        throw new MemoryConflictError('Memory changed since the dashboard loaded it');
      }
      if (initial && target.revision !== initial.revision) {
        throw new MemoryConflictError('Memory changed while its embedding was being prepared');
      }
      if (predecessor && predecessor.namespace !== target.namespace) {
        throw new MemoryConflictError('Successor and predecessor must be in the same namespace');
      }
      if (predecessor && (predecessor.expires_at != null || target.expires_at != null)) {
        throw new MemoryConflictError('An expiring memory cannot participate in durable supersession history');
      }
      if (params.supersedes && target.supersedes_id !== null) {
        throw new MemoryConflictError('The memory already has an immutable predecessor link');
      }

      let validitySchema = false;
      if (predecessor) {
        const validityColumns = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM pg_attribute
           WHERE attrelid = 'public.memories'::regclass
             AND attname::text = ANY(ARRAY['memory_kind', 'valid_from', 'valid_to']::text[])
             AND NOT attisdropped`,
        );
        const validityColumnCount = Number(validityColumns.rows[0]?.count ?? -1);
        if (validityColumnCount !== 0 && validityColumnCount !== 3) {
          throw new Error('Memory validity schema is partially deployed; refusing manual supersession');
        }
        validitySchema = validityColumnCount === 3;

        const successor = await client.query(
          'SELECT id FROM memories WHERE supersedes_id = $1::uuid LIMIT 1',
          [predecessor.id],
        );
        if (successor.rows.length > 0 || predecessor.superseded_at !== null) {
          throw new MemoryConflictError('The predecessor already has a successor');
        }
        await assertNoCycle(client, target.id, predecessor.id);
      }

      const contentChanged = params.content !== undefined && params.content !== target.content;
      const tagsChanged = params.tags !== undefined && !isDeepStrictEqual(params.tags, target.tags);
      const metadataChanged = params.metadata !== undefined && !isDeepStrictEqual(params.metadata, target.metadata);
      const linkChanged = predecessor !== undefined;
      const targetChanged = contentChanged || tagsChanged || metadataChanged || linkChanged;
      // Preserve PostgreSQL microseconds so a same-millisecond supersession
      // cannot round valid_to down to or before the predecessor's valid_from.
      const timestamp = targetChanged
        ? (await client.query<{ now: string }>('SELECT statement_timestamp()::text AS now')).rows[0].now
        : undefined;

      if (targetChanged) {
        const values: unknown[] = [];
        const assignments: string[] = [];
        const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
        if (contentChanged) {
          assignments.push(`content = ${parameter(params.content)}`);
          assignments.push(`embedding = ${parameter(vector)}::vector`);
          assignments.push(`embedding_provider = ${parameter(descriptor![0])}`);
          assignments.push(`embedding_model = ${parameter(descriptor![1])}`);
          assignments.push(`embedding_dimensions = ${parameter(descriptor![2])}`);
        }
        if (tagsChanged) assignments.push(`tags = ${parameter(params.tags)}::text[]`);
        if (metadataChanged) assignments.push(`metadata = ${parameter(JSON.stringify(params.metadata))}::jsonb`);
        if (linkChanged) {
          assignments.push(`supersedes_id = ${parameter(predecessor!.id)}::uuid`);
          if (validitySchema) assignments.push(`valid_from = ${parameter(timestamp)}::timestamptz`);
        }
        assignments.push(`updated_at = ${parameter(timestamp)}::timestamptz`);
        values.push(target.id);
        await client.query(
          `UPDATE memories SET ${assignments.join(', ')} WHERE id = $${values.length}::uuid
             AND (expires_at IS NULL OR expires_at > statement_timestamp())
             AND to_jsonb(memories)->>'consolidated_into_id' IS NULL
             AND to_jsonb(memories)->>'memory_kind' IS DISTINCT FROM 'consolidation'`,
          values,
        );
      }

      if (predecessor) {
        const validityClosure = validitySchema ? ', valid_to = $1::timestamptz' : '';
        const closed = await client.query(
          `UPDATE memories SET superseded_at = $1::timestamptz${validityClosure}, updated_at = $1::timestamptz
           WHERE id = $2::uuid AND superseded_at IS NULL
             AND expires_at IS NULL
             AND to_jsonb(memories)->>'consolidated_into_id' IS NULL AND to_jsonb(memories)->>'memory_kind' IS DISTINCT FROM 'consolidation'`,
          [timestamp, predecessor.id],
        );
        if (closed.rowCount !== 1) {
          throw new MemoryConflictError('The predecessor changed while supersession was being committed');
        }
      }

      if (targetChanged) {
        await logAudit({
          clientId: auth.keyId,
          action: 'memory.update',
          namespace: target.namespace,
          memoryId: target.id,
        }, scope, client);
      }
      if (predecessor) {
        await logAudit({
          clientId: auth.keyId,
          action: 'belief.supersede',
          namespace: target.namespace,
          memoryId: predecessor.id,
        }, scope, client);
      }

      const result = await client.query(
        `SELECT ${updateResultColumns(validitySchema)},
           (SELECT successor.id FROM memories successor
            WHERE successor.supersedes_id = m.id
              AND successor.deleted_at IS NULL
              AND (successor.expires_at IS NULL OR successor.expires_at > statement_timestamp())
              AND successor.namespace = m.namespace
              AND successor.namespace = ANY($2::text[])
              AND ${accessLevelSql('successor.access_level', '$3')}
            LIMIT 1) AS superseded_by_id
         FROM memories m
         WHERE m.id = $1::uuid
           AND m.deleted_at IS NULL
           AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
           AND m.namespace = ANY($2::text[])
           AND ${accessLevelSql('m.access_level', '$3')}`,
        [target.id, auth.namespaces, auth.maxAccessLevel],
      );
      return result.rows[0] as Memory;
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error &&
        (error.code === '23505' || error.code === '23514' || error.code === '23503')) {
      throw new MemoryConflictError('Supersession conflicts with existing memory history');
    }
    throw error;
  }
}
