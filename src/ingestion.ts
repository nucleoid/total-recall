import { prepareLocalDocument, publishPreparedLocalDocument, findLocalDocumentDuplicate, type PreparedLocalDocument } from './local-embedding-consumers.js';
import { localServingEnabled } from './local-embedding-runtime.js';
import { isDeepStrictEqual } from 'node:util';
import { MEMORY_DEDUPE_THRESHOLD } from './store-config.js';
import { createHash, randomUUID } from 'node:crypto';
import { accessLevelSql, checkPermission, ensureAccessLevelAllowed, filterNamespaces } from './auth.js';
import { logAudit } from './audit.js';
import { dbScopeFromAuth, withScopedClient, withCheckedOutClient, withScopedTransactionOnClient, type DbScope, type ScopedClient } from './db.js';
import { ACTIVE_EMBEDDING_PROFILE, embedWithProfile, embedBatchWithProfile, embeddingIdentity, serializeEmbeddingVector, validateEmbeddingBatch,
  EmbeddingProviderError, EmbeddingValidationError, type EmbeddingResult } from './embedding.js';
import { TombstonedSourceKeyConflictError, SupersededSourceKeyConflictError, MemoryConflictError } from './errors.js';
import { contradictionPolicyFromEnv, maybeReviseBelief, prepareBeliefRevision, commitAutomaticRevision, policyAllowsScope, scheduleShadowClassification,
  type SemanticMemoryInsert, type ContradictionPolicy } from './contradictions.js';
import { retryAtForAttempt } from './retry.js';
import type { AccessLevel, AuthContext, StoreResult, DocumentStatus } from './types.js';

export class IngestionPersistenceError extends Error {
  readonly statusCode = 503;
  readonly code = 'ingestion_persistence_unavailable';
  constructor(cause: unknown) { super('Durable memory acceptance unavailable', { cause }); }
}

export interface IngestionEmbeddingResult extends EmbeddingResult { localPrepared?: PreparedLocalDocument }

export type IngestionState = 'pending' | 'processing' | 'retry_wait' | 'ready' | 'deduplicated' | 'embedding_failed' | 'cancelled';
export type FailureCategory = 'transient' | 'rate_limited' | 'provider_auth' | 'input_rejected' | 'space_mismatch' | 'expired';
function storeState(status: IngestionState): NonNullable<StoreResult['state']> {
  if (status === 'embedding_failed' || status === 'cancelled') return status;
  return status === 'ready' || status === 'deduplicated' ? 'ready' : 'queued';
}
function requireMemoryUpdate(result: { rowCount: number | null }): void {
  if (result.rowCount !== 1) throw new Error('Ingestion memory update did not affect exactly one row');
}
export interface IngestionJob {
  memory_id: string; namespace: string; client_id: string; access_level: AccessLevel;
  allowed_namespaces: string[]; agent_id: string; session_id: string | null; source_key: string | null;
  memory_created: boolean; dedupe: boolean; ttl_seconds: string | null; contradiction_eligible: boolean;
  embedding_provider: string; embedding_model: string; embedding_dimensions: number;
  status: IngestionState; attempts: number; last_error_code: string | null; lease_token: string; accepted_at: Date;
  content: string; expires_at: Date | null; inline?: boolean;
  kind?: 'store' | 'update' | 'document'; source_revision?: number;
  document_id?: string | null; chunk_index?: number | null;
}
export interface AcceptMemoryInput {
  content: string; namespace: string; source?: string; tags: string[]; metadata: Record<string, unknown>;
  access_level: AccessLevel; session_id?: string; idempotency_key?: string; dedupe?: boolean; ttl?: number;
}
export function ingestionEnabled(): boolean { return process.env.MEMORY_INGESTION_QUEUE_ENABLED === 'true'; }
export function ingestionUpdateEnabled(): boolean {
  return ingestionEnabled() && process.env.MEMORY_INGESTION_UPDATE_ENABLED === 'true';
}
export function ingestionDocumentEnabled(): boolean {
  return ingestionEnabled() && process.env.MEMORY_INGESTION_DOCUMENT_ENABLED === 'true';
}
export function ingestionSessionEnabled(): boolean {
  return ingestionEnabled() && process.env.MEMORY_INGESTION_SESSION_ENABLED === 'true';
}
export function documentInlineMaxChunks(): number {
  return ingestionInteger(process.env.MEMORY_STORE_DOCUMENT_INLINE_MAX_CHUNKS, 8, 'MEMORY_STORE_DOCUMENT_INLINE_MAX_CHUNKS', 0, 64);
}

/** Called inside the document acceptance transaction, after its chunk rows exist. */
export async function acceptChunks(client: ScopedClient, documentId: string, auth: AuthContext): Promise<void> {
  const profile = ACTIVE_EMBEDDING_PROFILE;
  await client.query(`INSERT INTO memory_ingestion_jobs
    (memory_id,namespace,client_id,access_level,allowed_namespaces,dedupe,contradiction_eligible,
     embedding_provider,embedding_model,embedding_dimensions,kind,source_revision,document_id,chunk_index)
    SELECT id,namespace,client_id,COALESCE(access_level,'normal'),$3,false,false,$4,$5,$6,'document',revision,document_id,chunk_index
    FROM memories WHERE document_id=$1 AND client_id=$2 AND embedding IS NULL`,
  [documentId,auth.keyId,auth.namespaces,profile.provider,profile.model,profile.dimensions]);
}

/** Legacy synchronous chunks have no job and are already ready. State is never stored. */
export async function documentIngestionState(client: ScopedClient, documentId: string): Promise<DocumentStatus> {
  const counts = (await client.query(`WITH chunks AS MATERIALIZED (
      SELECT CASE WHEN m.deleted_at IS NOT NULL OR j.status='cancelled' THEN 'cancelled'
        WHEN j.status='embedding_failed' THEN 'failed'
        WHEN j.status IN ('ready','deduplicated') OR (j.status IS NULL AND m.embedding IS NOT NULL) THEN 'ready'
        ELSE 'queued' END AS state, j.accepted_at, j.failure_category
      FROM memories m LEFT JOIN memory_ingestion_jobs j ON j.memory_id=m.id WHERE m.document_id=$1
    ) SELECT COUNT(*)::int AS chunk_count, COUNT(*) FILTER (WHERE state='ready')::int AS ready,
      COUNT(*) FILTER (WHERE state='queued')::int AS queued, COUNT(*) FILTER (WHERE state='failed')::int AS failed,
      COUNT(*) FILTER (WHERE state='cancelled')::int AS cancelled,
      EXTRACT(EPOCH FROM statement_timestamp()-MIN(accepted_at) FILTER (WHERE state='queued'))::double precision AS oldest_pending_age_seconds,
      COALESCE((SELECT jsonb_object_agg(failure_category,count) FROM (
        SELECT failure_category,COUNT(*)::int AS count FROM chunks WHERE failure_category IS NOT NULL GROUP BY failure_category
      ) categories),'{}'::jsonb) AS failure_categories FROM chunks`, [documentId])).rows[0];
  return { document_id:documentId,...counts,state:counts.ready===counts.chunk_count ? 'ready' : !counts.queued && counts.failed ? 'embedding_failed' : 'queued' };
}

export interface SessionEmbeddingSummary {
  state: DocumentStatus['state']; ready: number; queued: number; failed: number;
}

export async function factIngestionState(client: ScopedClient, runId: string): Promise<SessionEmbeddingSummary> {
  const counts = (await client.query(`WITH facts AS (
    SELECT CASE WHEN m.deleted_at IS NOT NULL OR j.status='cancelled' THEN 'cancelled'
      WHEN j.status='embedding_failed' THEN 'failed'
      WHEN j.status IN ('ready','deduplicated') OR (j.status IS NULL AND m.embedding IS NOT NULL) THEN 'ready'
      ELSE 'queued' END AS state
    FROM memory_session_derivations d JOIN memories m ON m.id=d.memory_id
    LEFT JOIN memory_ingestion_jobs j ON j.memory_id=m.id WHERE d.run_id=$1
  ) SELECT count(*)::int AS total, count(*) FILTER (WHERE state='ready')::int AS ready,
    count(*) FILTER (WHERE state='queued')::int AS queued, count(*) FILTER (WHERE state='failed')::int AS failed
    FROM facts`, [runId])).rows[0];
  return { state: counts.ready===counts.total ? 'ready' : !counts.queued && counts.failed ? 'embedding_failed' : 'queued',
    ready:counts.ready, queued:counts.queued, failed:counts.failed };
}

