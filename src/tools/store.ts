import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dbScopeFromAuth, withScopedClient } from '../db.js';
import { embedWithProfile, serializeEmbeddingVector } from '../embedding.js';
import type { AuthContext, StoreResult } from '../types.js';
import { checkPermission, ensureAccessLevelAllowed, filterNamespaces } from '../auth.js';
import { resolveAgent } from '../agents.js';
import { SupersededSourceKeyConflictError, TombstonedSourceKeyConflictError } from '../errors.js';
import {
  contradictionPolicyFromEnv,
  maybeReviseBelief,
  policyAllowsScope,
  scheduleShadowClassification,
  type ContradictionPolicy,
  type ContradictionReason,
  type SemanticMemoryInsert,
} from '../contradictions.js';
import {
  MEMORY_CONTENT_MAX_CHARS,
  TAG_MAX_CHARS,
  TAG_MAX_COUNT,
  TEXT_FIELD_MAX_CHARS,
  metadataSchema,
} from '../http-limits.js';

export const MAX_MEMORY_TTL_SECONDS = 2_147_483_647;

const storeInputSchema = z.object({
  content: z.string().min(1).max(MEMORY_CONTENT_MAX_CHARS),
  namespace: z.string().min(1).max(TEXT_FIELD_MAX_CHARS).default('shared'),
  source: z.string().max(TEXT_FIELD_MAX_CHARS).optional(),
  tags: z.array(z.string().max(TAG_MAX_CHARS)).max(TAG_MAX_COUNT).default([]),
  metadata: metadataSchema.default({}),
  access_level: z.enum(['normal', 'sensitive', 'secret']).default('normal'),
  agent_name: z.string().max(TEXT_FIELD_MAX_CHARS).optional(),
  agent_type: z.string().max(TEXT_FIELD_MAX_CHARS).optional(),
  agent_model: z.string().max(TEXT_FIELD_MAX_CHARS).optional(),
  agent_runtime: z.string().max(TEXT_FIELD_MAX_CHARS).optional(),
  session_id: z.string().max(TEXT_FIELD_MAX_CHARS).optional(),
  idempotency_key: z.string().min(1).max(512).optional(),
  dedupe: z.boolean().optional(),
  ttl: z.number().int().min(1).max(MAX_MEMORY_TTL_SECONDS).optional(),
}).superRefine((value, ctx) => {
  if (value.ttl !== undefined && value.dedupe === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dedupe'],
      message: 'dedupe:true cannot be combined with ttl; expiring stores must remain distinct',
    });
  }
});

export const storeSchema = storeInputSchema.transform(value => ({
  ...value,
  // Expiring writes bypass semantic dedupe. Exact idempotency/source-key
  // identity remains available and has explicit expiry replacement semantics.
  dedupe: value.dedupe ?? value.ttl === undefined,
}));

export function parseMemoryDedupeThreshold(value: string | undefined): number {
  if (value === undefined) return 0.95;
  if (value.trim() === '') throw new Error('MEMORY_DEDUPE_THRESHOLD must be a number between 0 and 1');
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('MEMORY_DEDUPE_THRESHOLD must be a number between 0 and 1');
  }
  return threshold;
}

/** Validated once when the store runtime starts. */
export const MEMORY_DEDUPE_THRESHOLD = parseMemoryDedupeThreshold(process.env.MEMORY_DEDUPE_THRESHOLD);

export interface MemoryStoreRuntimeOptions {
  contradictionPolicy?: ContradictionPolicy;
  reviseBelief?: typeof maybeReviseBelief;
  /** Test/embedding hook; production uses the bounded process-wide scheduler. */
  scheduleShadow?: (task: () => Promise<void>) => void;
  contradictionMetric?: (reason: ContradictionReason) => void;
}

