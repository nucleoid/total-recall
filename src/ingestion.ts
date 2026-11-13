import { MEMORY_DEDUPE_THRESHOLD } from './store-config.js';
import { createHash, randomUUID } from 'node:crypto';
import { checkPermission, ensureAccessLevelAllowed, filterNamespaces } from './auth.js';
import { logAudit } from './audit.js';
import { dbScopeFromAuth, withScopedClient, withCheckedOutClient, withScopedTransactionOnClient, type DbScope, type ScopedClient } from './db.js';
import { ACTIVE_EMBEDDING_PROFILE, embedWithProfile, embeddingIdentity, serializeEmbeddingVector,
  EmbeddingProviderError, EmbeddingValidationError, type EmbeddingResult } from './embedding.js';
import { TombstonedSourceKeyConflictError, SupersededSourceKeyConflictError, MemoryConflictError } from './errors.js';
import { contradictionPolicyFromEnv, maybeReviseBelief, prepareBeliefRevision, commitAutomaticRevision, policyAllowsScope, scheduleShadowClassification,
  type SemanticMemoryInsert, type ContradictionPolicy } from './contradictions.js';
import { retryAtForAttempt } from './retry.js';
import type { AccessLevel, AuthContext, StoreResult } from './types.js';

export class IngestionPersistenceError extends Error {
  readonly statusCode = 503;
  readonly code = 'ingestion_persistence_unavailable';
  constructor(cause: unknown) { super('Durable memory acceptance unavailable', { cause }); }
}