/** The caller's transaction owns the fact and derivation before creating its job. */
export async function acceptSessionFact(client: ScopedClient, memoryId: string, namespace: string): Promise<void> {
  const profile=ACTIVE_EMBEDDING_PROFILE;
  await client.query(`INSERT INTO memory_ingestion_jobs
    (memory_id,namespace,client_id,access_level,allowed_namespaces,agent_id,session_id,source_key,
     dedupe,contradiction_eligible,embedding_provider,embedding_model,embedding_dimensions,kind,source_revision)
    SELECT id,namespace,client_id,COALESCE(access_level,'normal'),ARRAY[namespace],agent_id,session_id,source_key,
      false,false,$3,$4,$5,'store',revision FROM memories
    WHERE id=$1 AND namespace=$2 AND embedding IS NULL
    ON CONFLICT (memory_id) DO NOTHING`, [memoryId,namespace,profile.provider,profile.model,profile.dimensions]);
}

/** Called under the patch transaction after locking jobs before memories. */
export async function enqueueReembed(client: ScopedClient, memoryId: string): Promise<Date> {
  const profile = ACTIVE_EMBEDDING_PROFILE;
  const result = await client.query('SELECT app_enqueue_memory_reembed($1::uuid, $2, $3, $4) AS accepted_at',
    [memoryId, profile.provider, profile.model, profile.dimensions]);
  return result.rows[0].accepted_at;
}
export function ingestionInteger(raw: string | undefined, fallback: number, name: string, min = 0, max = 120_000): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (raw?.trim() === '' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
export function inlineBudgetMs(): number {
  return ingestionInteger(process.env.MEMORY_STORE_INLINE_EMBED_MS, 3000, 'MEMORY_STORE_INLINE_EMBED_MS');
}
export function ingestionMaxAttempts(): number {
  return ingestionInteger(process.env.MEMORY_INGESTION_MAX_ATTEMPTS, 12, 'MEMORY_INGESTION_MAX_ATTEMPTS', 1, 1000);
}
export function workerIngestionLeaseMs(policy = contradictionPolicyFromEnv()): number {
  const embeddingMs = ingestionInteger(process.env.EMBEDDING_TIMEOUT_MS, 15000, 'EMBEDDING_TIMEOUT_MS', 100, 120000);
  return Math.max(150000, embeddingMs + (policy.mutationEnabled ? policy.timeoutMs : 0) + 30000);
}
function ownerScope(job: IngestionJob): DbScope { return { namespaces: [job.namespace], keyId: job.client_id }; }
function ownerAuth(job: IngestionJob): AuthContext {
  return { keyId: job.client_id, name: 'ingestion', namespaces: [job.namespace], permissions: ['read','write'], maxAccessLevel: job.access_level };
}

/** Finishing the accepted row survives revocation; effects on other rows do not. */
async function currentMutationAuthority(client: ScopedClient, job: IngestionJob, lock = false): Promise<boolean> {
  const result = await client.query(`SELECT k.id FROM api_keys k
    WHERE k.id::text = app_current_key_id() AND k.enabled = true AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at > statement_timestamp())
      AND 'write' = ANY(k.permissions) AND $1 = ANY(k.namespaces)
      AND ${accessLevelSql('$2::text', 'k.max_access_level')}${lock ? ' FOR NO KEY UPDATE' : ''}`,
  [job.namespace, job.access_level]);
  return result.rows.length === 1;
}

/** The only acknowledgement boundary: memory, job and acceptance audit commit together. */
export async function acceptMemory(input: AcceptMemoryInput, auth: AuthContext, agentId: string): Promise<StoreResult> {
  checkPermission(auth, 'write');
  if (!filterNamespaces([input.namespace], auth.namespaces).length) throw new Error('Access denied to namespace');
  ensureAccessLevelAllowed(input.access_level, auth.maxAccessLevel);
  const sourceKey = input.idempotency_key ? `discord-safe:v1:${createHash('sha256').update(auth.keyId).update('\0').update(input.idempotency_key).digest('hex')}` : null;
  try {
    return await withScopedClient(dbScopeFromAuth(auth), async client => {
      let previous: { content: string; namespace: string; access_level: string; source: string; tags: string[]; metadata: Record<string, unknown>; agent_id: string; session_id: string | null; expires_at: Date | null; memory_kind: string } | undefined;
      if (sourceKey) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`memory-store-key:${auth.keyId}:${sourceKey}`]);
        // Match finalize's job -> memory lock order, including namespace moves.
        await client.query(`SELECT j.memory_id FROM memory_ingestion_jobs j WHERE j.client_id = $1 AND j.source_key = $2 FOR UPDATE`, [auth.keyId, sourceKey]);
        previous = (await client.query(`SELECT content, namespace, access_level, source, tags, metadata, agent_id, session_id, expires_at, memory_kind FROM memories WHERE client_id = $1 AND source_key = $2 FOR UPDATE`, [auth.keyId, sourceKey])).rows[0];
      }
      const changed = !previous || previous.content !== input.content || previous.namespace !== input.namespace || previous.access_level !== input.access_level;
      const auditChanged = changed || !previous || previous.source !== (input.source || auth.name) ||
        !isDeepStrictEqual(previous.tags, input.tags) || !isDeepStrictEqual(previous.metadata, input.metadata) ||
        previous.agent_id !== agentId || previous.session_id !== (input.session_id ?? null) ||
        input.ttl !== undefined || previous.expires_at !== null || previous.memory_kind !== 'semantic';
      const conflict = sourceKey ? `ON CONFLICT (client_id, source_key) DO UPDATE SET
        content = EXCLUDED.content,
        embedding = CASE WHEN $13 THEN NULL ELSE memories.embedding END,
        embedding_provider = CASE WHEN $13 THEN NULL ELSE memories.embedding_provider END,
        embedding_model = CASE WHEN $13 THEN NULL ELSE memories.embedding_model END,
        embedding_dimensions = CASE WHEN $13 THEN NULL ELSE memories.embedding_dimensions END,
        source = EXCLUDED.source, namespace = EXCLUDED.namespace, tags = EXCLUDED.tags,
        metadata = EXCLUDED.metadata, access_level = EXCLUDED.access_level, agent_id = EXCLUDED.agent_id,
        session_id = EXCLUDED.session_id, expires_at = EXCLUDED.expires_at, memory_kind = EXCLUDED.memory_kind, updated_at = statement_timestamp()
        WHERE memories.deleted_at IS NULL AND memories.superseded_at IS NULL AND memories.consolidated_into_id IS NULL
        AND memories.namespace = ANY($14::text[]) AND EXCLUDED.namespace = ANY($14::text[])` : '';
      const values: unknown[] = [input.content, input.source || auth.name, input.namespace, input.tags,
        JSON.stringify(input.metadata), input.access_level, auth.keyId, agentId, input.session_id ?? null,
        sourceKey, input.ttl ?? null, null];
      // Keep bind arity exact on the plain INSERT.
      if (sourceKey) values.push(changed, auth.namespaces);
      const memory = (await client.query(`INSERT INTO memories
        (content, source, namespace, tags, metadata, access_level, client_id, agent_id, session_id,
         source_key, expires_at, embedding, memory_kind, valid_from, created_at, updated_at, accessed_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,
          CASE WHEN $11::bigint IS NULL THEN NULL ELSE statement_timestamp() + $11::double precision * interval '1 second' END,
          $12::vector, 'semantic', statement_timestamp(), statement_timestamp(), statement_timestamp(), statement_timestamp()) ${conflict}
        RETURNING id, namespace, expires_at, statement_timestamp() AS accepted_at, embedding IS NOT NULL AS embedded, (xmax = 0) AS created`, values)).rows[0];
      if (!memory) {
        const existing = (await client.query(`SELECT deleted_at, superseded_at FROM memories WHERE client_id = $1 AND source_key = $2`, [auth.keyId, sourceKey])).rows[0];
        if (existing?.deleted_at) throw new TombstonedSourceKeyConflictError();
        if (existing?.superseded_at) throw new SupersededSourceKeyConflictError();
        throw new Error('Access denied to existing idempotent memory');
      }
      const reset = changed || !memory.embedded;
      const profile = ACTIVE_EMBEDDING_PROFILE;
      const job = (await client.query(`INSERT INTO memory_ingestion_jobs
        (memory_id, namespace, client_id, access_level, allowed_namespaces, agent_id, session_id, source_key,
         dedupe, ttl_seconds, contradiction_eligible, embedding_provider, embedding_model, embedding_dimensions, status, ready_at, accepted_at, memory_created, creation_pending)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
          CASE WHEN $15 THEN 'pending' ELSE 'ready' END, CASE WHEN $15 THEN NULL ELSE statement_timestamp() END, $17, $18, $18)
        ON CONFLICT (memory_id) DO UPDATE SET
          memory_created = CASE WHEN $16 THEN EXCLUDED.memory_created ELSE memory_ingestion_jobs.memory_created END,
          namespace = EXCLUDED.namespace, access_level = CASE WHEN $16 THEN EXCLUDED.access_level ELSE memory_ingestion_jobs.access_level END,
          allowed_namespaces = CASE WHEN $16 THEN EXCLUDED.allowed_namespaces ELSE memory_ingestion_jobs.allowed_namespaces END, agent_id = CASE WHEN $16 THEN EXCLUDED.agent_id ELSE memory_ingestion_jobs.agent_id END, session_id = CASE WHEN $16 THEN EXCLUDED.session_id ELSE memory_ingestion_jobs.session_id END,
          dedupe = CASE WHEN $16 THEN EXCLUDED.dedupe ELSE memory_ingestion_jobs.dedupe END, ttl_seconds = CASE WHEN $16 THEN EXCLUDED.ttl_seconds ELSE memory_ingestion_jobs.ttl_seconds END, contradiction_eligible = CASE WHEN $16 THEN EXCLUDED.contradiction_eligible ELSE memory_ingestion_jobs.contradiction_eligible END,
          embedding_provider = CASE WHEN $16 THEN EXCLUDED.embedding_provider ELSE memory_ingestion_jobs.embedding_provider END, embedding_model = CASE WHEN $16 THEN EXCLUDED.embedding_model ELSE memory_ingestion_jobs.embedding_model END,
          embedding_dimensions = CASE WHEN $16 THEN EXCLUDED.embedding_dimensions ELSE memory_ingestion_jobs.embedding_dimensions END,
          status = CASE WHEN $16 THEN 'pending' ELSE memory_ingestion_jobs.status END,
          attempts = CASE WHEN $16 THEN 0 ELSE memory_ingestion_jobs.attempts END,
          lease_token = CASE WHEN $16 THEN NULL ELSE memory_ingestion_jobs.lease_token END,
          lease_expires_at = CASE WHEN $16 THEN NULL ELSE memory_ingestion_jobs.lease_expires_at END,
          next_attempt_at = CASE WHEN $16 THEN statement_timestamp() ELSE memory_ingestion_jobs.next_attempt_at END,
          accepted_at = CASE WHEN $16 THEN EXCLUDED.accepted_at ELSE memory_ingestion_jobs.accepted_at END,
          ready_at = CASE WHEN $16 THEN NULL ELSE memory_ingestion_jobs.ready_at END,
          finalized_at = CASE WHEN $16 THEN NULL ELSE memory_ingestion_jobs.finalized_at END,
          canonical_memory_id = CASE WHEN $16 THEN NULL ELSE memory_ingestion_jobs.canonical_memory_id END,
          similarity = CASE WHEN $16 THEN NULL ELSE memory_ingestion_jobs.similarity END,
          failure_category = CASE WHEN $16 THEN NULL ELSE memory_ingestion_jobs.failure_category END,
          last_error_code = CASE WHEN $16 THEN NULL ELSE memory_ingestion_jobs.last_error_code END,
          inline_attempted = CASE WHEN $16 THEN false ELSE memory_ingestion_jobs.inline_attempted END,
          inline_ready = CASE WHEN $16 THEN false ELSE memory_ingestion_jobs.inline_ready END
        RETURNING accepted_at, status`,
      [memory.id, input.namespace, auth.keyId, input.access_level, auth.namespaces, agentId, input.session_id ?? null, sourceKey,
        input.dedupe !== false && !sourceKey && input.ttl === undefined, input.ttl ?? null, !sourceKey && input.ttl === undefined,
        profile.provider, profile.model, profile.dimensions, reset, changed, memory.accepted_at, memory.created])).rows[0];
      // Identical keyed retries do not create duplicate acceptance audit events.
      if (auditChanged) await logAudit({ clientId: auth.keyId, action: 'memory.store', namespace: input.namespace,
        memoryId: memory.id, agentId, sessionId: input.session_id, details: { created: memory.created, deduplicated: false, queued: storeState(job.status) === 'queued', ...(sourceKey ? { idempotent: true } : {}) } }, dbScopeFromAuth(auth), client);
      return { id: memory.id, namespace: memory.namespace, expires_at: memory.expires_at ?? null,
        created: storeState(job.status) === 'queued' ? true : memory.created, deduplicated: false,
        state: storeState(job.status), accepted_at: job.accepted_at,
        ...(sourceKey ? { idempotency_key_honored: true as const } : {}) };
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '23505' && sourceKey) throw new Error('Access denied to existing idempotent memory');
    if (error instanceof TombstonedSourceKeyConflictError || error instanceof SupersededSourceKeyConflictError ||
        (error instanceof Error && error.message.startsWith('Access denied'))) throw error;
    throw new IngestionPersistenceError(error);
  }
}