export async function memoryStore(
  params: z.infer<typeof storeSchema>,
  auth: AuthContext,
  runtime: MemoryStoreRuntimeOptions = {},
): Promise<StoreResult> {
  checkPermission(auth, 'write');
  if (params.ttl !== undefined && (
    !Number.isSafeInteger(params.ttl) || params.ttl < 1 || params.ttl > MAX_MEMORY_TTL_SECONDS
  )) {
    throw new Error(`ttl must be an integer between 1 and ${MAX_MEMORY_TTL_SECONDS} seconds`);
  }
  if (params.ttl !== undefined && params.dedupe === true) {
    throw new Error('dedupe:true cannot be combined with ttl');
  }

  const ns = params.namespace;
  const allowed = filterNamespaces([ns], auth.namespaces);
  if (allowed.length === 0) {
    throw new Error(`Access denied to namespace '${ns}'`);
  }
  ensureAccessLevelAllowed(params.access_level, auth.maxAccessLevel);

  const explicitAgent = !!params.agent_name;
  const agentName = params.agent_name || auth.name;
  const agentType = params.agent_type || (explicitAgent ? 'llm' : 'system');
  if (!explicitAgent) {
    console.warn(
      `[total-recall] memory_store called without agent_name; defaulting to api_key name "${auth.name}". ` +
      `Pass agent_name explicitly for accurate provenance.`
    );
  }
  const agentId = await resolveAgent(
    agentName,
    agentType,
    params.agent_model,
    params.agent_runtime,
    undefined,
    auth.keyId,
    dbScopeFromAuth(auth)
  );

  // EmbeddingResult atomically carries the ACTIVE_EMBEDDING_DESCRIPTOR identity.
  const embedding = await embedWithProfile(params.content);
  const vecStr = serializeEmbeddingVector(embedding.vector);
  const descriptor: [string, string, number] = [embedding.provider, embedding.model, embedding.dimensions];

  const source = params.source || auth.name;
  const values = [
    params.content,
    vecStr,
    source,
    ns,
    params.tags,
    JSON.stringify(params.metadata),
    params.access_level,
    auth.keyId,
    agentId,
    params.session_id ?? null,
    ...descriptor,
    params.ttl ?? null,
  ];

  const semanticMemory: SemanticMemoryInsert = {
    content: params.content,
    vector: vecStr,
    source,
    namespace: ns,
    tags: params.tags,
    metadata: params.metadata,
    accessLevel: params.access_level,
    clientId: auth.keyId,
    agentId,
    sessionId: params.session_id ?? null,
  };
  const reviseBelief = runtime.reviseBelief ?? maybeReviseBelief;
  // Retry-safe/idempotent writes are updates to an existing observation, not a
  // new belief event. They never query candidates or disclose text to #53.
  const contradictionPolicy = params.idempotency_key || params.ttl !== undefined
    ? undefined
    : (runtime.contradictionPolicy ?? contradictionPolicyFromEnv());

  if (contradictionPolicy?.mutationEnabled) {
    const revised = await reviseBelief(semanticMemory, auth, {
      policy: contradictionPolicy,
      allowMutation: true,
      metric: runtime.contradictionMetric,
    });
    if (revised) return { ...revised, created: true, deduplicated: false, expires_at: null };
  }

  const scheduleShadowAfterCommit = (storedId: string): void => {
    if (!contradictionPolicy || contradictionPolicy.mutationEnabled ||
        !policyAllowsScope(contradictionPolicy, ns, params.access_level)) return;
    const task = () => reviseBelief(semanticMemory, auth, {
      policy: contradictionPolicy,
      allowMutation: false,
      excludeCandidateId: storedId,
      metric: runtime.contradictionMetric,
    }).then(() => undefined);
    if (runtime.scheduleShadow) runtime.scheduleShadow(task);
    else scheduleShadowClassification(contradictionPolicy, task, runtime.contradictionMetric);
  };

  if (!params.idempotency_key) {
    const result = await withScopedClient(dbScopeFromAuth(auth), async (client): Promise<StoreResult> => {
      if (params.ttl === undefined && params.dedupe !== false) {
        // Serialize semantic identity decisions within the security boundary. The
        // embedding is deliberately computed before this short-lived lock.
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`memory-store-dedupe:${JSON.stringify([ns, params.access_level])}`],
        );

        const candidate = await client.query<{ id: string; namespace: string; similarity: number | string | null }>(
          `SELECT m.id, m.namespace,
                  1 - (m.embedding <=> $1::vector) AS similarity
           FROM memories m
           WHERE m.namespace = $2
             AND COALESCE(m.access_level, 'normal') = $3
             AND m.embedding IS NOT NULL
             AND m.embedding_provider = $4
             AND m.embedding_model = $5
             AND m.embedding_dimensions = $6
             AND m.source_key IS NULL
             AND m.document_id IS NULL
             AND m.deleted_at IS NULL
             AND m.expires_at IS NULL
             AND m.superseded_at IS NULL
             AND m.valid_to IS NULL
             AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp())
             AND m.consolidated_into_id IS NULL
             AND m.memory_kind NOT IN ('document_chunk', 'episode_chunk')
           ORDER BY m.embedding <=> $1::vector ASC,
                    calculate_relevance(m.relevance_base_score, m.decay_rate, m.accessed_at, m.access_count) DESC,
                    m.created_at ASC,
                    m.id ASC
           LIMIT 1
           FOR UPDATE`,
          [vecStr, ns, params.access_level, ...descriptor],
        );
        const match = candidate.rows[0];
        const similarity = match?.similarity == null ? Number.NaN : Number(match.similarity);
        if (match && Number.isFinite(similarity) && similarity >= MEMORY_DEDUPE_THRESHOLD) {
          const boosted = await client.query<{ id: string; namespace: string; expires_at: Date | null }>(
            `UPDATE memories
             SET access_count = COALESCE(access_count, 0) + 1,
                 accessed_at = statement_timestamp(),
                 last_boosted_at = statement_timestamp(),
                 tags = ARRAY(
                   SELECT value
                   FROM unnest(COALESCE(memories.tags, ARRAY[]::text[]) || $2::text[])
                     WITH ORDINALITY AS combined(value, position)
                   GROUP BY value
                   ORDER BY MIN(position)
                 ),
                 updated_at = statement_timestamp()
             WHERE id = $1::uuid
               AND deleted_at IS NULL
               AND (expires_at IS NULL OR expires_at > statement_timestamp())
               AND superseded_at IS NULL
               AND valid_to IS NULL
               AND consolidated_into_id IS NULL
             RETURNING id, namespace, expires_at`,
            [match.id, params.tags],
          );
          if (boosted.rows.length !== 1) {
            throw new Error('Dedupe candidate changed while the namespace lock was held');
          }
          return {
            ...boosted.rows[0],
            expires_at: boosted.rows[0].expires_at ?? null,
            created: false,
            deduplicated: true,
            similarity,
          };
        }
      }

      const inserted = await client.query<{ id: string; namespace: string; expires_at: Date | null }>(
        `INSERT INTO memories (content, embedding, source, namespace, tags, metadata, access_level, client_id, agent_id, session_id, embedding_provider, embedding_model, embedding_dimensions, memory_kind, valid_from, expires_at)
         VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'semantic', statement_timestamp(),
           CASE WHEN $14::bigint IS NULL THEN NULL ELSE statement_timestamp() + $14::double precision * interval '1 second' END)
         RETURNING id, namespace, expires_at`,
        values,
      );
      return { ...inserted.rows[0], expires_at: inserted.rows[0].expires_at ?? null, created: true, deduplicated: false };
    });
    if (result.created) scheduleShadowAfterCommit(result.id);
    return result;
  }

  const digest = createHash('sha256')
    .update(auth.keyId)
    .update('\0')
    .update(params.idempotency_key)
    .digest('hex');
  const sourceKey = `discord-safe:v1:${digest}`;
  type KeyedStoreSchema = 'consolidation' | 'belief' | 'supersession' | 'legacy';
  const executeKeyedStore = (schema: KeyedStoreSchema) => withScopedClient(dbScopeFromAuth(auth), async (client) => {
      const beliefAware = schema === 'consolidation' || schema === 'belief';
      const columns = beliefAware ? ', memory_kind, valid_from' : '';
      const insertedValues = beliefAware ? ", 'semantic', statement_timestamp()" : '';
      const kindUpdate = beliefAware ? '\n           memory_kind = EXCLUDED.memory_kind,' : '';
      const currentGuard = schema !== 'legacy' ? '\n           AND memories.superseded_at IS NULL' : '';
      const consolidationGuard = schema === 'consolidation' ? '\n           AND memories.consolidated_into_id IS NULL' : '';
      const upsert = await client.query(
        `INSERT INTO memories (content, embedding, source, namespace, tags, metadata, access_level, client_id, agent_id, session_id, embedding_provider, embedding_model, embedding_dimensions, source_key${columns}, expires_at)
         VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $15${insertedValues},
           CASE WHEN $14::bigint IS NULL THEN NULL ELSE statement_timestamp() + $14::double precision * interval '1 second' END)
         ON CONFLICT (source_key) DO UPDATE SET
           content = EXCLUDED.content,
           embedding = EXCLUDED.embedding,
           embedding_provider = EXCLUDED.embedding_provider,
           embedding_model = EXCLUDED.embedding_model,
           embedding_dimensions = EXCLUDED.embedding_dimensions,
           source = EXCLUDED.source,
           namespace = EXCLUDED.namespace,
           tags = EXCLUDED.tags,
           metadata = EXCLUDED.metadata,
           access_level = EXCLUDED.access_level,
           client_id = EXCLUDED.client_id,
           agent_id = EXCLUDED.agent_id,
           session_id = EXCLUDED.session_id,
           expires_at = EXCLUDED.expires_at,${kindUpdate}
           updated_at = NOW()
         WHERE memories.deleted_at IS NULL${currentGuard}${consolidationGuard}
           AND memories.namespace = ANY($16::text[])
           AND EXCLUDED.namespace = ANY($16::text[])
         RETURNING id, namespace, expires_at, (xmax = 0) AS created`,
        [...values, sourceKey, auth.namespaces]
      );
      if (upsert.rows.length > 0) return upsert;

      // A tombstone remains SELECT-visible under the caller's RLS scope. Resolve
      // the zero-row conflict before leaving this transaction/client so a hidden
      // row stays indistinguishable from any other inaccessible conflict.
      const tombstone = await client.query(
        `SELECT 1
         FROM memories
         WHERE source_key = $1
           AND deleted_at IS NOT NULL
         LIMIT 1`,
        [sourceKey]
      );
      if (tombstone.rows.length > 0) {
        throw new TombstonedSourceKeyConflictError();
      }
      if (schema !== 'legacy') {
        const superseded = await client.query(
          `SELECT 1 FROM memories
           WHERE source_key = $1 AND deleted_at IS NULL AND superseded_at IS NOT NULL
           LIMIT 1`,
          [sourceKey],
        );
        if (superseded.rows.length > 0) {
          throw new SupersededSourceKeyConflictError();
        }
      }
      throw new Error('Access denied to existing idempotent memory');
    });

  let res;
  try {
    try {
      res = await executeKeyedStore('consolidation');
    } catch (error) {
      if (isMissingColumn(error, 'memory_kind')) {
        // A pre-#53 database can report memory_kind before reaching the newer
        // consolidation column in the same statement.
        try { res = await executeKeyedStore('supersession'); }
        catch (supersessionError) {
          if (!isMissingColumn(supersessionError, 'superseded_at')) throw supersessionError;
          res = await executeKeyedStore('legacy');
        }
      } else {
        if (!isMissingColumn(error, 'consolidated_into_id')) throw error;
        try {
          res = await executeKeyedStore('belief');
        } catch (beliefError) {
          if (!isMissingColumn(beliefError, 'memory_kind')) throw beliefError;
          try {
            // #52 already has supersession lifecycle columns. Preserve its guard
            // while only omitting the not-yet-deployed #53 kind/validity columns.
            res = await executeKeyedStore('supersession');
          } catch (supersessionError) {
            if (!isMissingColumn(supersessionError, 'superseded_at')) throw supersessionError;
            res = await executeKeyedStore('legacy');
          }
        }
      }
    }
  } catch (error) {
    // Under RLS, a hidden source_key conflict can surface as 23505 because the
    // conflicting row is not visible to ON CONFLICT. Do not leak its existence.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new Error('Access denied to existing idempotent memory');
    }
    throw error;
  }
  const stored = res.rows[0] as { id: string; namespace: string; expires_at: Date | null; created?: boolean };
  return {
    id: stored.id,
    namespace: stored.namespace,
    created: stored.created ?? true,
    deduplicated: false,
    idempotency_key_honored: true,
    expires_at: stored.expires_at ?? null,
  };
}

function isMissingColumn(error: unknown, column: 'memory_kind' | 'superseded_at' | 'consolidated_into_id'): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === '42703' &&
    'message' in error && typeof error.message === 'string' && error.message.includes(column);
}
