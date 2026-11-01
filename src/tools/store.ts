import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dbScopeFromAuth, withScopedClient, type ScopedClient } from '../db.js';
import { embedWithProfile, serializeEmbeddingVector, type EmbeddingResult } from '../embedding.js';
import type { AccessLevel, AuthContext, StoreResult } from '../types.js';
import { checkPermission, ensureAccessLevelAllowed, filterNamespaces } from '../auth.js';
import { resolveAgent } from '../agents.js';
import { logAudit } from '../audit.js';
import { SupersededSourceKeyConflictError, TombstonedSourceKeyConflictError } from '../errors.js';
// Import cycle: ../ingestion.js imports the dedupe helpers from this module.
// Every ingestion export is used only inside function bodies, never at load.
import {
  acceptMemory,
  enqueueIngestionJob,
  ingestionQueueEnabled,
  inlineEmbedAndFinalize,
  type AcceptedMemory,
  type IngestionJobStatus,
  type InlineIngestionDeps,
  type InlineIngestionResult,
} from '../ingestion.js';
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

export interface DedupeCandidate {
  id: string;
  namespace: string;
  /** NaN when the database returned no usable similarity. */
  similarity: number;
}

export interface DedupeCandidateQuery {
  /** Serialized vector in the same space as `descriptor`. */
  vector: string;
  namespace: string;
  accessLevel: AccessLevel;
  descriptor: readonly [string, string, number];
  /**
   * A row that must never be its own canonical. The synchronous store never
   * sets this; deferred finalization excludes the accepted row it is landing.
   */
  excludeId?: string;
}

/**
 * Serialize semantic identity decisions within one namespace/access-level
 * security boundary. Callers compute the embedding before taking this lock.
 */
export async function lockDedupeNamespace(
  client: Pick<ScopedClient, 'query'>,
  namespace: string,
  accessLevel: AccessLevel,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`memory-store-dedupe:${JSON.stringify([namespace, accessLevel])}`],
  );
}

/** The candidate statement shared by the synchronous store and deferred finalization. */
export function dedupeCandidateSql(excludeSelf: boolean): string {
  return `SELECT m.id, m.namespace,
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
             AND m.memory_kind NOT IN ('document_chunk', 'episode_chunk')${excludeSelf ? `
             AND m.id <> $7::uuid` : ''}
           ORDER BY m.embedding <=> $1::vector ASC,
                    calculate_relevance(m.relevance_base_score, m.decay_rate, m.accessed_at, m.access_count) DESC,
                    m.created_at ASC,
                    m.id ASC
           LIMIT 1
           FOR UPDATE`;
}

/** Nearest eligible canonical candidate, locked for the rest of the transaction. */
export async function findDedupeCandidate(
  client: Pick<ScopedClient, 'query'>,
  query: DedupeCandidateQuery,
): Promise<DedupeCandidate | null> {
  const candidate = await client.query<{ id: string; namespace: string; similarity: number | string | null }>(
    dedupeCandidateSql(query.excludeId !== undefined),
    [
      query.vector, query.namespace, query.accessLevel, ...query.descriptor,
      ...(query.excludeId !== undefined ? [query.excludeId] : []),
    ],
  );
  const match = candidate.rows[0];
  if (!match) return null;
  return {
    id: match.id,
    namespace: match.namespace,
    similarity: match.similarity == null ? Number.NaN : Number(match.similarity),
  };
}

/** The boost statement shared by the synchronous store and deferred finalization. */
export const DEDUPE_BOOST_SQL = `UPDATE memories
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
             RETURNING id, namespace, expires_at`;

/**
 * Boost the canonical row exactly as a synchronous dedupe hit does: only safe
 * mutable fields change. Null means the candidate changed under the lock.
 */