/** One short transaction per claim. Only a worker admin may claim arbitrary jobs. */
export async function claimIngestionJob(scope: DbScope, options: { memoryId?: string; inline?: boolean; leaseMs?: number } = {}): Promise<IngestionJob | null> {
  return (await claimIngestionJobs(scope, { ...options, limit: 1 }))[0] ?? null;
}
export async function claimIngestionJobs(scope: DbScope, options: { memoryId?: string; documentId?: string; inline?: boolean; leaseMs?: number; limit?: number } = {}): Promise<IngestionJob[]> {
  if (!options.inline && !scope.isAdmin) throw new Error('Permission denied: ingestion worker requires admin');
  if (options.inline && !options.memoryId && !options.documentId) throw new Error('Inline claim requires memory or document id');
  const limit = ingestionInteger(String(options.limit ?? 16), 16, 'batch-size', 1, 64);
  const leaseMs = options.leaseMs ?? workerIngestionLeaseMs();
  for (;;) {
  const claimed = await withScopedClient(scope, async client => {
    if (!options.inline) {
      await client.query('SELECT app_ingestion_control(NULL, true)');
      const settings = await client.query('SELECT ingestion_paused FROM instance_settings WHERE singleton');
      if (settings.rows[0]?.ingestion_paused) return [];
      await client.query(`UPDATE memory_ingestion_jobs j SET
        status = CASE WHEN m.deleted_at IS NOT NULL OR m.expires_at <= statement_timestamp() THEN 'cancelled' ELSE 'embedding_failed' END,
        failure_category = CASE WHEN m.deleted_at IS NOT NULL OR m.expires_at <= statement_timestamp() THEN 'expired' ELSE 'transient' END,
        last_error_code = CASE WHEN m.deleted_at IS NOT NULL OR m.expires_at <= statement_timestamp() THEN 'expired' ELSE 'attempts_exhausted' END,
        finalized_at = statement_timestamp(), lease_token = NULL, lease_expires_at = NULL
        FROM memories m WHERE j.memory_id = m.id AND j.namespace = m.namespace
          AND j.status = 'processing' AND j.lease_expires_at < statement_timestamp() AND j.attempts >= $1
          AND ($2::uuid IS NULL OR j.memory_id = $2)`, [ingestionMaxAttempts(), options.memoryId ?? null]);
    }
    const token = randomUUID();
    const jobs = (await client.query(`WITH seed AS MATERIALIZED (
      SELECT j.memory_id, j.client_id, j.namespace, j.last_error_code,
        CASE WHEN j.kind='document' THEN j.document_id END AS document_id FROM memory_ingestion_jobs j
      WHERE ($1::uuid IS NULL OR j.memory_id = $1)
        AND ($5::uuid IS NULL OR j.document_id = $5)
        AND (($2 AND j.client_id = app_current_key_id()) OR NOT $2)
        AND ((j.status IN ('pending','retry_wait') AND j.next_attempt_at <= statement_timestamp())
          OR (j.status = 'processing' AND j.lease_expires_at < statement_timestamp()))
      ORDER BY j.next_attempt_at, j.accepted_at, j.chunk_index, j.memory_id FOR UPDATE SKIP LOCKED LIMIT 1
    ), candidate AS MATERIALIZED (
      SELECT j.memory_id FROM memory_ingestion_jobs j CROSS JOIN seed s
      WHERE (j.memory_id=s.memory_id OR ($1::uuid IS NULL AND s.document_id IS NOT NULL AND j.kind='document' AND j.document_id=s.document_id
        AND s.last_error_code IS DISTINCT FROM 'batch_input_rejected' AND j.last_error_code IS DISTINCT FROM 'batch_input_rejected'))
        AND j.client_id=s.client_id AND j.namespace=s.namespace
        AND (($2 AND j.client_id=app_current_key_id()) OR NOT $2)
        AND ((j.status IN ('pending','retry_wait') AND j.next_attempt_at <= statement_timestamp())
          OR (j.status='processing' AND j.lease_expires_at < statement_timestamp()))
      ORDER BY j.chunk_index, j.memory_id FOR UPDATE OF j SKIP LOCKED LIMIT $6
    ) UPDATE memory_ingestion_jobs j SET status = 'processing',
      attempts = j.attempts + CASE WHEN $2 THEN 0 ELSE 1 END,
      locked_at = statement_timestamp(), lease_expires_at = statement_timestamp() + $3::double precision * interval '1 millisecond',
      lease_token = $4::uuid, inline_attempted = j.inline_attempted OR $2
    FROM candidate c WHERE j.memory_id = c.memory_id RETURNING j.*`,
    [options.memoryId ?? null, options.inline === true, leaseMs, token, options.documentId ?? null, limit])).rows as IngestionJob[];
    return jobs.sort((a,b) => (a.chunk_index ?? 0)-(b.chunk_index ?? 0));
  });
  if (!claimed.length) return [];
  const loaded: IngestionJob[] = [];
  for (const job of claimed) {
  const item = await withScopedClient(ownerScope(job), async client => {
    const fence = await client.query(`SELECT 1 FROM memory_ingestion_jobs WHERE memory_id = $1
      AND status = 'processing' AND lease_token = $2 AND lease_expires_at > statement_timestamp() FOR UPDATE`,
      [job.memory_id, job.lease_token]);
    if (!fence.rows.length) return null;
    const memory = (await client.query(`SELECT *,
      deleted_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= statement_timestamp()) AS expired
      FROM memories WHERE id = $1 AND namespace = $2 FOR UPDATE`, [job.memory_id, job.namespace])).rows[0];
    if (!memory || memory.expired) {
      await client.query(`UPDATE memory_ingestion_jobs SET status = 'cancelled', failure_category = 'expired',
        last_error_code = 'expired', finalized_at = statement_timestamp(), lease_token = NULL, lease_expires_at = NULL
        WHERE memory_id = $1 AND lease_token = $2`, [job.memory_id, job.lease_token]);
      return null;
    }
    if (!job.allowed_namespaces.includes(job.namespace)) {
      await finishJob(client,job,'cancelled'); return null;
    }
    if (memory.embedding !== null) {
      await completeExternalEmbedding(client, job, memory); return null;
    }
    if ((memory.access_level ?? 'normal') !== job.access_level ||
        (job.kind !== 'update' && (memory.superseded_at || memory.consolidated_into_id))) {
      await finishJob(client,job,'cancelled'); return null;
    }
    return { ...job, content: memory.content, expires_at: memory.expires_at, inline: options.inline === true };
  });
  if (item) loaded.push(item);
  }
  if (loaded.length || options.inline) return loaded;
  // Expired jobs are terminal bookkeeping, not evidence that the due queue is empty.
  }
}