export type IngestionState = 'pending' | 'processing' | 'retry_wait' | 'ready' | 'deduplicated' | 'embedding_failed' | 'cancelled';
export type FailureCategory = 'transient' | 'rate_limited' | 'provider_auth' | 'input_rejected' | 'space_mismatch' | 'expired';
export interface IngestionJob {
  memory_id: string; namespace: string; client_id: string; access_level: AccessLevel;
  allowed_namespaces: string[]; agent_id: string; session_id: string | null; source_key: string | null;
  memory_created: boolean; dedupe: boolean; ttl_seconds: string | null; contradiction_eligible: boolean;
  embedding_provider: string; embedding_model: string; embedding_dimensions: number;
  status: IngestionState; attempts: number; lease_token: string; accepted_at: Date;
  content: string; expires_at: Date | null; inline?: boolean;
}
export interface AcceptMemoryInput {
  content: string; namespace: string; source?: string; tags: string[]; metadata: Record<string, unknown>;
  access_level: AccessLevel; session_id?: string; idempotency_key?: string; dedupe?: boolean; ttl?: number;
}
export function ingestionEnabled(): boolean { return process.env.MEMORY_INGESTION_QUEUE_ENABLED === 'true'; }
export function ingestionInteger(raw: string | undefined, fallback: number, name: string, min = 0, max = 120_000): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (raw?.trim() === '' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
export function inlineBudgetMs(): number {
  return ingestionInteger(process.env.MEMORY_STORE_INLINE_EMBED_MS, 3000, 'MEMORY_STORE_INLINE_EMBED_MS');
}
function ownerScope(job: IngestionJob): DbScope { return { namespaces: [job.namespace], keyId: job.client_id }; }
function ownerAuth(job: IngestionJob): AuthContext {
  return { keyId: job.client_id, name: 'ingestion', namespaces: [job.namespace], permissions: ['read','write'], maxAccessLevel: job.access_level };
}

/** The only acknowledgement boundary: memory, job and acceptance audit commit together. */
export async function acceptMemory(input: AcceptMemoryInput, auth: AuthContext, agentId: string): Promise<StoreResult> {
  checkPermission(auth, 'write');
  if (!filterNamespaces([input.namespace], auth.namespaces).length) throw new Error('Access denied to namespace');
  ensureAccessLevelAllowed(input.access_level, auth.maxAccessLevel);
  const sourceKey = input.idempotency_key ? `discord-safe:v1:${createHash('sha256').update(auth.keyId).update('\0').update(input.idempotency_key).digest('hex')}` : null;
  try {
    return await withScopedClient(dbScopeFromAuth(auth), async client => {
      let previous: { content: string; namespace: string; access_level: string } | undefined;
      if (sourceKey) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`memory-store-key:${auth.keyId}:${sourceKey}`]);
        // Match finalize's job -> memory lock order, including namespace moves.
        await client.query(`SELECT j.memory_id FROM memory_ingestion_jobs j WHERE j.client_id = $1 AND j.source_key = $2 FOR UPDATE`, [auth.keyId, sourceKey]);
        previous = (await client.query(`SELECT content, namespace, access_level FROM memories WHERE client_id = $1 AND source_key = $2`, [auth.keyId, sourceKey])).rows[0];
      }
      const changed = !previous || previous.content !== input.content || previous.namespace !== input.namespace || previous.access_level !== input.access_level;
      const conflict = sourceKey ? `ON CONFLICT (client_id, source_key) DO UPDATE SET
        content = EXCLUDED.content,
        embedding = CASE WHEN $13 THEN NULL ELSE memories.embedding END,
        embedding_provider = CASE WHEN $13 THEN NULL ELSE memories.embedding_provider END,
        embedding_model = CASE WHEN $13 THEN NULL ELSE memories.embedding_model END,
        embedding_dimensions = CASE WHEN $13 THEN NULL ELSE memories.embedding_dimensions END,
        source = EXCLUDED.source, namespace = EXCLUDED.namespace, tags = EXCLUDED.tags,
        metadata = EXCLUDED.metadata, access_level = EXCLUDED.access_level, agent_id = EXCLUDED.agent_id,
        session_id = EXCLUDED.session_id, expires_at = EXCLUDED.expires_at, updated_at = statement_timestamp()
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
         dedupe, ttl_seconds, contradiction_eligible, embedding_provider, embedding_model, embedding_dimensions, status, ready_at, accepted_at, memory_created)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
          CASE WHEN $15 THEN 'pending' ELSE 'ready' END, CASE WHEN $15 THEN NULL ELSE statement_timestamp() END, $17, $18)
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
      if (changed) await logAudit({ clientId: auth.keyId, action: 'memory.store', namespace: input.namespace,
        memoryId: memory.id, agentId, sessionId: input.session_id, details: { created: memory.created, deduplicated: false, queued: true, ...(sourceKey ? { idempotent: true } : {}) } }, dbScopeFromAuth(auth), client);
      return { id: memory.id, namespace: memory.namespace, expires_at: memory.expires_at ?? null,
        created: job.status === 'ready' ? memory.created : true, deduplicated: false,
        state: job.status === 'ready' ? 'ready' : 'queued', accepted_at: job.accepted_at,
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
  if (!options.inline && !scope.isAdmin) throw new Error('Permission denied: ingestion worker requires admin');
  if (options.inline && !options.memoryId) throw new Error('Inline claim requires memory id');
  const leaseMs = options.leaseMs ?? 150_000;
  for (;;) {
  const claimed = await withScopedClient(scope, async client => {
    if (!options.inline) {
      await client.query('SELECT app_ingestion_control(NULL, true)');
      const settings = await client.query('SELECT ingestion_paused FROM instance_settings WHERE singleton');
      if (settings.rows[0]?.ingestion_paused) return null;
    }
    const token = randomUUID();
    const job = (await client.query(`WITH candidate AS (
      SELECT j.memory_id FROM memory_ingestion_jobs j
      WHERE ($1::uuid IS NULL OR j.memory_id = $1)
        AND (($2 AND j.client_id = app_current_key_id()) OR NOT $2)
        AND ((j.status IN ('pending','retry_wait') AND j.next_attempt_at <= statement_timestamp())
          OR (j.status = 'processing' AND j.lease_expires_at < statement_timestamp()))
      ORDER BY j.next_attempt_at, j.accepted_at, j.memory_id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE memory_ingestion_jobs j SET status = 'processing',
      attempts = j.attempts + CASE WHEN $2 THEN 0 ELSE 1 END,
      locked_at = statement_timestamp(), lease_expires_at = statement_timestamp() + $3::double precision * interval '1 millisecond',
      lease_token = $4::uuid, inline_attempted = j.inline_attempted OR $2
    FROM candidate c WHERE j.memory_id = c.memory_id RETURNING j.*`,
    [options.memoryId ?? null, options.inline === true, leaseMs, token])).rows[0] as IngestionJob | undefined;
    return job ?? null;
  });
  if (!claimed) return null;
  const job = claimed;
  const loaded = await withScopedClient(ownerScope(job), async client => {
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
    if (memory.embedding !== null) {
      await completeExternalEmbedding(client, job, memory); return null;
    }
    return { ...job, content: memory.content, expires_at: memory.expires_at, inline: options.inline === true };
  });
  if (loaded || options.inline) return loaded;
  // Expired jobs are terminal bookkeeping, not evidence that the due queue is empty.
  }
}

export function classifyIngestionFailure(error: unknown): { category: FailureCategory; code: string; terminal: boolean; retryAfter?: string } {
  if (error instanceof EmbeddingValidationError || error instanceof SyntaxError) return { category: 'input_rejected', code: 'invalid_vector', terminal: true };
  if (error instanceof EmbeddingProviderError) {
    const status = error.status;
    const category: FailureCategory = status === 429 ? 'rate_limited' : status === 401 || status === 403 ? 'provider_auth' : [400,404,413,422].includes(status) ? 'input_rejected' : 'transient';
    return { category, code: `provider_http_${status}`, terminal: category === 'input_rejected', retryAfter: error.retryAfter };
  }
  // Error text can contain content, tokens and URLs. Never persist or emit it.
  return { category: 'transient', code: 'provider_unavailable', terminal: false };
}
export async function failIngestionJob(job: IngestionJob, error: unknown): Promise<void> {
  const failure = classifyIngestionFailure(error);
  const max = ingestionInteger(process.env.MEMORY_INGESTION_MAX_ATTEMPTS, 12, 'MEMORY_INGESTION_MAX_ATTEMPTS', 1, 1000);
  const terminal = !job.inline && (failure.terminal || (failure.category !== 'provider_auth' && job.attempts >= max));
  const retry = retryAtForAttempt(failure.category === 'provider_auth' ? 5 : Math.max(1, job.attempts), failure.retryAfter);
  await withScopedClient(ownerScope(job), client => client.query(`UPDATE memory_ingestion_jobs SET
    status = $3, failure_category = $4, last_error_code = $5, next_attempt_at = $6,
    finalized_at = CASE WHEN $7 THEN statement_timestamp() ELSE NULL END,
    lease_token = NULL, lease_expires_at = NULL
    WHERE memory_id = $1 AND status = 'processing' AND lease_token = $2::uuid AND lease_expires_at > statement_timestamp()`,
  [job.memory_id, job.lease_token, terminal ? 'embedding_failed' : 'retry_wait', failure.category, failure.code, retry, terminal]).then(() => undefined));
}

/** Lease row lock and token fence cover dedupe, belief mutation, vector, outbox and audit together. */
export async function finalizeIngestionJob(job: IngestionJob, embedding: EmbeddingResult, options: {
  deadlineAt?: number; contradictionPolicy?: ContradictionPolicy; prepareRevision?: typeof prepareBeliefRevision;
} = {}): Promise<StoreResult | null> {
  const scope = ownerScope(job);
  const vector = serializeEmbeddingVector(embedding.vector);
  const target = { provider: job.embedding_provider, model: job.embedding_model, dimensions: job.embedding_dimensions };
  const policy = options.contradictionPolicy ?? contradictionPolicyFromEnv();
  let preparedPredecessor: string | null = null;
  // Never hold a checked-out connection, row lock or dedupe lock across provider classification.
  if (job.contradiction_eligible && policy.mutationEnabled &&
      embeddingIdentity(target) === embeddingIdentity(ACTIVE_EMBEDDING_PROFILE) &&
      embeddingIdentity(target) === embeddingIdentity(embedding)) {
    const snapshot = await withScopedClient(scope, async client => (await client.query(`SELECT m.* FROM memories m
      JOIN memory_ingestion_jobs j ON j.memory_id = m.id
      WHERE m.id = $1 AND m.namespace = $2 AND m.content = $3 AND m.access_level = $4
        AND m.embedding IS NULL AND m.deleted_at IS NULL AND m.superseded_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
        AND j.status = 'processing' AND j.lease_token = $5 AND j.lease_expires_at > statement_timestamp()`,
      [job.memory_id, job.namespace, job.content, job.access_level, job.lease_token])).rows[0]);
    if (snapshot) {
      const remaining = options.deadlineAt === undefined ? policy.timeoutMs : options.deadlineAt - Date.now();
      if (remaining < 1) throw new DOMException('Inline budget exhausted', 'TimeoutError');
      preparedPredecessor = await (options.prepareRevision ?? prepareBeliefRevision)(semanticMemory(job, snapshot, vector), ownerAuth(job), {
        policy, timeoutMs: Math.min(policy.timeoutMs, remaining), allowMutation: true, excludeCandidateId: job.memory_id,
      });
    }
  }
  let shadow: (() => Promise<void>) | undefined;
  const result = await withCheckedOutClient(client => withScopedTransactionOnClient(client, scope, async client => {
    const fenced = await client.query(`SELECT * FROM memory_ingestion_jobs WHERE memory_id = $1 AND status = 'processing'
      AND lease_token = $2::uuid AND lease_expires_at > statement_timestamp() FOR UPDATE`, [job.memory_id, job.lease_token]);
    if (!fenced.rows.length) return null;
    const memory = (await client.query(`SELECT *, (expires_at IS NOT NULL AND expires_at <= statement_timestamp()) AS expired
      FROM memories WHERE id = $1 AND namespace = $2 FOR UPDATE`, [job.memory_id, job.namespace])).rows[0];
    if (!memory || memory.deleted_at || memory.expired) {
      await finishJob(client, job, 'cancelled', 'expired'); return null;
    }
    if (!job.allowed_namespaces.includes(job.namespace)) {
      await finishJob(client, job, 'cancelled'); return null;
    }
    if (memory.embedding !== null) return completeExternalEmbedding(client, job, memory);
    // A later synchronous writer must never receive an older content vector.
    if (memory.content !== job.content || memory.access_level !== job.access_level || memory.superseded_at || memory.consolidated_into_id) {
      await finishJob(client, job, 'cancelled'); return null;
    }
    if (embeddingIdentity(target) !== embeddingIdentity(ACTIVE_EMBEDDING_PROFILE) || embeddingIdentity(target) !== embeddingIdentity(embedding)) {
      await finishJob(client, job, 'embedding_failed', 'space_mismatch'); return null;
    }
    if (job.dedupe && job.ttl_seconds === null) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`memory-store-dedupe:${JSON.stringify([job.namespace, job.access_level])}`]);
      const match = (await client.query(`SELECT m.id, m.namespace, 1 - (m.embedding <=> $1::vector) AS similarity
        FROM memories m WHERE m.namespace = $2 AND COALESCE(m.access_level,'normal') = $3
          AND m.embedding IS NOT NULL AND m.embedding_provider = $4 AND m.embedding_model = $5 AND m.embedding_dimensions = $6
          AND m.id <> $7 AND m.source_key IS NULL AND m.document_id IS NULL AND m.deleted_at IS NULL
          AND m.expires_at IS NULL AND m.superseded_at IS NULL AND m.valid_to IS NULL
          AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp()) AND m.consolidated_into_id IS NULL
          AND m.memory_kind NOT IN ('document_chunk','episode_chunk')
        ORDER BY m.embedding <=> $1::vector ASC,
          calculate_relevance(m.relevance_base_score,m.decay_rate,m.accessed_at,m.access_count) DESC, m.created_at ASC, m.id ASC
        LIMIT 1 FOR UPDATE`, [vector, job.namespace, job.access_level, embedding.provider, embedding.model, embedding.dimensions, job.memory_id])).rows[0];
      const similarity = Number(match?.similarity ?? NaN);
      const threshold = MEMORY_DEDUPE_THRESHOLD;
      if (match && Number.isFinite(similarity) && similarity >= threshold) {
        await client.query(`UPDATE memories SET access_count = COALESCE(access_count,0) + 1,
          accessed_at = statement_timestamp(), last_boosted_at = statement_timestamp(), updated_at = statement_timestamp(),
          tags = ARRAY(SELECT value FROM unnest(COALESCE(memories.tags, ARRAY[]::text[]) || $2::text[])
            WITH ORDINALITY AS combined(value, position) GROUP BY value ORDER BY MIN(position)) WHERE id = $1`, [match.id, memory.tags]);
        await client.query('UPDATE memories SET deleted_at = statement_timestamp(), updated_at = statement_timestamp() WHERE id = $1', [job.memory_id]);
        await client.query(`UPDATE memory_ingestion_jobs SET status = 'deduplicated', canonical_memory_id = $3,
          similarity = $4, ready_at = statement_timestamp(), finalized_at = statement_timestamp(), lease_token = NULL,
          lease_expires_at = NULL, failure_category = NULL, last_error_code = NULL, inline_ready = $5
          WHERE memory_id = $1 AND lease_token = $2`, [job.memory_id, job.lease_token, match.id, similarity, job.inline === true]);
        await auditReady(client, job, true);
        return { id: match.id, namespace: match.namespace, expires_at: null, created: false, deduplicated: true,
          similarity, state: 'ready' as const, accepted_at: job.accepted_at };
      }
    }
    const semantic = semanticMemory(job, memory, vector);
    let revised = null;
    if (preparedPredecessor) {
      await client.query('SAVEPOINT ingestion_revision');
      try {
        revised = await commitAutomaticRevision(semantic, preparedPredecessor, ownerAuth(job), { id: job.memory_id, client });
      } catch (error) {
        if (!['23503','23505','23514','40001','40P01'].includes((error as { code?: string }).code ?? '')) throw error;
        await client.query('ROLLBACK TO SAVEPOINT ingestion_revision');
      }
      await client.query('RELEASE SAVEPOINT ingestion_revision');
    }
    if (!revised) await client.query(`UPDATE memories SET embedding = $2::vector, embedding_provider = $3,
      embedding_model = $4, embedding_dimensions = $5, updated_at = statement_timestamp() WHERE id = $1`,
    [job.memory_id, vector, embedding.provider, embedding.model, embedding.dimensions]);
    await client.query(`UPDATE memory_ingestion_jobs SET status = 'ready', ready_at = statement_timestamp(),
      finalized_at = statement_timestamp(), lease_token = NULL, lease_expires_at = NULL,
      failure_category = NULL, last_error_code = NULL, inline_ready = $3
      WHERE memory_id = $1 AND lease_token = $2`, [job.memory_id, job.lease_token, job.inline === true]);
    await auditReady(client, job, false);
    if (job.contradiction_eligible && !policy.mutationEnabled && policyAllowsScope(policy, job.namespace, job.access_level)) {
      shadow = () => maybeReviseBelief(semantic, ownerAuth(job), { policy, allowMutation: false, excludeCandidateId: job.memory_id }).then(() => undefined);
    }
    return { id: job.memory_id, namespace: job.namespace, expires_at: memory.expires_at ?? null,
      created: job.memory_created, deduplicated: false, state: 'ready' as const, accepted_at: job.accepted_at };
  }));
  if (shadow) scheduleShadowClassification(contradictionPolicyFromEnv(), shadow);
  return result;
}
async function completeExternalEmbedding(client: ScopedClient, job: IngestionJob, memory: Record<string, any>): Promise<StoreResult | null> {
  if (memory.embedding_provider !== job.embedding_provider || memory.embedding_model !== job.embedding_model ||
      memory.embedding_dimensions !== job.embedding_dimensions) {
    await finishJob(client, job, 'cancelled'); return null;
  }
  await client.query(`UPDATE memory_ingestion_jobs SET status = 'ready', ready_at = statement_timestamp(),
    finalized_at = statement_timestamp(), lease_token = NULL, lease_expires_at = NULL,
    failure_category = NULL, last_error_code = NULL WHERE memory_id = $1 AND lease_token = $2`, [job.memory_id, job.lease_token]);
  await auditReady(client, job, false);
  return { id: job.memory_id, namespace: job.namespace, expires_at: memory.expires_at ?? null,
    created: job.memory_created, deduplicated: false, state: 'ready', accepted_at: job.accepted_at };
}
function semanticMemory(job: IngestionJob, memory: Record<string, any>, vector: string): SemanticMemoryInsert {
  return { content: memory.content, vector, source: memory.source, namespace: memory.namespace,
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

export async function tryInlineIngestion(accepted: StoreResult, auth: AuthContext): Promise<StoreResult> {
  if (accepted.state === 'ready') return accepted;
  let job: IngestionJob | null = null;
  try {
    const budget = inlineBudgetMs();
    if (budget === 0) return accepted;
    job = await claimIngestionJob(dbScopeFromAuth(auth), { memoryId: accepted.id, inline: true, leaseMs: budget + 30_000 });
    if (!job) return accepted;
    const deadlineAt = Date.now() + budget;
    const remaining = deadlineAt - Date.now();
    if (remaining < 1) throw new DOMException('Inline budget exhausted', 'TimeoutError');
    const embedding = await embedWithinBudget(job.content, remaining);
    const ready = await finalizeIngestionJob(job, embedding, { deadlineAt });
    return ready ? { ...ready, ...(accepted.idempotency_key_honored ? { idempotency_key_honored: true } : {}) } : accepted;
  } catch (error) {
    // Acceptance already committed. Even a second DB failure must never undo its acknowledgement.
    if (job) { try { await failIngestionJob(job, error); } catch { /* Lease expiry recovers the job. */ } }
    console.warn('[ingestion] outcome=inline_deferred');
    return accepted;
  }
}
/** Race also bounds test/faulty providers which fail to honor AbortSignal. Late results never finalize. */
export async function embedWithinBudget(content: string, budget: number, embed = embedWithProfile, signal?: AbortSignal): Promise<EmbeddingResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  try {
    return await Promise.race([embed(content, ACTIVE_EMBEDDING_PROFILE, combined), new Promise<never>((_, reject) => {
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
        AND EXISTS (SELECT 1 FROM memories m WHERE m.id = j.memory_id AND m.deleted_at IS NULL
          AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())) RETURNING j.namespace`, [memoryId, auth.keyId]);
    if (!updated.rows.length) throw new MemoryConflictError('Ingestion job is unavailable or cannot be requeued in its current state');
    await logAudit({ clientId: auth.keyId, action: 'ingestion.requeue', namespace: updated.rows[0].namespace,
      memoryId, details: { requeued: true } }, dbScopeFromAuth(auth), client);
    return { requeued: true };
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
export async function ingestionStats(auth: AuthContext, existingClient?: ScopedClient) {
  checkPermission(auth, 'admin');
  const load = async (client: ScopedClient) => {
    const result = await client.query(`SELECT
      COALESCE((SELECT jsonb_object_agg(status, count) FROM (SELECT status, COUNT(*)::int AS count FROM memory_ingestion_jobs GROUP BY status) s), '{}'::jsonb) AS depth,
      EXTRACT(EPOCH FROM statement_timestamp() - MIN(accepted_at) FILTER (WHERE status IN ('pending','retry_wait','processing')))::double precision AS oldest_pending_age_seconds,
      MIN(next_attempt_at) FILTER (WHERE status = 'retry_wait') AS next_retry_at,
      COALESCE((SELECT jsonb_object_agg(attempts, count) FROM (SELECT attempts, COUNT(*)::int AS count FROM memory_ingestion_jobs GROUP BY attempts) a), '{}'::jsonb) AS attempts_histogram,
      COALESCE((SELECT jsonb_object_agg(failure_category, count) FROM (SELECT failure_category, COUNT(*)::int AS count FROM memory_ingestion_jobs WHERE failure_category IS NOT NULL GROUP BY failure_category) f), '{}'::jsonb) AS failure_categories,
      COUNT(*) FILTER (WHERE inline_ready)::double precision / NULLIF(COUNT(*) FILTER (WHERE inline_attempted),0) AS inline_hit_rate
      FROM memory_ingestion_jobs`);
    const settings = (await client.query('SELECT ingestion_paused AS paused, ingestion_worker_seen_at AS last_worker_heartbeat FROM instance_settings WHERE singleton')).rows[0];
    return { ...result.rows[0], ...settings };
  };
  return existingClient ? load(existingClient) : withScopedClient(dbScopeFromAuth(auth), load);
}