export async function boostDedupeCanonical(
  client: Pick<ScopedClient, 'query'>,
  canonicalId: string,
  tags: string[],
): Promise<{ id: string; namespace: string; expires_at: Date | null } | null> {
  const boosted = await client.query<{ id: string; namespace: string; expires_at: Date | null }>(
    DEDUPE_BOOST_SQL,
    [canonicalId, tags],
  );
  return boosted.rows.length === 1 ? boosted.rows[0] : null;
}

export interface MemoryStoreRuntimeOptions {
  contradictionPolicy?: ContradictionPolicy;
  reviseBelief?: typeof maybeReviseBelief;
  /** Test/embedding hook; production uses the bounded process-wide scheduler. */
  scheduleShadow?: (task: () => Promise<void>) => void;
  contradictionMetric?: (reason: ContradictionReason) => void;
  /**
   * Test/embedding hook for the queued path's inline fast path; production
   * embeds with the active profile inside the MEMORY_STORE_INLINE_EMBED_MS
   * budget. The synchronous (gate-off) path never consults it.
   */
  embed?: (content: string, signal: AbortSignal) => Promise<EmbeddingResult>;
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

  // Durable write-ahead acceptance (#157) replaces everything from here on
  // when the fail-closed gate is set; off, the synchronous path is untouched.
  if (ingestionQueueEnabled()) {
    return queuedMemoryStore(params, auth, runtime, { ns, agentId });
  }

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
        await lockDedupeNamespace(client, ns, params.access_level);

        const match = await findDedupeCandidate(client, {
          vector: vecStr, namespace: ns, accessLevel: params.access_level, descriptor,
        });
        const similarity = match?.similarity ?? Number.NaN;
        if (match && Number.isFinite(similarity) && similarity >= MEMORY_DEDUPE_THRESHOLD) {
          const boosted = await boostDedupeCanonical(client, match.id, params.tags);
          if (!boosted) {
            throw new Error('Dedupe candidate changed while the namespace lock was held');
          }
          const result: StoreResult = {
            ...boosted,
            expires_at: boosted.expires_at ?? null,
            created: false,
            deduplicated: true,
            similarity,
          };
          await logAudit({
            clientId: auth.keyId, action: 'memory.store', namespace: ns,
            memoryId: result.id, resourceType: 'memory', resourceId: result.id,
            agentId, sessionId: params.session_id,
            details: { created: false, deduplicated: true },
          }, dbScopeFromAuth(auth), client);
          return result;
        }
      }

      const inserted = await client.query<{ id: string; namespace: string; expires_at: Date | null }>(
        `INSERT INTO memories (content, embedding, source, namespace, tags, metadata, access_level, client_id, agent_id, session_id, embedding_provider, embedding_model, embedding_dimensions, memory_kind, valid_from, expires_at)
         VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'semantic', statement_timestamp(),
           CASE WHEN $14::bigint IS NULL THEN NULL ELSE statement_timestamp() + $14::double precision * interval '1 second' END)
         RETURNING id, namespace, expires_at`,
        values,
      );
      const result: StoreResult = {
        ...inserted.rows[0], expires_at: inserted.rows[0].expires_at ?? null,
        created: true, deduplicated: false,
      };
      await logAudit({
        clientId: auth.keyId, action: 'memory.store', namespace: ns,
        memoryId: result.id, resourceType: 'memory', resourceId: result.id,
        agentId, sessionId: params.session_id,
        details: { created: true, deduplicated: false },
      }, dbScopeFromAuth(auth), client);
      return result;
    });
    if (result.created) scheduleShadowAfterCommit(result.id);
    return result;
  }

  const sourceKey = keyedSourceKey(auth.keyId, params.idempotency_key);
  const executeKeyedStore = (schema: KeyedStoreSchema) => withScopedClient(dbScopeFromAuth(auth), async (client) => {
      const upsert = await client.query(keyedUpsertSql(schema, false), [...values, sourceKey, auth.namespaces]);
      if (upsert.rows.length > 0) {
        const stored = upsert.rows[0] as { id: string; created?: boolean };
        await logAudit({
          clientId: auth.keyId, action: 'memory.store', namespace: ns,
          memoryId: stored.id, resourceType: 'memory', resourceId: stored.id,
          agentId, sessionId: params.session_id,
          details: { created: stored.created ?? false, deduplicated: false, idempotent: true },
        }, dbScopeFromAuth(auth), client);
        return upsert;
      }
      return throwKeyedConflict(client, schema, sourceKey, auth.keyId);
    });

  const res = await runKeyedSchemaLadder(executeKeyedStore);
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