export function classifyIngestionFailure(error: unknown): { category: FailureCategory; code: string; terminal: boolean; retryAfter?: string } {
  if (['55P03','57014','40P01','40001'].includes((error as { code?: string } | null)?.code ?? '')) {
    return { category: 'transient', code: 'db_contention', terminal: false };
  }
  if (error instanceof EmbeddingValidationError || error instanceof SyntaxError) return { category: 'input_rejected', code: 'invalid_vector', terminal: true };
  if (error instanceof EmbeddingProviderError) {
    const status = error.status;
    const category: FailureCategory = status === 429 ? 'rate_limited' : status === 401 || status === 403 ? 'provider_auth' : [400,404,413,422].includes(status) ? 'input_rejected' : 'transient';
    return { category, code: `provider_http_${status}`, terminal: category === 'input_rejected', retryAfter: error.retryAfter };
  }
  // Error text can contain content, tokens and URLs. Never persist or emit it.
  return { category: 'transient', code: 'provider_unavailable', terminal: false };
}
export async function failIngestionJob(job: IngestionJob, error: unknown, batch?: { client: ScopedClient; retry: Date }): Promise<void> {
  const failure = classifyIngestionFailure(error);
  const max = ingestionMaxAttempts();
  const budgetHandoff = job.inline && error instanceof Error && ['TimeoutError','AbortError'].includes(error.name);
  const contention = failure.code === 'db_contention';
  const inlineHandoff = job.inline === true && (budgetHandoff || contention);
  // Only the first consecutive contention failure gets a free short retry.
  const freeContention = contention && !job.inline && job.last_error_code !== 'db_contention';
  const terminal = !freeContention && !job.inline && (failure.terminal || (failure.category !== 'provider_auth' && job.attempts >= max));
  const retry = batch?.retry ?? (freeContention ? new Date(Date.now() + 1000) : budgetHandoff ? new Date() : retryAtForAttempt(failure.category === 'provider_auth' ? 5 : Math.max(1, job.attempts), failure.retryAfter));
  const update = (client: ScopedClient) => client.query(`UPDATE memory_ingestion_jobs SET
    status = $3, failure_category = $4, last_error_code = $5,
    attempts = CASE WHEN $9::boolean THEN GREATEST(0, attempts - 1) ELSE attempts END,
    next_attempt_at = CASE WHEN $8::boolean THEN statement_timestamp() ELSE $6::timestamptz END,
    finalized_at = CASE WHEN $7 THEN statement_timestamp() ELSE NULL END,
    lease_token = NULL, lease_expires_at = NULL
    WHERE memory_id = $1 AND status = 'processing' AND lease_token = $2::uuid AND lease_expires_at > statement_timestamp()`,
  [job.memory_id, job.lease_token, terminal ? 'embedding_failed' : inlineHandoff ? 'pending' : 'retry_wait', failure.category, budgetHandoff ? 'inline_budget_exhausted' : failure.code, retry, terminal, inlineHandoff, freeContention]).then(() => undefined);
  if (batch) await update(batch.client); else await withScopedClient(ownerScope(job), update);
}

export async function failIngestionBatch(jobs: IngestionJob[], error: unknown): Promise<void> {
  if (!jobs.length) return;
  const failure=classifyIngestionFailure(error);
  const freeContention=failure.code==='db_contention' && jobs.every(job => !job.inline && job.last_error_code!=='db_contention');
  const retry=freeContention ? new Date(Date.now()+1000) : retryAtForAttempt(failure.category==='provider_auth' ? 5 : Math.max(1,...jobs.map(job => job.attempts)),failure.retryAfter);
  await withScopedClient(ownerScope(jobs[0]), async client => {
    await client.query('SELECT memory_id FROM memory_ingestion_jobs WHERE memory_id=ANY($1::uuid[]) ORDER BY memory_id FOR UPDATE', [jobs.map(job => job.memory_id)]);
    if (jobs.length>1 && jobs.every(job => job.kind==='document') && failure.category==='input_rejected') {
      // A batch response cannot identify the rejected input. Durable single-job
      // claims isolate it without spending each healthy chunk's retry allowance.
      await returnIngestionJobs(client,jobs,'batch_input_rejected'); return;
    }
    for (const job of jobs) await failIngestionJob(job, error, { client, retry });
  });
}