/** Keyed-store source identity: the same digest whether or not the queue is on. */
export function keyedSourceKey(keyId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(keyId)
    .update('\0')
    .update(idempotencyKey)
    .digest('hex');
  return `discord-safe:v1:${digest}`;
}

type KeyedStoreSchema = 'consolidation' | 'belief' | 'supersession' | 'legacy';

/**
 * The keyed upsert with its schema-fallback variants. The synchronous store
 * writes the vector it already computed; queued acceptance writes no vector,
 * keeps a landed embedding and identity when the content is identical, and
 * clears them when the content changed so the row leaves semantic ranking
 * until its re-embed lands (migration 023's all-or-none identity CHECK).
 */
function keyedUpsertSql(schema: KeyedStoreSchema, queued: boolean): string {
  const beliefAware = schema === 'consolidation' || schema === 'belief';
  const columns = beliefAware ? ', memory_kind, valid_from' : '';
  const insertedValues = beliefAware ? ", 'semantic', statement_timestamp()" : '';
  const kindUpdate = beliefAware ? '\n           memory_kind = EXCLUDED.memory_kind,' : '';
  const currentGuard = schema !== 'legacy' ? '\n           AND memories.superseded_at IS NULL' : '';
  const consolidationGuard = schema === 'consolidation' ? '\n           AND memories.consolidated_into_id IS NULL' : '';
  const embeddingUpdate = queued
    ? `embedding = CASE WHEN memories.content = EXCLUDED.content THEN memories.embedding ELSE NULL END,
           embedding_provider = CASE WHEN memories.content = EXCLUDED.content THEN memories.embedding_provider ELSE NULL END,
           embedding_model = CASE WHEN memories.content = EXCLUDED.content THEN memories.embedding_model ELSE NULL END,
           embedding_dimensions = CASE WHEN memories.content = EXCLUDED.content THEN memories.embedding_dimensions ELSE NULL END,`
    : `embedding = EXCLUDED.embedding,
           embedding_provider = EXCLUDED.embedding_provider,
           embedding_model = EXCLUDED.embedding_model,
           embedding_dimensions = EXCLUDED.embedding_dimensions,`;
  const returning = queued ? ', created_at, embedding IS NULL AS unembedded' : '';
  return `INSERT INTO memories (content, embedding, source, namespace, tags, metadata, access_level, client_id, agent_id, session_id, embedding_provider, embedding_model, embedding_dimensions, source_key${columns}, expires_at)
         VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $15${insertedValues},
           CASE WHEN $14::bigint IS NULL THEN NULL ELSE statement_timestamp() + $14::double precision * interval '1 second' END)
         ON CONFLICT (client_id, source_key) DO UPDATE SET
           content = EXCLUDED.content,
           ${embeddingUpdate}
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
         RETURNING id, namespace, expires_at, (xmax = 0) AS created${returning}`;
}

/**
 * A zero-row keyed upsert is always a conflict. A tombstone remains
 * SELECT-visible under the caller's RLS scope, so resolve it before leaving
 * this transaction/client; a hidden row stays indistinguishable from any
 * other inaccessible conflict.
 */
async function throwKeyedConflict(
  client: ScopedClient,
  schema: KeyedStoreSchema,
  sourceKey: string,
  keyId: string,
): Promise<never> {
  const tombstone = await client.query(
    `SELECT 1
     FROM memories
     WHERE source_key = $1
       AND client_id = $2
       AND deleted_at IS NOT NULL
     LIMIT 1`,
    [sourceKey, keyId]
  );
  if (tombstone.rows.length > 0) {
    throw new TombstonedSourceKeyConflictError();
  }
  if (schema !== 'legacy') {
    const superseded = await client.query(
      `SELECT 1 FROM memories
       WHERE source_key = $1 AND client_id = $2 AND deleted_at IS NULL AND superseded_at IS NOT NULL
       LIMIT 1`,
      [sourceKey, keyId],
    );
    if (superseded.rows.length > 0) {
      throw new SupersededSourceKeyConflictError();
    }
  }
  throw new Error('Access denied to existing idempotent memory');
}

/** Run the keyed upsert against the newest schema first, falling back per missing column. */
async function runKeyedSchemaLadder<T>(execute: (schema: KeyedStoreSchema) => Promise<T>): Promise<T> {
  try {
    try {
      return await execute('consolidation');
    } catch (error) {
      if (isMissingColumn(error, 'memory_kind')) {
        // A pre-#53 database can report memory_kind before reaching the newer
        // consolidation column in the same statement.
        try { return await execute('supersession'); }
        catch (supersessionError) {
          if (!isMissingColumn(supersessionError, 'superseded_at')) throw supersessionError;
          return await execute('legacy');
        }
      }
      if (!isMissingColumn(error, 'consolidated_into_id')) throw error;
      try {
        return await execute('belief');
      } catch (beliefError) {
        if (!isMissingColumn(beliefError, 'memory_kind')) throw beliefError;
        try {
          // #52 already has supersession lifecycle columns. Preserve its guard
          // while only omitting the not-yet-deployed #53 kind/validity columns.
          return await execute('supersession');
        } catch (supersessionError) {
          if (!isMissingColumn(supersessionError, 'superseded_at')) throw supersessionError;
          return await execute('legacy');
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
}

// ---------------------------------------------------------------------------
// Durable write-ahead acceptance (#157): persist, commit, then embed inline
// ---------------------------------------------------------------------------

interface QueuedStoreContext {
  ns: string;
  agentId: string;
}

/** What the keyed upsert returns on the queued path. */
interface QueuedKeyedRow {
  id: string;
  namespace: string;
  expires_at: Date | null;
  created: boolean;
  created_at: Date;
  unembedded: boolean;
}

/** The keyed row and job as they were before the upsert ran. */
interface KeyedPrior {
  row: { id: string; namespace: string; same_content: boolean; embedded: boolean; created_at: Date };
  job: { status: IngestionJobStatus; attempts: number; accepted_at: Date } | null;
}

type KeyedIngestionDecision =
  /** A fresh pending job (attempts 0, new accepted_at) and an inline attempt. */
  | { action: 'enqueue' }
  /** The job is left exactly as it is; the caller gets the current state. */
  | { action: 'keep'; state: 'ready' | 'queued' };

/**
 * Idempotency key reuse across job states. Identical content on a landed row
 * keeps the vector and reports ready; identical content on an in-flight job
 * is a no-op that reports queued; replaced content, a failed or cancelled
 * job, and an unembedded row without a job all re-queue. An unknown prior
 * (a conflict the pre-read could not see) also re-queues: the reset clears
 * the lease, so a finalizer still holding the old token becomes a no-op.
 */
function decideKeyedIngestion(stored: Pick<QueuedKeyedRow, 'created' | 'unembedded'>, prior: KeyedPrior | null): KeyedIngestionDecision {
  if (stored.created) return { action: 'enqueue' };
  if (!stored.unembedded) return { action: 'keep', state: 'ready' };
  if (!prior || !prior.row.same_content) return { action: 'enqueue' };
  const status = prior.job?.status;
  if (status === 'pending' || status === 'retry_wait' || status === 'processing') {
    return { action: 'keep', state: 'queued' };
  }
  return { action: 'enqueue' };
}

/**
 * Read the keyed row the upsert will hit and lock its job row first: the
 * same job-then-memory order finalize takes, so a worker landing this very
 * memory cannot deadlock a keyed retry. Null means no live row for the key.
 */
async function inspectKeyedRow(
  client: ScopedClient,
  keyId: string,
  sourceKey: string,
  content: string,
): Promise<KeyedPrior | null> {
  const existing = await client.query<KeyedPrior['row']>(
    `SELECT m.id, m.namespace, m.content = $3 AS same_content, m.embedding IS NOT NULL AS embedded, m.created_at
     FROM memories m
     WHERE m.client_id = $1 AND m.source_key = $2 AND m.deleted_at IS NULL`,
    [keyId, sourceKey, content],
  );
  const row = existing.rows[0];
  if (!row) return null;
  const job = await client.query<NonNullable<KeyedPrior['job']>>(
    `SELECT j.status, j.attempts, j.accepted_at
     FROM memory_ingestion_jobs j
     WHERE j.memory_id = $1::uuid AND j.namespace = $2
     FOR UPDATE`,
    [row.id, row.namespace],
  );
  const locked = job.rows[0];
  return {
    row: { ...row, same_content: row.same_content === true, embedded: row.embedded === true },
    job: locked ? { status: locked.status, attempts: Number(locked.attempts), accepted_at: locked.accepted_at } : null,
  };
}

/**
 * Gate-on store: validation, ACL and agent resolution already ran. One
 * scoped transaction durably accepts the row (NULL embedding) and its job,
 * commits, and only then does the bounded inline fast path try to embed.
 * Postgres failures before the commit propagate exactly as today, so
 * nothing is ever acknowledged before it is persisted.
 */
async function queuedMemoryStore(
  params: z.infer<typeof storeSchema>,
  auth: AuthContext,
  runtime: MemoryStoreRuntimeOptions,
  { ns, agentId }: QueuedStoreContext,
): Promise<StoreResult> {
  const scope = dbScopeFromAuth(auth);
  const source = params.source || auth.name;
  const sessionId = params.session_id ?? null;
  const ttlSeconds = params.ttl ?? null;
  const inlineDeps: InlineIngestionDeps = {
    embed: runtime.embed,
    finalize: {
      contradictionPolicy: runtime.contradictionPolicy,
      reviseBelief: runtime.reviseBelief,
      contradictionMetric: runtime.contradictionMetric,
    },
    scheduleShadow: runtime.scheduleShadow,
  };

  if (!params.idempotency_key) {
    // Plain insert: no dedupe lock at acceptance, dedupe runs at finalization.
    const accepted = await withScopedClient(scope, client => acceptMemory(client, {
      content: params.content,
      source,
      namespace: ns,
      tags: params.tags,
      metadata: params.metadata,
      accessLevel: params.access_level,
      clientId: auth.keyId,
      allowedNamespaces: auth.namespaces,
      agentId,
      sessionId,
      ttlSeconds,
      dedupe: params.ttl === undefined && params.dedupe !== false,
      // Retry-safe/idempotent and expiring writes are never new belief events.
      contradictionEligible: params.ttl === undefined,
    }));
    const inline = await inlineEmbedAndFinalize(accepted.id, scope, inlineDeps);
    return queuedStoreResult(inline, accepted, { created: true, keyed: false });
  }

  const sourceKey = keyedSourceKey(auth.keyId, params.idempotency_key);
  const values = [
    params.content, null, source, ns, params.tags, JSON.stringify(params.metadata), params.access_level,
    auth.keyId, agentId, sessionId, null, null, null, ttlSeconds,
  ];
  const executeKeyedStore = (schema: KeyedStoreSchema) => withScopedClient(scope, async (client) => {
    const prior = await inspectKeyedRow(client, auth.keyId, sourceKey, params.content);
    const upsert = await client.query<QueuedKeyedRow>(keyedUpsertSql(schema, true), [...values, sourceKey, auth.namespaces]);
    const stored = upsert.rows[0];
    if (!stored) return throwKeyedConflict(client, schema, sourceKey, auth.keyId);
    const created = stored.created === true;
    const decision = decideKeyedIngestion({ created, unembedded: stored.unembedded === true }, prior);
    let acceptedAt: Date;
    if (decision.action === 'enqueue') {
      // Keyed stores bypass semantic dedupe and never open a belief event.
      const job = await enqueueIngestionJob(client, {
        memoryId: stored.id,
        namespace: stored.namespace,
        kind: 'store',
        clientId: auth.keyId,
        accessLevel: params.access_level,
        allowedNamespaces: auth.namespaces,
        agentId,
        sessionId,
        sourceKey,
        dedupe: false,
        ttlSeconds,
        contradictionEligible: false,
      });
      acceptedAt = job.accepted_at;
    } else {
      acceptedAt = prior?.job?.accepted_at ?? stored.created_at;
    }
    await logAudit({
      clientId: auth.keyId, action: 'memory.store', namespace: ns,
      memoryId: stored.id, resourceType: 'memory', resourceId: stored.id,
      agentId, sessionId: params.session_id,
      details: {
        created, deduplicated: false, idempotent: true,
        ...(decision.action === 'enqueue' && { queued: true }),
      },
    }, scope, client);
    return {
      accepted: { id: stored.id, namespace: stored.namespace, expires_at: stored.expires_at ?? null, accepted_at: acceptedAt },
      created,
      decision,
    };
  });

  const { accepted, created, decision } = await runKeyedSchemaLadder(executeKeyedStore);
  if (decision.action === 'keep') {
    return {
      id: accepted.id,
      namespace: accepted.namespace,
      created,
      deduplicated: false,
      idempotency_key_honored: true,
      expires_at: accepted.expires_at,
      state: decision.state,
      accepted_at: accepted.accepted_at,
    };
  }
  const inline = await inlineEmbedAndFinalize(accepted.id, scope, inlineDeps);
  return queuedStoreResult(inline, accepted, { created, keyed: true });
}

/**
 * Today's result shape plus state/accepted_at. A ready inline outcome carries
 * the same created/deduplicated/similarity the synchronous path produces;
 * anything else is the durably accepted row, queued for the worker.
 */
function queuedStoreResult(
  inline: InlineIngestionResult,
  accepted: AcceptedMemory,
  origin: { created: boolean; keyed: boolean },
): StoreResult {
  const honored = origin.keyed ? { idempotency_key_honored: true as const } : {};
  if (inline.state === 'ready') {
    const landed = inline.result;
    if (landed.outcome === 'deduplicated') {
      return {
        id: landed.id,
        namespace: landed.namespace,
        expires_at: landed.expires_at,
        created: false,
        deduplicated: true,
        similarity: landed.similarity,
        state: 'ready',
        accepted_at: accepted.accepted_at,
      };
    }
    return {
      id: landed.id,
      namespace: landed.namespace,
      expires_at: landed.expires_at,
      created: origin.created,
      deduplicated: false,
      ...honored,
      state: 'ready',
      accepted_at: accepted.accepted_at,
    };
  }
  return {
    id: accepted.id,
    namespace: accepted.namespace,
    expires_at: accepted.expires_at,
    created: origin.created,
    deduplicated: false,
    ...honored,
    state: 'queued',
    accepted_at: accepted.accepted_at,
  };
}

function isMissingColumn(error: unknown, column: 'memory_kind' | 'superseded_at' | 'consolidated_into_id'): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === '42703' &&
    'message' in error && typeof error.message === 'string' && error.message.includes(column);
}