/** No vectors have landed: release only the still-owned generation for a fresh claim. */
async function returnIngestionJobs(client: ScopedClient, jobs: IngestionJob[], code?: 'batch_input_rejected'): Promise<void> {
  for (const job of jobs) await client.query(`UPDATE memory_ingestion_jobs SET status='pending',
    attempts=GREATEST(0,attempts-$3::int), next_attempt_at=transaction_timestamp(),
    locked_at=NULL, lease_token=NULL, lease_expires_at=NULL, finalized_at=NULL,
    last_error_code=COALESCE($4::text,last_error_code),
    failure_category=CASE WHEN $4::text IS NULL THEN failure_category ELSE 'input_rejected' END
    WHERE memory_id=$1 AND lease_token=$2::uuid AND status='processing' AND lease_expires_at>statement_timestamp()`,
  [job.memory_id,job.lease_token,job.inline ? 0 : 1,code ?? null]);
}

/** All leases and memories are locked before any vector/outbox/audit is written. */
export async function finalizeIngestionBatch(jobs: IngestionJob[], embeddings: IngestionEmbeddingResult[]): Promise<boolean> {
  if (!jobs.length) return false;
  if (localServingEnabled() && embeddings.some(embedding => !embedding.localPrepared)) throw new Error('shadow_embedding.ingestion_vectors_required');
  validateEmbeddingBatch(embeddings.map(item => item.vector), jobs.length);
  const first = jobs[0];
  if (!first.document_id || jobs.some(job => job.kind !== 'document' || job.document_id !== first.document_id || job.client_id !== first.client_id || job.namespace !== first.namespace)) throw new Error('Document batch must share owner and document');
  return withScopedClient(ownerScope(first), async client => {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const ids = jobs.map(job => job.memory_id);
    const leases = (await client.query(`SELECT *, lease_expires_at > statement_timestamp() AS live
      FROM memory_ingestion_jobs WHERE memory_id=ANY($1::uuid[]) ORDER BY memory_id FOR UPDATE`, [ids])).rows;
    const owned=jobs.filter(job => leases.some(lease => lease.memory_id===job.memory_id && lease.status==='processing' && lease.live && lease.lease_token===job.lease_token));
    if (owned.length!==jobs.length) { await returnIngestionJobs(client,owned); return false; }
    const memories = (await client.query(`SELECT *, expires_at <= statement_timestamp() AS expired,
      superseded_at IS NULL AND consolidated_into_id IS NULL
        AND (valid_from IS NULL OR valid_from<=statement_timestamp())
        AND (valid_to IS NULL OR valid_to>statement_timestamp()) AS local_index_eligible
      FROM memories WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids])).rows;
    const invalid=jobs.filter(job => {
      const memory=memories.find(memory => memory.id===job.memory_id);
      if (!memory || memory.namespace!==job.namespace || memory.deleted_at || memory.expired || !job.allowed_namespaces.includes(job.namespace)) return true;
      if (memory.embedding!==null) return memory.embedding_provider!==job.embedding_provider || memory.embedding_model!==job.embedding_model || memory.embedding_dimensions!==job.embedding_dimensions;
      return memory.content!==job.content || (memory.access_level ?? 'normal')!==job.access_level || memory.superseded_at || memory.consolidated_into_id;
    });
    if (invalid.length) {
      for (const job of invalid) {
        const memory=memories.find(memory => memory.id===job.memory_id);
        await finishJob(client,job,'cancelled',!memory || memory.deleted_at || memory.expired ? 'expired' : undefined);
      }
      await returnIngestionJobs(client,jobs.filter(job => !invalid.includes(job)));
      return false;
    }
    if (jobs.some((job,index) => embeddingIdentity({ provider:job.embedding_provider, model:job.embedding_model, dimensions:job.embedding_dimensions })!==embeddingIdentity(ACTIVE_EMBEDDING_PROFILE) || embeddingIdentity(embeddings[index])!==embeddingIdentity(ACTIVE_EMBEDDING_PROFILE))) {
      for (const job of jobs) await finishJob(client,job,'embedding_failed','space_mismatch');
      return false;
    }
    const incompleteExternal: IngestionJob[]=[];
    for (const job of jobs) {
      const memory=memories.find(memory => memory.id===job.memory_id)!;
      if (memory.embedding !== null && !(await hasCurrentLocalEmbedding(client,job.memory_id))) incompleteExternal.push(job);
    }
    if (incompleteExternal.length) {
      for (const job of incompleteExternal) await finishJob(client,job,'embedding_failed','space_mismatch');
      await returnIngestionJobs(client,jobs.filter(job => !incompleteExternal.includes(job)));
      return false;
    }
    for (let index=0; index<jobs.length; index++) {
      const job=jobs[index], embedding=embeddings[index];
      const memory=memories.find(memory => memory.id===job.memory_id)!;
      if (memory.embedding !== null) { await completeExternalEmbedding(client,job,memory); continue; }
      requireMemoryUpdate(await client.query(`UPDATE memories SET embedding=$2::vector, embedding_provider=$3,
        embedding_model=$4, embedding_dimensions=$5, updated_at=statement_timestamp()
        WHERE id=$1 AND embedding IS NULL`, [job.memory_id,serializeEmbeddingVector(embedding.vector),embedding.provider,embedding.model,embedding.dimensions]));
      if (memory.local_index_eligible) await publishPreparedLocalDocument(client,job.memory_id,embedding.localPrepared,{ ingestionLease:job.lease_token });
      await client.query(`UPDATE memory_ingestion_jobs SET status='ready', creation_pending=false, ready_at=statement_timestamp(),
        finalized_at=statement_timestamp(), lease_token=NULL, lease_expires_at=NULL, failure_category=NULL,
        last_error_code=NULL, inline_ready=$2 WHERE memory_id=$1`, [job.memory_id,job.inline===true]);
      await auditReady(client,job,false);
    }
    return true;
  });
}

export async function embedBatchWithinBudget(contents: string[], budget: number, signal?: AbortSignal, embed = embedBatchWithProfile): Promise<IngestionEmbeddingResult[]> {
  const controller=new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const combined=signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
  try {
    const work=async ():Promise<IngestionEmbeddingResult[]> => {
      if (embed===embedBatchWithProfile && localServingEnabled()) {
        const prepared:PreparedLocalDocument[]=[];
        for (const content of contents) {
          const local=await prepareLocalDocument(content,combined);
          if (!local) throw new Error('shadow_embedding.ingestion_vectors_required');
          prepared.push(local);
        }
        const embeddings=ACTIVE_EMBEDDING_PROFILE.provider==='llama.cpp'
          ? prepared.map(local => ({ ...ACTIVE_EMBEDDING_PROFILE,vector:local.vectors[0] }))
          : await embed(contents,ACTIVE_EMBEDDING_PROFILE,combined);
        return embeddings.map((embedding,index) => ({ ...embedding,localPrepared:prepared[index] }));
      }
      return embed(contents,ACTIVE_EMBEDDING_PROFILE,combined);
    };
    return await Promise.race([work(),new Promise<never>((_,reject) => {
      timer=setTimeout(() => { controller.abort(); reject(new DOMException('Embedding budget exhausted','TimeoutError')); },budget);
    })]);
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}

export async function tryInlineDocument(documentId: string, count: number, auth: AuthContext): Promise<void> {
  let jobs: IngestionJob[]=[];
  try {
    const budget=inlineBudgetMs();
    if (!budget || count>documentInlineMaxChunks()) return;
    jobs=await claimIngestionJobs(dbScopeFromAuth(auth), { documentId,inline:true,limit:count,leaseMs:budget+30000 });
    if (!jobs.length) return;
    const embeddings=await embedBatchWithinBudget(jobs.map(job => job.content),budget);
    await finalizeIngestionBatch(jobs,embeddings);
  } catch (error) {
    try { await failIngestionBatch(jobs,error); } catch { /* Durable leases recover. */ }
    console.warn('[ingestion] outcome=document_inline_deferred');
  }
}

/** Lease row lock and token fence cover dedupe, belief mutation, vector, outbox and audit together. */
export async function finalizeIngestionJob(job: IngestionJob, embedding: IngestionEmbeddingResult, options: {
  deadlineAt?: number; contradictionPolicy?: ContradictionPolicy; prepareRevision?: typeof prepareBeliefRevision;
} = {}): Promise<StoreResult | null> {
  if (localServingEnabled() && !embedding.localPrepared) throw new Error('shadow_embedding.ingestion_vectors_required');
  const scope = ownerScope(job);
  const vector = serializeEmbeddingVector(embedding.vector);
  const target = { provider: job.embedding_provider, model: job.embedding_model, dimensions: job.embedding_dimensions };
  const policy = options.contradictionPolicy ?? contradictionPolicyFromEnv();
  let preparedPredecessor: string | null = null;
  // Never hold a checked-out connection, row lock or dedupe lock across provider classification.
  if (job.contradiction_eligible && policy.mutationEnabled && policyAllowsScope(policy, job.namespace, job.access_level) &&
      embeddingIdentity(target) === embeddingIdentity(ACTIVE_EMBEDDING_PROFILE) &&
      embeddingIdentity(target) === embeddingIdentity(embedding)) {
    const snapshot = await withScopedClient(scope, async client => {
      if (!await currentMutationAuthority(client, job)) return undefined;
      return (await client.query(`SELECT m.* FROM memories m
      JOIN memory_ingestion_jobs j ON j.memory_id = m.id
      WHERE m.id = $1 AND m.namespace = $2 AND m.content = $3 AND m.access_level = $4
        AND m.embedding IS NULL AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.supersedes_id IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
        AND j.status = 'processing' AND j.lease_token = $5 AND j.lease_expires_at > statement_timestamp()`,
      [job.memory_id, job.namespace, job.content, job.access_level, job.lease_token])).rows[0];
    }, { readOnly: true });
    if (snapshot) {
      const remaining = options.deadlineAt === undefined ? policy.timeoutMs : options.deadlineAt - Date.now();
      // Do not reserve a paid classification that cannot receive its full timeout.
      if (remaining < policy.timeoutMs) throw new DOMException('Inline classification budget exhausted', 'TimeoutError');
      preparedPredecessor = await (options.prepareRevision ?? prepareBeliefRevision)(semanticMemory(job, snapshot, vector, embedding.localPrepared), ownerAuth(job), {
        policy, timeoutMs: Math.min(policy.timeoutMs, remaining),
        throwOnTimeout: options.deadlineAt !== undefined && remaining < policy.timeoutMs, allowMutation: true, excludeCandidateId: job.memory_id,
      });
    }
  }
  let shadow: (() => Promise<void>) | undefined;
  const result = await withCheckedOutClient(client => withScopedTransactionOnClient(client, scope, async client => {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const fenced = await client.query(`SELECT * FROM memory_ingestion_jobs WHERE memory_id = $1 AND status = 'processing'
      AND lease_token = $2::uuid AND lease_expires_at > statement_timestamp() FOR UPDATE`, [job.memory_id, job.lease_token]);
    if (!fenced.rows.length) return null;
    const memory = (await client.query(`SELECT *, (expires_at IS NOT NULL AND expires_at <= statement_timestamp()) AS expired,
        superseded_at IS NULL AND consolidated_into_id IS NULL
          AND (valid_from IS NULL OR valid_from<=statement_timestamp())
          AND (valid_to IS NULL OR valid_to>statement_timestamp()) AS local_index_eligible
      FROM memories WHERE id = $1 AND namespace = $2 FOR UPDATE`, [job.memory_id, job.namespace])).rows[0];
    if (!memory || memory.deleted_at || memory.expired) {
      await finishJob(client, job, 'cancelled', 'expired'); return null;
    }
    if (!job.allowed_namespaces.includes(job.namespace)) {
      await finishJob(client, job, 'cancelled'); return null;
    }
    if (memory.embedding !== null) return completeExternalEmbedding(client, job, memory);
    // A later synchronous writer must never receive an older content vector.
    // The current locked job/lease is the content generation fence, including ABA.
    // Public revision also tracks metadata and lifecycle edits, which do not
    // invalidate an update's historical vector or reset its durable job.
    if (memory.content !== job.content || (memory.access_level ?? 'normal') !== job.access_level ||
        (job.kind !== 'update' && (memory.superseded_at || memory.consolidated_into_id))) {
      await finishJob(client, job, 'cancelled'); return null;
    }
    if (embeddingIdentity(target) !== embeddingIdentity(ACTIVE_EMBEDDING_PROFILE) || embeddingIdentity(target) !== embeddingIdentity(embedding)) {
      await finishJob(client, job, 'embedding_failed', 'space_mismatch'); return null;
    }
    // Existing explicit history belongs to the caller and must survive indexing.
    const hasExplicitLink = memory.supersedes_id != null;
    const crossRowPossible = !hasExplicitLink && ((job.dedupe && job.ttl_seconds === null) || preparedPredecessor !== null);
    let mutationAuthorized = false;
    if (crossRowPossible) {
      // Do not fence the key while queued behind unrelated namespace work.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`memory-store-dedupe:${JSON.stringify([job.namespace, job.access_level])}`]);
      // Serialize contenders so later finalizers cannot join shared holders
      // ahead of a waiting revoker. Authentication skips this telemetry lock.
      mutationAuthorized = await currentMutationAuthority(client, job, true);
    }
    const semantic = semanticMemory(job, memory, vector, embedding.localPrepared);
    let revised = null;
    if (mutationAuthorized && preparedPredecessor) {
      await client.query('SAVEPOINT ingestion_revision');
      try {
        revised = await commitAutomaticRevision(semantic, preparedPredecessor, ownerAuth(job), { id: job.memory_id, client });
      } catch (error) {
        if (!['23503','23505','23514','40001','40P01'].includes((error as { code?: string }).code ?? '')) throw error;
        await client.query('ROLLBACK TO SAVEPOINT ingestion_revision');
      }
      await client.query('RELEASE SAVEPOINT ingestion_revision');
    }
    if (mutationAuthorized && !revised && job.dedupe && job.ttl_seconds === null) {
      const match = embedding.localPrepared
        ? await findLocalDocumentDuplicate(client, embedding.localPrepared, job.namespace, job.access_level, job.memory_id)
        : await findIngestionDedupeCandidate(client, job, embedding, vector);
      const similarity = Number(match?.similarity ?? NaN);
      const threshold = MEMORY_DEDUPE_THRESHOLD;
      if (match && Number.isFinite(similarity) && similarity >= threshold) {
        requireMemoryUpdate(await client.query(`UPDATE memories SET access_count = COALESCE(access_count,0) + 1,
          accessed_at = statement_timestamp(), last_boosted_at = statement_timestamp(), updated_at = statement_timestamp(),
          tags = ARRAY(SELECT value FROM unnest(COALESCE(memories.tags, ARRAY[]::text[]) || $2::text[])
            WITH ORDINALITY AS combined(value, position) GROUP BY value ORDER BY MIN(position)) WHERE id = $1`, [match.id, memory.tags]));
        requireMemoryUpdate(await client.query('UPDATE memories SET deleted_at = statement_timestamp(), updated_at = statement_timestamp() WHERE id = $1', [job.memory_id]));
        await client.query(`UPDATE memory_ingestion_jobs SET status = 'deduplicated', creation_pending = false, canonical_memory_id = $3,
          similarity = $4, ready_at = statement_timestamp(), finalized_at = statement_timestamp(), lease_token = NULL,
          lease_expires_at = NULL, failure_category = NULL, last_error_code = NULL, inline_ready = $5
          WHERE memory_id = $1 AND lease_token = $2`, [job.memory_id, job.lease_token, match.id, similarity, job.inline === true]);
        await auditReady(client, job, true);
        return { id: match.id, namespace: match.namespace, expires_at: null, created: false, deduplicated: true,
          similarity, state: 'ready' as const, accepted_at: job.accepted_at };
      }
    }
    if (!revised) requireMemoryUpdate(await client.query(`UPDATE memories SET embedding = $2::vector, embedding_provider = $3,
      embedding_model = $4, embedding_dimensions = $5${job.kind === 'update' ? '' : ', updated_at = statement_timestamp()'} WHERE id = $1
        AND embedding IS NULL AND content = $6 AND namespace = $7 AND COALESCE(access_level, 'normal') = $8
        AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > statement_timestamp())`,
    [job.memory_id, vector, embedding.provider, embedding.model, embedding.dimensions, job.content, job.namespace, job.access_level]));
    if (!revised && memory.local_index_eligible) await publishPreparedLocalDocument(client, job.memory_id, embedding.localPrepared, { ingestionLease: job.lease_token });
    await client.query(`UPDATE memory_ingestion_jobs SET status = 'ready', creation_pending = false, ready_at = statement_timestamp(),
      finalized_at = statement_timestamp(), lease_token = NULL, lease_expires_at = NULL,
      failure_category = NULL, last_error_code = NULL, inline_ready = $3
      WHERE memory_id = $1 AND lease_token = $2`, [job.memory_id, job.lease_token, job.inline === true]);
    await auditReady(client, job, false);
    if (!hasExplicitLink && job.contradiction_eligible && !policy.mutationEnabled && policyAllowsScope(policy, job.namespace, job.access_level) &&
        await currentMutationAuthority(client, job)) {
      shadow = () => maybeReviseBelief(semantic, ownerAuth(job), { policy, allowMutation: false, excludeCandidateId: job.memory_id }).then(() => undefined);
    }
    return { id: job.memory_id, namespace: job.namespace, expires_at: memory.expires_at ?? null,
      created: job.memory_created, deduplicated: false, state: 'ready' as const, accepted_at: job.accepted_at };
  }));
  if (shadow) scheduleShadowClassification(contradictionPolicyFromEnv(), shadow);
  return result;
}
async function findIngestionDedupeCandidate(client: ScopedClient, job: IngestionJob, embedding: EmbeddingResult, vector: string) {
  return (await client.query(`SELECT m.id, m.namespace, 1 - (m.embedding <=> $1::vector) AS similarity
        FROM memories m WHERE m.namespace = $2 AND COALESCE(m.access_level,'normal') = $3
          AND m.embedding IS NOT NULL AND m.embedding_provider = $4 AND m.embedding_model = $5 AND m.embedding_dimensions = $6
          AND m.id <> $7 AND m.source_key IS NULL AND m.document_id IS NULL AND m.deleted_at IS NULL
          AND m.expires_at IS NULL AND m.superseded_at IS NULL AND m.valid_to IS NULL
          AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp()) AND m.consolidated_into_id IS NULL
          AND m.memory_kind NOT IN ('document_chunk','episode_chunk')
        ORDER BY m.embedding <=> $1::vector ASC,
          calculate_relevance(m.relevance_base_score,m.decay_rate,m.accessed_at,m.access_count) DESC, m.created_at ASC, m.id ASC
        LIMIT 1 FOR UPDATE`, [vector, job.namespace, job.access_level, embedding.provider, embedding.model, embedding.dimensions, job.memory_id])).rows[0];
}
async function hasCurrentLocalEmbedding(client: ScopedClient, memoryId: string): Promise<boolean> {
  if (!localServingEnabled()) return true;
  const complete = await client.query(`SELECT 1 FROM memory_embedding_manifests f
      JOIN memories m ON m.id=f.parent_id WHERE f.parent_id=$1 AND f.contract_id=$2
        AND f.is_current AND f.source_revision=m.revision
        AND f.source_sha256=encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex')
        AND f.source_bytes=octet_length(convert_to(m.content,'UTF8'))
        AND f.chunk_count=(SELECT count(*) FROM memory_embedding_chunks c WHERE c.parent_id=m.id AND c.contract_id=f.contract_id)
        AND COALESCE((SELECT min(c.ordinal)=0 AND max(c.ordinal)=f.chunk_count-1 FROM memory_embedding_chunks c
          WHERE c.parent_id=m.id AND c.contract_id=f.contract_id),false)`, [memoryId, process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT]);
  return complete.rows.length > 0;
}
async function completeExternalEmbedding(client: ScopedClient, job: IngestionJob, memory: Record<string, any>): Promise<StoreResult | null> {
  if (!(await hasCurrentLocalEmbedding(client, job.memory_id))) {
    await finishJob(client, job, 'embedding_failed', 'space_mismatch'); return null;
  }
  if (memory.embedding_provider !== job.embedding_provider || memory.embedding_model !== job.embedding_model ||
      memory.embedding_dimensions !== job.embedding_dimensions) {
    await finishJob(client, job, 'cancelled'); return null;
  }
  await client.query(`UPDATE memory_ingestion_jobs SET status = 'ready', creation_pending = false, ready_at = statement_timestamp(),
    finalized_at = statement_timestamp(), lease_token = NULL, lease_expires_at = NULL,
    failure_category = NULL, last_error_code = NULL WHERE memory_id = $1 AND lease_token = $2`, [job.memory_id, job.lease_token]);
  await auditReady(client, job, false);
  return { id: job.memory_id, namespace: job.namespace, expires_at: memory.expires_at ?? null,
    created: job.memory_created, deduplicated: false, state: 'ready', accepted_at: job.accepted_at };
}
function semanticMemory(job: IngestionJob, memory: Record<string, any>, vector: string, localPrepared?: PreparedLocalDocument): SemanticMemoryInsert {
  return { content: memory.content, vector, localPrepared, source: memory.source, namespace: memory.namespace,
    tags: memory.tags, metadata: memory.metadata, accessLevel: memory.access_level,
    clientId: job.client_id, agentId: job.agent_id, sessionId: job.session_id };
}
async function finishJob(client: ScopedClient, job: IngestionJob, state: IngestionState, category?: FailureCategory): Promise<void> {
  await client.query(`UPDATE memory_ingestion_jobs SET status = $3, failure_category = $4, last_error_code = $4,
    finalized_at = statement_timestamp(), lease_token = NULL, lease_expires_at = NULL WHERE memory_id = $1 AND lease_token = $2`,
  [job.memory_id, job.lease_token, state, category ?? null]);
}
async function auditReady(client: ScopedClient, job: IngestionJob, deduplicated: boolean): Promise<void> {
  await logAudit({ clientId: job.client_id, action: deduplicated ? 'memory.ingest.deduplicated' : 'memory.ingest.ready',
    namespace: job.namespace, memoryId: job.memory_id, agentId: job.agent_id, sessionId: job.session_id ?? undefined,
    details: { attempts: job.attempts, deduplicated } }, ownerScope(job), client);
}

async function currentStoreResult(accepted: StoreResult, auth: AuthContext): Promise<StoreResult> {
  const job = await withScopedClient(dbScopeFromAuth(auth), async client => (await client.query(`SELECT status,
    canonical_memory_id, similarity, memory_created FROM memory_ingestion_jobs WHERE memory_id = $1`, [accepted.id])).rows[0]);
  if (!job) return accepted;
  const state = storeState(job.status);
  return { ...accepted, state, created: state === 'queued' ? accepted.created : job.memory_created,
    ...(job.status === 'deduplicated' ? { id: job.canonical_memory_id, deduplicated: true, created: false, similarity: job.similarity } : {}) };
}
export async function tryInlineIngestion(accepted: StoreResult, auth: AuthContext): Promise<StoreResult> {
  if (accepted.state !== 'queued') return accepted;
  let job: IngestionJob | null = null;
  try {
    const budget = inlineBudgetMs();
    if (budget === 0) return accepted;
    job = await claimIngestionJob(dbScopeFromAuth(auth), { memoryId: accepted.id, inline: true, leaseMs: budget + 30_000 });
    if (!job) return await currentStoreResult(accepted, auth);
    const deadlineAt = Date.now() + budget;
    const remaining = deadlineAt - Date.now();
    if (remaining < 1) throw new DOMException('Inline budget exhausted', 'TimeoutError');
    const embedding = await embedWithinBudget(job.content, remaining);
    const ready = await finalizeIngestionJob(job, embedding, { deadlineAt });
    return ready ? { ...ready, ...(accepted.idempotency_key_honored ? { idempotency_key_honored: true } : {}) } : await currentStoreResult(accepted, auth);
  } catch (error) {
    // Acceptance already committed. Even a second DB failure must never undo its acknowledgement.
    if (job) { try { await failIngestionJob(job, error); } catch { /* Lease expiry recovers the job. */ } }
    console.warn('[ingestion] outcome=inline_deferred');
    try { return await currentStoreResult(accepted, auth); } catch { return accepted; }
  }
}
/** Race also bounds test/faulty providers which fail to honor AbortSignal. Late results never finalize. */
export async function embedWithinBudget(content: string, budget: number, embed = embedWithProfile, signal?: AbortSignal): Promise<IngestionEmbeddingResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  try {
    const work = async (): Promise<IngestionEmbeddingResult> => {
      if (embed === embedWithProfile && localServingEnabled()) {
        const localPrepared = await prepareLocalDocument(content, combined);
        if (!localPrepared) throw new Error('shadow_embedding.ingestion_vectors_required');
        const embedding = ACTIVE_EMBEDDING_PROFILE.provider === 'llama.cpp'
          ? { vector: localPrepared.vectors[0], ...ACTIVE_EMBEDDING_PROFILE }
          : await embed(content, ACTIVE_EMBEDDING_PROFILE, combined);
        return { ...embedding, localPrepared };
      }
      return embed(content, ACTIVE_EMBEDDING_PROFILE, combined);
    };
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new DOMException('Embedding budget exhausted', 'TimeoutError')); }, budget);
    })]);
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}

export async function requeueIngestionJob(memoryId: string, auth: AuthContext): Promise<{ requeued: true }> {
  checkPermission(auth, 'admin');
  return withScopedClient(dbScopeFromAuth(auth), async client => {
    const updated = await client.query(`UPDATE memory_ingestion_jobs j SET status = 'pending', attempts = 0,
      next_attempt_at = statement_timestamp(), locked_at = NULL, lease_token = NULL, lease_expires_at = NULL,
      failure_category = NULL, last_error_code = NULL, finalized_at = NULL, ready_at = NULL,
      requeued_by = $2, requeued_at = statement_timestamp()
      WHERE j.memory_id = $1 AND j.status IN ('embedding_failed','cancelled')
        AND ${accessLevelSql('j.access_level', '$3')}
        AND EXISTS (SELECT 1 FROM memories m WHERE m.id = j.memory_id AND m.deleted_at IS NULL
          AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp()) AND ${accessLevelSql('m.access_level', '$3')}) RETURNING j.namespace`, [memoryId, auth.keyId, auth.maxAccessLevel]);
    if (!updated.rows.length) throw new MemoryConflictError('Ingestion job is unavailable or cannot be requeued in its current state');
    await logAudit({ clientId: auth.keyId, action: 'ingestion.requeue', namespace: updated.rows[0].namespace,
      memoryId, details: { requeued: true } }, dbScopeFromAuth(auth), client);
    return { requeued: true };
  });
}
export async function requeueDocument(documentId: string, auth: AuthContext): Promise<{ requeued: number }> {
  checkPermission(auth,'admin');
  return withScopedClient(dbScopeFromAuth(auth), async client => {
    const updated = await client.query(`UPDATE memory_ingestion_jobs j SET status='pending', attempts=0,
      next_attempt_at=statement_timestamp(), locked_at=NULL, lease_token=NULL, lease_expires_at=NULL,
      failure_category=NULL, last_error_code=NULL, finalized_at=NULL, ready_at=NULL,
      requeued_by=$2, requeued_at=statement_timestamp()
      WHERE j.status IN ('embedding_failed','cancelled')
        AND ${accessLevelSql('j.access_level','$3')}
        AND EXISTS (SELECT 1 FROM memories m WHERE m.id=j.memory_id AND m.document_id=$1
          AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
          AND ${accessLevelSql('m.access_level','$3')}) RETURNING j.namespace`, [documentId,auth.keyId,auth.maxAccessLevel]);
    if (!updated.rows.length) throw new MemoryConflictError('Document jobs are unavailable or cannot be requeued in their current state');
    await logAudit({ clientId:auth.keyId,action:'ingestion.document.requeue',namespace:updated.rows[0].namespace,
      resourceType:'document',resourceId:documentId,details:{ requeued:updated.rows.length } },dbScopeFromAuth(auth),client);
    return { requeued:updated.rows.length };
  });
}
export async function setIngestionPaused(paused: boolean, auth: AuthContext): Promise<{ paused: boolean }> {
  checkPermission(auth, 'admin');
  return withScopedClient(dbScopeFromAuth(auth), async client => {
    await client.query('SELECT app_ingestion_control($1, false)', [paused]);
    await logAudit({ clientId: auth.keyId, action: paused ? 'ingestion.pause' : 'ingestion.resume', resourceType: 'system' }, dbScopeFromAuth(auth), client);
    return { paused };
  });
}
export async function ingestionStats(auth: AuthContext) {
  checkPermission(auth, 'admin');
  const scope = dbScopeFromAuth(auth);
  const visible = accessLevelSql('j.access_level', '$1');
  const monitoring = await withScopedClient(scope, async client => {
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query(`WITH live AS MATERIALIZED (
        SELECT status, accepted_at, next_attempt_at, failure_category, (to_jsonb(j)->>'document_id')::uuid AS document_id FROM memory_ingestion_jobs j
        WHERE j.status IN ('pending','retry_wait','processing') AND ${visible}
      ), failures AS (
        SELECT failure_category FROM live WHERE failure_category IS NOT NULL
        UNION ALL
        SELECT j.failure_category FROM memory_ingestion_jobs j
        WHERE j.status IN ('embedding_failed','cancelled') AND j.failure_category IS NOT NULL
          AND j.finalized_at >= statement_timestamp() - interval '24 hours' AND ${visible}
      ) SELECT
        COALESCE((SELECT jsonb_object_agg(status, count) FROM (SELECT status, COUNT(*)::int AS count FROM live GROUP BY status) s), '{}'::jsonb) AS depth,
        (SELECT EXTRACT(EPOCH FROM statement_timestamp() - MIN(accepted_at))::double precision FROM live) AS oldest_pending_age_seconds,
        (SELECT MIN(next_attempt_at) FROM live WHERE status = 'retry_wait') AS next_retry_at,
        (SELECT COUNT(DISTINCT document_id)::int FROM live) AS pending_documents,
        COALESCE((SELECT jsonb_object_agg(failure_category, count) FROM (SELECT failure_category, COUNT(*)::int AS count FROM failures GROUP BY failure_category) f), '{}'::jsonb) AS failure_categories`, [auth.maxAccessLevel]);
    const settings = (await client.query('SELECT ingestion_paused AS paused, ingestion_worker_seen_at AS last_worker_heartbeat FROM instance_settings WHERE singleton')).rows[0];
    return { ...result.rows[0], ...settings, attempts_histogram: {}, inline_hit_rate: null,
      history_available: false, depth_scope: 'nonterminal' as const };
  });
  try {
    const history = await withScopedClient(scope, async client => {
      // This optional history query cannot abort already committed monitoring.
      await client.query("SET LOCAL statement_timeout = '5s'");
      return (await client.query(`SELECT
        COALESCE((SELECT jsonb_object_agg(status, count) FROM (SELECT status, COUNT(*)::int AS count FROM memory_ingestion_jobs j WHERE ${visible} GROUP BY status) s), '{}'::jsonb) AS depth,
        COALESCE((SELECT jsonb_object_agg(attempts, count) FROM (SELECT attempts, COUNT(*)::int AS count FROM memory_ingestion_jobs j WHERE ${visible} GROUP BY attempts) a), '{}'::jsonb) AS attempts_histogram,
        COUNT(*) FILTER (WHERE inline_ready)::double precision / NULLIF(COUNT(*) FILTER (WHERE inline_attempted),0) AS inline_hit_rate
        FROM memory_ingestion_jobs j WHERE ${visible}`, [auth.maxAccessLevel])).rows[0];
    });
    return { ...monitoring, ...history, history_available: true, depth_scope: 'all' as const };
  } catch {
    console.warn('[ingestion] outcome=history_metrics_unavailable');
    return monitoring;
  }
}
