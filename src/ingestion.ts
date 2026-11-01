/**
 * Durable write-ahead ingestion queue for memory_store (#157).
 *
 * Accepted content is a real `memories` row with a NULL embedding; the job row
 * in `memory_ingestion_jobs` (migration 037) carries only the state machine and
 * the immutable security/provenance snapshot a later finalizer needs. The same
 * finalize primitive runs in the request path (inline fast path) and in the
 * ingestion worker, so the semantics are identical regardless of where the
 * embedding was produced. Nothing in this module logs or embeds memory
 * content in SQL text, metrics, or error messages.
 */
import { logAudit } from './audit.js';
import {
  contradictionPolicyFromEnv,
  maybeReviseBelief,
  policyAllowsScope,
  scheduleShadowClassification,
  type ContradictionPolicy,
  type ContradictionReason,
  type SemanticMemoryInsert,
} from './contradictions.js';
import { withScopedClient, type DbScope, type ScopedClient } from './db.js';
import {
  ACTIVE_EMBEDDING_PROFILE,
  EmbeddingProviderError,
  embedWithProfile,
  serializeEmbeddingVector,
  type EmbeddingResult,
} from './embedding.js';
import { IngestionJobNotFoundError, IngestionJobStateConflictError } from './errors.js';
import { RETRY_DELAYS_SECONDS, retryAtForAttempt } from './retry.js';
import {
  boostDedupeCanonical,
  findDedupeCandidate,
  lockDedupeNamespace,
  MEMORY_DEDUPE_THRESHOLD,
} from './tools/store.js';
import type { AccessLevel, AuthContext } from './types.js';

// ---------------------------------------------------------------------------
// Configuration (fail-closed gate, validated numeric knobs)
// ---------------------------------------------------------------------------

/** Worker lease: a crashed finalizer's job is reclaimable after this long. */
export const INGESTION_LEASE_MS = 10 * 60 * 1_000;
/** Inline fast path lease: short because the embed is bounded by the inline budget. */
export const INGESTION_INLINE_LEASE_MS = 2 * 60 * 1_000;
export const DEFAULT_INLINE_EMBED_MS = 3_000;
export const MAX_INLINE_EMBED_MS = 120_000;
export const DEFAULT_INGESTION_MAX_ATTEMPTS = 12;
export const MAX_INGESTION_MAX_ATTEMPTS = 1_000;

/** Off means today's synchronous store path, byte for byte. */
export function ingestionQueueEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEMORY_INGESTION_QUEUE_ENABLED === 'true';
}

/** 0 means always async: accept, queue, never embed in the request. */
export function parseInlineEmbedBudgetMs(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return DEFAULT_INLINE_EMBED_MS;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`MEMORY_STORE_INLINE_EMBED_MS must be an integer from 0 to ${MAX_INLINE_EMBED_MS}`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value > MAX_INLINE_EMBED_MS) {
    throw new Error(`MEMORY_STORE_INLINE_EMBED_MS must be an integer from 0 to ${MAX_INLINE_EMBED_MS}`);
  }
  return value;
}

export function inlineEmbedBudgetMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return parseInlineEmbedBudgetMs(env.MEMORY_STORE_INLINE_EMBED_MS);
}

export function parseIngestionMaxAttempts(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return DEFAULT_INGESTION_MAX_ATTEMPTS;
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`MEMORY_INGESTION_MAX_ATTEMPTS must be an integer from 1 to ${MAX_INGESTION_MAX_ATTEMPTS}`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value > MAX_INGESTION_MAX_ATTEMPTS) {
    throw new Error(`MEMORY_INGESTION_MAX_ATTEMPTS must be an integer from 1 to ${MAX_INGESTION_MAX_ATTEMPTS}`);
  }
  return value;
}

export function ingestionMaxAttemptsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return parseIngestionMaxAttempts(env.MEMORY_INGESTION_MAX_ATTEMPTS);
}

// ---------------------------------------------------------------------------
// State machine and row types (strings match the migration 037 CHECKs exactly)
// ---------------------------------------------------------------------------

export const INGESTION_JOB_STATUSES = [
  'pending', 'processing', 'retry_wait', 'ready', 'deduplicated', 'embedding_failed', 'cancelled',
] as const;
export type IngestionJobStatus = typeof INGESTION_JOB_STATUSES[number];

export const INGESTION_FAILURE_CATEGORIES = [
  'transient', 'rate_limited', 'provider_auth', 'input_rejected', 'space_mismatch', 'expired',
] as const;
export type IngestionFailureCategory = typeof INGESTION_FAILURE_CATEGORIES[number];

export const INGESTION_JOB_KINDS = ['store', 'update', 'document'] as const;
export type IngestionJobKind = typeof INGESTION_JOB_KINDS[number];

/** Job statuses that still owe the caller an embedding. */
export const INGESTION_ACTIVE_STATUSES: readonly IngestionJobStatus[] = ['pending', 'processing', 'retry_wait'];

/** The state a caller sees: queued collapses the three in-flight statuses. */
export type IngestionPublicState = 'queued' | 'ready' | 'deduplicated' | 'embedding_failed' | 'cancelled';

/** What the store response reports immediately after acceptance. */
export type StoreIngestionState = 'ready' | 'queued';

export function publicIngestionState(status: IngestionJobStatus): IngestionPublicState {
  return status === 'pending' || status === 'processing' || status === 'retry_wait' ? 'queued' : status;
}

/**
 * Content-free status object read paths attach to a memory. Owners and admins
 * see this full shape; other readers in the namespace see `{ state }` only.
 */
export interface IngestionStatus {
  state: IngestionPublicState;
  accepted_at: string;
  ready_at: string | null;
  attempts: number;
  next_retry_at: string | null;
  failure_category: IngestionFailureCategory | null;
  canonical_memory_id: string | null;
  /** Cosine similarity to canonical_memory_id when the job deduplicated; null otherwise. */
  similarity: number | null;
}

/** A claimed job: the immutable snapshot plus the lease that authorizes finalization. */
export interface IngestionJob {
  memoryId: string;
  namespace: string;
  kind: IngestionJobKind;
  sourceRevision: number;
  documentId: string | null;
  chunkIndex: number | null;
  clientId: string;
  accessLevel: AccessLevel;
  allowedNamespaces: string[];
  agentId: string | null;
  sessionId: string | null;
  sourceKey: string | null;
  dedupe: boolean;
  ttlSeconds: number | null;
  contradictionEligible: boolean;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  status: IngestionJobStatus;
  attempts: number;
  nextAttemptAt: Date;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  acceptedAt: Date;
}

interface IngestionJobRow {
  memory_id: string;
  namespace: string;
  kind: IngestionJobKind;
  source_revision: number | string;
  document_id: string | null;
  chunk_index: number | null;
  client_id: string;
  access_level: string;
  allowed_namespaces: string[] | null;
  agent_id: string | null;
  session_id: string | null;
  source_key: string | null;
  dedupe: boolean;
  ttl_seconds: number | string | null;
  contradiction_eligible: boolean;
  embedding_provider: string;
  embedding_model: string;
  embedding_dimensions: number | string;
  status: IngestionJobStatus;
  attempts: number | string;
  next_attempt_at: Date;
  lease_token: string | null;
  lease_expires_at: Date | null;
  accepted_at: Date;
}

const JOB_COLUMNS = `j.memory_id, j.namespace, j.kind, j.source_revision, j.document_id, j.chunk_index,
    j.client_id, j.access_level, j.allowed_namespaces, j.agent_id, j.session_id, j.source_key,
    j.dedupe, j.ttl_seconds, j.contradiction_eligible,
    j.embedding_provider, j.embedding_model, j.embedding_dimensions,
    j.status, j.attempts, j.next_attempt_at, j.lease_token, j.lease_expires_at, j.accepted_at`;

function jobFromRow(row: IngestionJobRow): IngestionJob {
  return {
    memoryId: row.memory_id,
    namespace: row.namespace,
    kind: row.kind,
    sourceRevision: Number(row.source_revision ?? 0),
    documentId: row.document_id ?? null,
    chunkIndex: row.chunk_index ?? null,
    clientId: row.client_id,
    accessLevel: row.access_level as AccessLevel,
    allowedNamespaces: row.allowed_namespaces ?? [],
    agentId: row.agent_id ?? null,
    sessionId: row.session_id ?? null,
    sourceKey: row.source_key ?? null,
    dedupe: row.dedupe === true,
    ttlSeconds: row.ttl_seconds == null ? null : Number(row.ttl_seconds),
    contradictionEligible: row.contradiction_eligible === true,
    embeddingProvider: row.embedding_provider,
    embeddingModel: row.embedding_model,
    embeddingDimensions: Number(row.embedding_dimensions),
    status: row.status,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at,
    leaseToken: row.lease_token ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    acceptedAt: row.accepted_at,
  };
}

/** The exact RLS scope the original request had: one namespace, the owner's key, never admin. */
export function ingestionJobScope(job: Pick<IngestionJob, 'namespace' | 'clientId'>): DbScope {
  return { namespaces: [job.namespace], keyId: job.clientId };
}

/** A minimal AuthContext for contradiction primitives that take one. */
export function ingestionJobAuth(job: Pick<IngestionJob, 'namespace' | 'clientId' | 'accessLevel'>): AuthContext {
  return {
    keyId: job.clientId,
    name: 'ingestion',
    namespaces: [job.namespace],
    permissions: ['write'],
    maxAccessLevel: job.accessLevel,
  };
}

// ---------------------------------------------------------------------------
// Read-path helpers
// ---------------------------------------------------------------------------

export const INGESTION_JOB_ALIAS = 'ij';

/** LEFT JOIN read paths add to a memories query; RLS hides other owners' jobs. */
export function ingestionStatusJoinSql(memoryAlias = 'm', jobAlias = INGESTION_JOB_ALIAS): string {
  return `LEFT JOIN memory_ingestion_jobs ${jobAlias} ON ${jobAlias}.memory_id = ${memoryAlias}.id AND ${jobAlias}.namespace = ${memoryAlias}.namespace`;
}

/**
 * A jsonb IngestionStatus (or NULL) for one memory row. Owners and admins see
 * the full object; a reader in the namespace who cannot see the job row still
 * learns `state: 'queued'` from the missing vector, so a null embedding is
 * never unexplained. A row with a vector and no visible job yields NULL.
 *
 * `unembeddedSql` lets a caller whose row set no longer carries the vector
 * column (hybrid search projects it away) supply an equivalent boolean.
 */
export function ingestionStatusSelectSql(
  memoryAlias = 'm',
  jobAlias = INGESTION_JOB_ALIAS,
  unembeddedSql = `${memoryAlias}.embedding IS NULL`,
): string {
  const j = jobAlias;
  return `CASE
    WHEN ${j}.memory_id IS NOT NULL THEN jsonb_build_object(
      'state', ${ingestionPublicStateSql(j)},
      'accepted_at', ${j}.accepted_at,
      'ready_at', ${j}.ready_at,
      'attempts', ${j}.attempts,
      'next_retry_at', CASE WHEN ${j}.status = 'retry_wait' THEN ${j}.next_attempt_at ELSE NULL END,
      'failure_category', ${j}.failure_category,
      'canonical_memory_id', ${j}.canonical_memory_id,
      'similarity', ${j}.similarity)
    WHEN ${unembeddedSql} THEN jsonb_build_object('state', 'queued')
    ELSE NULL END`;
}

/** The public state alone as text (or NULL), for feeds that carry no nested object. */
export function ingestionStateSelectSql(
  memoryAlias = 'm',
  jobAlias = INGESTION_JOB_ALIAS,
  unembeddedSql = `${memoryAlias}.embedding IS NULL`,
): string {
  const j = jobAlias;
  return `CASE
    WHEN ${j}.memory_id IS NOT NULL THEN ${ingestionPublicStateSql(j)}
    WHEN ${unembeddedSql} THEN 'queued'
    ELSE NULL END`;
}

function ingestionPublicStateSql(jobAlias: string): string {
  return `CASE WHEN ${jobAlias}.status IN ('pending', 'processing', 'retry_wait') THEN 'queued' ELSE ${jobAlias}.status END`;
}

/** The same object built in process from a job row (for callers that already hold one). */
export function ingestionStatusFromJob(job: {
  status: IngestionJobStatus;
  accepted_at: Date | string;
  ready_at: Date | string | null;
  attempts: number | string;
  next_attempt_at: Date | string | null;
  failure_category: IngestionFailureCategory | null;
  canonical_memory_id: string | null;
  similarity?: number | string | null;
}): IngestionStatus {
  return {
    state: publicIngestionState(job.status),
    accepted_at: isoString(job.accepted_at)!,
    ready_at: isoString(job.ready_at),
    attempts: Number(job.attempts),
    next_retry_at: job.status === 'retry_wait' ? isoString(job.next_attempt_at) : null,
    failure_category: job.failure_category ?? null,
    canonical_memory_id: job.canonical_memory_id ?? null,
    similarity: job.similarity == null ? null : Number(job.similarity),
  };
}

function isoString(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

/** The immutable snapshot written to the job row at acceptance. */
export interface IngestionJobSnapshot {
  memoryId: string;
  namespace: string;
  kind?: IngestionJobKind;
  sourceRevision?: number;
  documentId?: string | null;
  chunkIndex?: number | null;
  clientId: string;
  accessLevel: AccessLevel;
  allowedNamespaces: readonly string[];
  agentId: string | null;
  sessionId: string | null;
  sourceKey: string | null;
  dedupe: boolean;
  ttlSeconds: number | null;
  contradictionEligible: boolean;
}

export interface AcceptMemoryInput {
  content: string;
  source: string;
  namespace: string;
  tags: string[];
  metadata: Record<string, unknown>;
  accessLevel: AccessLevel;
  clientId: string;
  /** The key's namespaces at acceptance; snapshotted for the keyed-store guard. */
  allowedNamespaces: readonly string[];
  agentId: string;
  sessionId: string | null;
  ttlSeconds: number | null;
  dedupe: boolean;
  contradictionEligible: boolean;
}

export interface AcceptedMemory {
  id: string;
  namespace: string;
  expires_at: Date | null;
  accepted_at: Date;
}

/**
 * Insert or reset the job row for an accepted memory. A conflict (the keyed
 * store replacing content on an existing memory) resets the state machine to
 * a fresh pending job with zero attempts and a new acceptance time.
 */
export async function enqueueIngestionJob(
  client: ScopedClient,
  snapshot: IngestionJobSnapshot,
): Promise<{ memory_id: string; accepted_at: Date }> {
  const result = await client.query<{ memory_id: string; accepted_at: Date }>(
    `INSERT INTO memory_ingestion_jobs (
       memory_id, namespace, kind, source_revision, document_id, chunk_index,
       client_id, access_level, allowed_namespaces, agent_id, session_id, source_key,
       dedupe, ttl_seconds, contradiction_eligible,
       embedding_provider, embedding_model, embedding_dimensions
     ) VALUES (
       $1::uuid, $2, $3, $4, $5::uuid, $6,
       $7, $8, $9::text[], $10::uuid, $11, $12,
       $13, $14::bigint, $15,
       $16, $17, $18
     )
     ON CONFLICT (memory_id) DO UPDATE SET
       namespace = EXCLUDED.namespace,
       kind = EXCLUDED.kind,
       source_revision = EXCLUDED.source_revision,
       document_id = EXCLUDED.document_id,
       chunk_index = EXCLUDED.chunk_index,
       client_id = EXCLUDED.client_id,
       access_level = EXCLUDED.access_level,
       allowed_namespaces = EXCLUDED.allowed_namespaces,
       agent_id = EXCLUDED.agent_id,
       session_id = EXCLUDED.session_id,
       source_key = EXCLUDED.source_key,
       dedupe = EXCLUDED.dedupe,
       ttl_seconds = EXCLUDED.ttl_seconds,
       contradiction_eligible = EXCLUDED.contradiction_eligible,
       embedding_provider = EXCLUDED.embedding_provider,
       embedding_model = EXCLUDED.embedding_model,
       embedding_dimensions = EXCLUDED.embedding_dimensions,
       status = 'pending', attempts = 0, next_attempt_at = statement_timestamp(),
       locked_at = NULL, lease_expires_at = NULL, lease_token = NULL,
       last_error_code = NULL, failure_category = NULL,
       accepted_at = statement_timestamp(), ready_at = NULL, finalized_at = NULL,
       canonical_memory_id = NULL, similarity = NULL,
       requeued_by = NULL, requeued_at = NULL
     RETURNING memory_id, accepted_at`,
    [
      snapshot.memoryId,
      snapshot.namespace,
      snapshot.kind ?? 'store',
      snapshot.sourceRevision ?? 0,
      snapshot.documentId ?? null,
      snapshot.chunkIndex ?? null,
      snapshot.clientId,
      snapshot.accessLevel,
      [...snapshot.allowedNamespaces],
      snapshot.agentId,
      snapshot.sessionId,
      snapshot.sourceKey,
      snapshot.dedupe,
      snapshot.ttlSeconds,
      snapshot.contradictionEligible,
      ACTIVE_EMBEDDING_PROFILE.provider,
      ACTIVE_EMBEDDING_PROFILE.model,
      ACTIVE_EMBEDDING_PROFILE.dimensions,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Ingestion job row was not written');
  return row;
}

/**
 * Durable acceptance of an unkeyed store: the memories row with a NULL
 * embedding and no identity columns (CHECK-compliant), the job row, and the
 * memory.store audit row, all on the caller's scoped transaction. Never calls
 * the embedding provider. TTL starts here, at acceptance.
 */
export async function acceptMemory(client: ScopedClient, input: AcceptMemoryInput): Promise<AcceptedMemory> {
  const inserted = await client.query<{ id: string; namespace: string; expires_at: Date | null; created_at: Date }>(
    `INSERT INTO memories (content, embedding, source, namespace, tags, metadata, access_level, client_id, agent_id, session_id, embedding_provider, embedding_model, embedding_dimensions, memory_kind, valid_from, expires_at)
     VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'semantic', statement_timestamp(),
       CASE WHEN $14::bigint IS NULL THEN NULL ELSE statement_timestamp() + $14::double precision * interval '1 second' END)
     RETURNING id, namespace, expires_at, created_at`,
    [
      input.content,
      null,
      input.source,
      input.namespace,
      input.tags,
      JSON.stringify(input.metadata),
      input.accessLevel,
      input.clientId,
      input.agentId,
      input.sessionId,
      null,
      null,
      null,
      input.ttlSeconds,
    ],
  );
  const memory = inserted.rows[0];
  if (!memory) throw new Error('Accepted memory row was not written');
  const job = await enqueueIngestionJob(client, {
    memoryId: memory.id,
    namespace: memory.namespace,
    kind: 'store',
    clientId: input.clientId,
    accessLevel: input.accessLevel,
    allowedNamespaces: input.allowedNamespaces,
    agentId: input.agentId,
    sessionId: input.sessionId,
    sourceKey: null,
    dedupe: input.dedupe,
    ttlSeconds: input.ttlSeconds,
    contradictionEligible: input.contradictionEligible,
  });
  await logAudit({
    clientId: input.clientId, action: 'memory.store', namespace: memory.namespace,
    memoryId: memory.id, resourceType: 'memory', resourceId: memory.id,
    agentId: input.agentId, sessionId: input.sessionId ?? undefined,
    details: { created: true, deduplicated: false, queued: true },
  }, { namespaces: [...input.allowedNamespaces], keyId: input.clientId }, client);
  return {
    id: memory.id,
    namespace: memory.namespace,
    expires_at: memory.expires_at ?? null,
    accepted_at: job.accepted_at ?? memory.created_at,
  };
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

export interface ClaimIngestionJobOptions {
  /** Lease length; an expired lease makes a processing row reclaimable. */
  leaseMs?: number;
}

function leaseMilliseconds(leaseMs: number | undefined, fallback: number): number {
  const value = leaseMs ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 24 * 60 * 60 * 1_000) {
    throw new Error('Ingestion lease must be an integer number of milliseconds from 1000 to 86400000');
  }
  return value;
}

/**
 * Worker claim (migration 028 pattern): one eligible job, oldest first, with
 * FOR UPDATE SKIP LOCKED; processing rows whose lease has expired are
 * reclaimed. Each claim counts as an attempt and issues a fresh lease token.
 * The returned job never carries content.
 */
export async function claimIngestionJob(
  client: ScopedClient,
  options: ClaimIngestionJobOptions = {},
): Promise<IngestionJob | null> {
  const leaseMs = leaseMilliseconds(options.leaseMs, INGESTION_LEASE_MS);
  const result = await client.query<IngestionJobRow>(
    `WITH candidate AS (
       SELECT j.memory_id
       FROM memory_ingestion_jobs j
       WHERE ((j.status IN ('pending', 'retry_wait') AND j.next_attempt_at <= statement_timestamp())
         OR (j.status = 'processing' AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at < statement_timestamp()))
       ORDER BY j.next_attempt_at, j.accepted_at, j.memory_id
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE memory_ingestion_jobs j
     SET status = 'processing', attempts = j.attempts + 1, lease_token = gen_random_uuid(),
         locked_at = statement_timestamp(),
         lease_expires_at = statement_timestamp() + ($1::int * interval '1 millisecond'),
         last_error_code = NULL
     FROM candidate
     WHERE j.memory_id = candidate.memory_id
     RETURNING ${JOB_COLUMNS}`,
    [leaseMs],
  );
  const row = result.rows[0];
  return row ? jobFromRow(row) : null;
}

/**
 * Inline fast path claim under the owner's own scope: only a fresh pending
 * job, no attempt counted, short lease. Null means the worker got there first
 * or the job is no longer pending.
 */
export async function claimOwnedIngestionJob(
  client: ScopedClient,
  memoryId: string,
  options: ClaimIngestionJobOptions = {},
): Promise<IngestionJob | null> {
  const leaseMs = leaseMilliseconds(options.leaseMs, INGESTION_INLINE_LEASE_MS);
  const result = await client.query<IngestionJobRow>(
    `UPDATE memory_ingestion_jobs j
     SET status = 'processing', lease_token = gen_random_uuid(),
         locked_at = statement_timestamp(),
         lease_expires_at = statement_timestamp() + ($2::int * interval '1 millisecond')
     WHERE j.memory_id = $1::uuid AND j.status = 'pending'
     RETURNING ${JOB_COLUMNS}`,
    [memoryId, leaseMs],
  );
  const row = result.rows[0];
  return row ? jobFromRow(row) : null;
}

export type IngestionJobSource =
  | { available: true; content: string }
  | { available: false; reason: 'expired' | 'deleted' | 'missing' | 'stale_lease' };

/**
 * Read the accepted content for a claimed job under the owner scope. Content
 * is returned only when the memory is still live and the lease is still ours;
 * every other outcome is a content-free reason.
 */
export async function loadIngestionJobContent(client: ScopedClient, job: IngestionJob): Promise<IngestionJobSource> {
  requireLease(job);
  const result = await client.query<{ content: string | null; missing: boolean; deleted: boolean; expired: boolean }>(
    `SELECT m.content,
            m.id IS NULL AS missing,
            m.deleted_at IS NOT NULL AS deleted,
            (m.expires_at IS NOT NULL AND m.expires_at <= statement_timestamp()) AS expired
     FROM memory_ingestion_jobs j
     LEFT JOIN memories m ON m.id = j.memory_id AND m.namespace = j.namespace
     WHERE j.memory_id = $1::uuid AND j.status = 'processing' AND j.lease_token = $2::uuid`,
    [job.memoryId, job.leaseToken],
  );
  const row = result.rows[0];
  if (!row) return { available: false, reason: 'stale_lease' };
  if (row.missing || row.content == null) return { available: false, reason: 'missing' };
  if (row.deleted) return { available: false, reason: 'deleted' };
  if (row.expired) return { available: false, reason: 'expired' };
  return { available: true, content: row.content };
}

function requireLease(job: IngestionJob): string {
  if (!job.leaseToken) throw new Error('Ingestion job has no lease; claim it before finalizing');
  return job.leaseToken;
}

// ---------------------------------------------------------------------------
// Finalization (shared by the request path and the worker)
// ---------------------------------------------------------------------------

export interface FinalizeIngestionOptions {
  /** Defaults to MEMORY_DEDUPE_THRESHOLD. */
  dedupeThreshold?: number;
  contradictionPolicy?: ContradictionPolicy;
  reviseBelief?: typeof maybeReviseBelief;
  contradictionMetric?: (reason: ContradictionReason) => void;
}

export type FinalizeIngestionResult =
  | {
      outcome: 'ready';
      id: string;
      namespace: string;
      expires_at: Date | null;
      ready_at: Date;
      /** True when a contradiction revision landed the row as a successor. */
      revised: boolean;
      /** Shadow classification to schedule after commit, when the policy asks for one. */
      shadowTask?: () => Promise<void>;
      shadowPolicy?: ContradictionPolicy;
    }
  | {
      outcome: 'deduplicated';
      /** The canonical memory the accepted content collapsed into. */
      id: string;
      namespace: string;
      expires_at: Date | null;
      similarity: number;
      ready_at: Date;
    }
  | { outcome: 'cancelled'; reason: 'expired' | 'deleted' | 'missing' }
  | { outcome: 'space_mismatch' }
  /** Lease lost (expired and reclaimed, or already finalized): nothing changed. */
  | { outcome: 'stale' };

/**
 * Land an embedding for a claimed job in one scoped transaction. The caller
 * opens the transaction with `ingestionJobScope(job)` and passes its client.
 * Every write is guarded by `status = 'processing' AND lease_token = $token`,
 * so a finalizer that wakes after its lease was reclaimed is a no-op.
 */
export async function finalizeIngestionJob(
  client: ScopedClient,
  job: IngestionJob,
  embedding: EmbeddingResult,
  options: FinalizeIngestionOptions = {},
): Promise<FinalizeIngestionResult> {
  const token = requireLease(job);
  const locked = await client.query<IngestionJobRow>(
    `SELECT ${JOB_COLUMNS}
     FROM memory_ingestion_jobs j
     WHERE j.memory_id = $1::uuid AND j.status = 'processing' AND j.lease_token = $2::uuid
     FOR UPDATE`,
    [job.memoryId, token],
  );
  if (locked.rows.length !== 1) return { outcome: 'stale' };
  const current = jobFromRow(locked.rows[0]);

  // 1. Never finalize into a different vector space than the one accepted.
  if (!sameEmbeddingSpace(current, embedding) || !sameEmbeddingSpace(current, ACTIVE_EMBEDDING_PROFILE)) {
    await client.query(
      `UPDATE memory_ingestion_jobs
       SET status = 'embedding_failed', failure_category = 'space_mismatch', last_error_code = 'space_mismatch',
           finalized_at = statement_timestamp(), locked_at = NULL, lease_expires_at = NULL, lease_token = NULL
       WHERE memory_id = $1::uuid AND status = 'processing' AND lease_token = $2::uuid`,
      [job.memoryId, token],
    );
    emitIngestionMetric('space_mismatch');
    return { outcome: 'space_mismatch' };
  }
  const vector = serializeEmbeddingVector(embedding.vector);
  if (embedding.vector.length !== current.embeddingDimensions) {
    throw new Error(`Embedding length ${embedding.vector.length} does not match the accepted ${current.embeddingDimensions}`);
  }

  // 2. Lock the accepted row; expired or forgotten content is cancelled, never embedded.
  const memoryRows = await client.query<{
    id: string; namespace: string; content: string; source: string; tags: string[] | null;
    metadata: Record<string, unknown> | null; expires_at: Date | null; deleted: boolean; expired: boolean;
  }>(
    `SELECT m.id, m.namespace, m.content, m.source, m.tags, m.metadata, m.expires_at,
            m.deleted_at IS NOT NULL AS deleted,
            (m.expires_at IS NOT NULL AND m.expires_at <= statement_timestamp()) AS expired
     FROM memories m
     WHERE m.id = $1::uuid AND m.namespace = $2
     FOR UPDATE`,
    [current.memoryId, current.namespace],
  );
  const memory = memoryRows.rows[0];
  if (!memory) return cancel(client, current, 'missing');
  if (memory.deleted) return cancel(client, current, 'deleted');
  if (memory.expired) return cancel(client, current, 'expired');
  const tags = memory.tags ?? [];

  // 3. Semantic dedupe, exactly as the synchronous store does it, excluding ourselves.
  if (current.dedupe && current.ttlSeconds === null) {
    await lockDedupeNamespace(client, current.namespace, current.accessLevel);
    const match = await findDedupeCandidate(client, {
      vector,
      namespace: current.namespace,
      accessLevel: current.accessLevel,
      descriptor: [current.embeddingProvider, current.embeddingModel, current.embeddingDimensions],
      excludeId: current.memoryId,
    });
    const threshold = options.dedupeThreshold ?? MEMORY_DEDUPE_THRESHOLD;
    if (match && Number.isFinite(match.similarity) && match.similarity >= threshold) {
      const boosted = await boostDedupeCanonical(client, match.id, tags);
      if (!boosted) throw new Error('Dedupe candidate changed while the namespace lock was held');
      const tombstoned = await client.query(
        `UPDATE memories
         SET deleted_at = statement_timestamp(),
             deletion_reason = 'ingestion_deduplicated',
             updated_at = statement_timestamp()
         WHERE id = $1::uuid AND namespace = $2 AND deleted_at IS NULL`,
        [current.memoryId, current.namespace],
      );
      if (tombstoned.rowCount !== 1) throw new Error('Accepted memory changed while deduplicating');
      const done = await client.query<{ ready_at: Date }>(
        `UPDATE memory_ingestion_jobs
         SET status = 'deduplicated', canonical_memory_id = $3::uuid, similarity = $4,
             ready_at = statement_timestamp(), finalized_at = statement_timestamp(),
             locked_at = NULL, lease_expires_at = NULL, lease_token = NULL,
             last_error_code = NULL, failure_category = NULL
         WHERE memory_id = $1::uuid AND status = 'processing' AND lease_token = $2::uuid
         RETURNING ready_at`,
        [current.memoryId, token, boosted.id, match.similarity],
      );
      if (done.rows.length !== 1) throw new Error('Ingestion lease was lost during finalization');
      await logAudit({
        clientId: current.clientId, action: 'memory.ingest.deduplicated', namespace: current.namespace,
        memoryId: current.memoryId, resourceType: 'memory', resourceId: boosted.id,
        agentId: current.agentId ?? undefined, sessionId: current.sessionId ?? undefined,
        details: { created: false, deduplicated: true, attempts: current.attempts },
      }, ingestionJobScope(current), client);
      emitIngestionMetric('deduplicated');
      return {
        outcome: 'deduplicated',
        id: boosted.id,
        namespace: boosted.namespace,
        expires_at: boosted.expires_at ?? null,
        similarity: match.similarity,
        ready_at: done.rows[0].ready_at,
      };
    }
  }

  // 4. Contradiction revision in place, or the plain landing.
  const policy = current.contradictionEligible
    ? (options.contradictionPolicy ?? contradictionPolicyFromEnv())
    : undefined;
  const semanticMemory: SemanticMemoryInsert = {
    content: memory.content,
    vector,
    source: memory.source,
    namespace: current.namespace,
    tags,
    metadata: memory.metadata ?? {},
    accessLevel: current.accessLevel,
    clientId: current.clientId,
    agentId: current.agentId,
    sessionId: current.sessionId,
  };
  const auth = ingestionJobAuth(current);
  const reviseBelief = options.reviseBelief ?? maybeReviseBelief;
  let revised = false;
  if (policy?.mutationEnabled) {
    const revision = await reviseBelief(semanticMemory, auth, {
      policy,
      allowMutation: true,
      finalizeExistingId: current.memoryId,
      client,
      metric: options.contradictionMetric,
    });
    revised = revision !== null;
  }
  if (!revised) {
    const landed = await client.query<{ id: string }>(
      `UPDATE memories
       SET embedding = $1::vector,
           embedding_provider = $2,
           embedding_model = $3,
           embedding_dimensions = $4,
           updated_at = statement_timestamp()
       WHERE id = $5::uuid AND namespace = $6 AND deleted_at IS NULL
       RETURNING id`,
      [vector, current.embeddingProvider, current.embeddingModel, current.embeddingDimensions, current.memoryId, current.namespace],
    );
    if (landed.rows.length !== 1) throw new Error('Accepted memory changed while landing its embedding');
  }
  const ready = await client.query<{ ready_at: Date }>(
    `UPDATE memory_ingestion_jobs
     SET status = 'ready', ready_at = statement_timestamp(), finalized_at = statement_timestamp(),
         locked_at = NULL, lease_expires_at = NULL, lease_token = NULL,
         last_error_code = NULL, failure_category = NULL
     WHERE memory_id = $1::uuid AND status = 'processing' AND lease_token = $2::uuid
     RETURNING ready_at`,
    [current.memoryId, token],
  );
  if (ready.rows.length !== 1) throw new Error('Ingestion lease was lost during finalization');
  await logAudit({
    clientId: current.clientId, action: 'memory.ingest.ready', namespace: current.namespace,
    memoryId: current.memoryId, resourceType: 'memory', resourceId: current.memoryId,
    agentId: current.agentId ?? undefined, sessionId: current.sessionId ?? undefined,
    details: { created: true, deduplicated: false, attempts: current.attempts },
  }, ingestionJobScope(current), client);
  emitIngestionMetric(revised ? 'revised' : 'ready');

  const result: FinalizeIngestionResult = {
    outcome: 'ready',
    id: current.memoryId,
    namespace: current.namespace,
    expires_at: memory.expires_at ?? null,
    ready_at: ready.rows[0].ready_at,
    revised,
  };
  // Shadow classification keeps its post-commit scheduling, excluding the
  // finalized id. The closure keeps content out of the result object.
  if (policy && !policy.mutationEnabled && !revised &&
      policyAllowsScope(policy, current.namespace, current.accessLevel)) {
    const metric = options.contradictionMetric;
    result.shadowPolicy = policy;
    result.shadowTask = () => reviseBelief(semanticMemory, auth, {
      policy,
      allowMutation: false,
      excludeCandidateId: current.memoryId,
      metric,
    }).then(() => undefined);
  }
  return result;
}

/** Schedule the shadow classification a finalize result asked for, after commit. */
export function scheduleIngestionShadow(
  result: FinalizeIngestionResult,
  options: {
    scheduleShadow?: (task: () => Promise<void>) => void;
    contradictionMetric?: (reason: ContradictionReason) => void;
  } = {},
): boolean {
  if (result.outcome !== 'ready' || !result.shadowTask || !result.shadowPolicy) return false;
  if (options.scheduleShadow) {
    options.scheduleShadow(result.shadowTask);
    return true;
  }
  return scheduleShadowClassification(result.shadowPolicy, result.shadowTask, options.contradictionMetric);
}

function sameEmbeddingSpace(
  job: Pick<IngestionJob, 'embeddingProvider' | 'embeddingModel' | 'embeddingDimensions'>,
  identity: { provider: string; model: string; dimensions: number },
): boolean {
  return job.embeddingProvider === identity.provider &&
    job.embeddingModel === identity.model &&
    job.embeddingDimensions === identity.dimensions;
}

async function cancel(
  client: ScopedClient,
  job: IngestionJob,
  reason: 'expired' | 'deleted' | 'missing',
): Promise<FinalizeIngestionResult> {
  await cancelIngestionJob(client, job, reason);
  return { outcome: 'cancelled', reason };
}

/**
 * Cancel a claimed job whose memory can no longer be finalized. An expired
 * TTL is a real failure category; a forgotten or missing memory is not.
 */
export async function cancelIngestionJob(
  client: ScopedClient,
  job: IngestionJob,
  reason: 'expired' | 'deleted' | 'missing',
): Promise<boolean> {
  const token = requireLease(job);
  const result = await client.query(
    `UPDATE memory_ingestion_jobs
     SET status = 'cancelled', failure_category = $3, last_error_code = $4,
         finalized_at = statement_timestamp(), locked_at = NULL, lease_expires_at = NULL, lease_token = NULL
     WHERE memory_id = $1::uuid AND status = 'processing' AND lease_token = $2::uuid`,
    [job.memoryId, token, reason === 'expired' ? 'expired' : null, `memory_${reason}`],
  );
  emitIngestionMetric(`cancelled_${reason}`);
  return result.rowCount === 1;
}

// ---------------------------------------------------------------------------
// Failure classification and retry
// ---------------------------------------------------------------------------

export interface EmbeddingErrorClassification {
  category: IngestionFailureCategory;
  /** Content-free code matching the job table's last_error_code constraint. */
  errorCode: string;
  retryAfter: string | undefined;
  /** True means never retry: the input itself was rejected. */
  terminal: boolean;
}

const VECTOR_VALIDATION_MESSAGE =
  /embedding (?:response did not contain|length \d+ does not match|value at index \d+ must be finite)|Batch embedding (?:response did not contain|count \d+ does not match)/;
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME']);
/** The job table's last_error_code CHECK (migrations 028/029/037). */
const ERROR_CODE_PATTERN = /^[a-z0-9_.-]{1,64}$/;

/**
 * Typed classification of an embedding failure. Provider responses carry an
 * HTTP status (EmbeddingProviderError); timeouts, aborts and socket failures
 * surface as DOMException or fetch TypeError; vector validation is a plain
 * Error. Nothing from the error message reaches the job row.
 */
export function classifyEmbeddingError(error: unknown): EmbeddingErrorClassification {
  if (error instanceof EmbeddingProviderError) {
    const status = error.status;
    const errorCode = `http_${status}`;
    if (status === 429) return { category: 'rate_limited', errorCode, retryAfter: error.retryAfter, terminal: false };
    if (status === 401 || status === 403) return { category: 'provider_auth', errorCode, retryAfter: undefined, terminal: false };
    if (status === 400 || status === 404 || status === 413 || status === 422) {
      return { category: 'input_rejected', errorCode, retryAfter: undefined, terminal: true };
    }
    // 408/425/5xx and any unlisted status: retry with backoff, bounded by max attempts.
    return { category: 'transient', errorCode, retryAfter: error.retryAfter, terminal: false };
  }
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  if (name === 'TimeoutError') return { category: 'transient', errorCode: 'provider_timeout', retryAfter: undefined, terminal: false };
  if (name === 'AbortError') return { category: 'transient', errorCode: 'aborted', retryAfter: undefined, terminal: false };
  if (error instanceof TypeError) {
    const cause = (error as TypeError & { cause?: unknown }).cause;
    const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : '';
    if (DNS_CODES.has(code)) return { category: 'transient', errorCode: 'dns_error', retryAfter: undefined, terminal: false };
    return { category: 'transient', errorCode: code ? 'connection_error' : 'network_error', retryAfter: undefined, terminal: false };
  }
  if (error instanceof Error && VECTOR_VALIDATION_MESSAGE.test(error.message)) {
    return { category: 'input_rejected', errorCode: 'invalid_vector', retryAfter: undefined, terminal: true };
  }
  return { category: 'transient', errorCode: 'embed_error', retryAfter: undefined, terminal: false };
}

export interface FailIngestionJobOptions {
  /** Defaults to MEMORY_INGESTION_MAX_ATTEMPTS. */
  maxAttempts?: number;
  now?: Date;
  /**
   * Content-free code that replaces the classified one, for a failure after
   * the embed itself succeeded (the worker records a finalize exception as
   * 'finalize_error'). The category and retry schedule still come from the
   * classification, so the bounded backoff and attempt cap apply.
   */
  errorCode?: string;
}

export interface IngestionFailureOutcome {
  /** False when the lease was no longer ours; nothing changed. */
  applied: boolean;
  classification: EmbeddingErrorClassification;
  status: 'retry_wait' | 'embedding_failed';
  nextAttemptAt: Date | null;
}

/**
 * Record a failed attempt for a claimed job. Retryable classes go to
 * retry_wait with the shared bounded backoff (Retry-After honored, 12h cap,
 * provider_auth always at the cap); input rejections and exhausted attempts
 * become embedding_failed with the content left intact and visible.
 */
export async function failIngestionJob(
  client: ScopedClient,
  job: IngestionJob,
  error: unknown,
  options: FailIngestionJobOptions = {},
): Promise<IngestionFailureOutcome> {
  const token = requireLease(job);
  const classified = classifyEmbeddingError(error);
  if (options.errorCode !== undefined && !ERROR_CODE_PATTERN.test(options.errorCode)) {
    throw new Error('Invalid content-free ingestion error code');
  }
  const classification: EmbeddingErrorClassification = options.errorCode === undefined
    ? classified
    : { ...classified, errorCode: options.errorCode };
  const maxAttempts = options.maxAttempts ?? ingestionMaxAttemptsFromEnv();
  const now = options.now ?? new Date();
  const exhausted = job.attempts >= maxAttempts;
  const status: 'retry_wait' | 'embedding_failed' = classification.terminal || exhausted ? 'embedding_failed' : 'retry_wait';
  let nextAttemptAt: Date | null = null;
  if (status === 'retry_wait') {
    nextAttemptAt = classification.category === 'provider_auth'
      ? retryAtForAttempt(RETRY_DELAYS_SECONDS.length, undefined, now)
      : retryAtForAttempt(job.attempts, classification.retryAfter, now);
  }
  const result = await client.query(
    `UPDATE memory_ingestion_jobs
     SET status = $3,
         next_attempt_at = COALESCE($4::timestamptz, next_attempt_at),
         last_error_code = $5,
         failure_category = $6,
         finalized_at = CASE WHEN $3 = 'embedding_failed' THEN statement_timestamp() ELSE NULL END,
         locked_at = NULL, lease_expires_at = NULL, lease_token = NULL
     WHERE memory_id = $1::uuid AND status = 'processing' AND lease_token = $2::uuid`,
    [job.memoryId, token, status, nextAttemptAt, classification.errorCode, classification.category],
  );
  const applied = result.rowCount === 1;
  emitIngestionMetric(applied ? `${status}_${classification.category}` : 'stale');
  return { applied, classification, status, nextAttemptAt };
}

/**
 * Give an inline-claimed job back to the worker without counting an attempt:
 * only the content-free error code is recorded and the job returns to pending.
 */
export async function releaseIngestionJob(
  client: ScopedClient,
  job: IngestionJob,
  failure: { errorCode: string; category: IngestionFailureCategory | null },
): Promise<boolean> {
  const token = requireLease(job);
  if (!ERROR_CODE_PATTERN.test(failure.errorCode)) throw new Error('Invalid content-free ingestion error code');
  const result = await client.query(
    `UPDATE memory_ingestion_jobs
     SET status = 'pending', last_error_code = $3, failure_category = $4,
         locked_at = NULL, lease_expires_at = NULL, lease_token = NULL
     WHERE memory_id = $1::uuid AND status = 'processing' AND lease_token = $2::uuid`,
    [job.memoryId, token, failure.errorCode, failure.category],
  );
  return result.rowCount === 1;
}

// ---------------------------------------------------------------------------
// Administration: requeue, pause, heartbeat, stats
// ---------------------------------------------------------------------------

export interface RequeuedIngestionJob {
  memory_id: string;
  namespace: string;
  previous_status: IngestionJobStatus;
  previous_attempts: number;
  requeued_at: Date;
}

/**
 * Reset a terminal failed or cancelled job to pending with zero attempts.
 * A job that is ready, deduplicated or still in flight is a 409; an invisible
 * or missing job is a 404. The ingestion.requeue audit row is content-free.
 */
export async function requeueIngestionJob(
  client: ScopedClient,
  memoryId: string,
  actor: { keyId: string },
): Promise<RequeuedIngestionJob> {
  const existing = await client.query<{ memory_id: string; namespace: string; status: IngestionJobStatus; attempts: number | string }>(
    `SELECT j.memory_id, j.namespace, j.status, j.attempts
     FROM memory_ingestion_jobs j
     WHERE j.memory_id = $1::uuid
     FOR UPDATE`,
    [memoryId],
  );
  const job = existing.rows[0];
  if (!job) throw new IngestionJobNotFoundError();
  if (job.status !== 'embedding_failed' && job.status !== 'cancelled') {
    throw new IngestionJobStateConflictError(job.status);
  }
  const requeued = await client.query<{ requeued_at: Date }>(
    `UPDATE memory_ingestion_jobs
     SET status = 'pending', attempts = 0, next_attempt_at = statement_timestamp(),
         locked_at = NULL, lease_expires_at = NULL, lease_token = NULL,
         last_error_code = NULL, failure_category = NULL, finalized_at = NULL,
         requeued_by = $2, requeued_at = statement_timestamp()
     WHERE memory_id = $1::uuid AND status IN ('embedding_failed', 'cancelled')
     RETURNING requeued_at`,
    [memoryId, actor.keyId],
  );
  if (requeued.rows.length !== 1) throw new IngestionJobStateConflictError(job.status);
  await logAudit({
    clientId: actor.keyId, action: 'ingestion.requeue', namespace: job.namespace,
    memoryId: job.memory_id, resourceType: 'memory', resourceId: job.memory_id,
    details: { requeued: true, attempts: Number(job.attempts) },
  }, { namespaces: [job.namespace], keyId: actor.keyId }, client);
  emitIngestionMetric('requeued');
  return {
    memory_id: job.memory_id,
    namespace: job.namespace,
    previous_status: job.status,
    previous_attempts: Number(job.attempts),
    requeued_at: requeued.rows[0].requeued_at,
  };
}

/** Operator pause switch read by the worker before each poll. */
export async function ingestionPaused(client: ScopedClient): Promise<boolean> {
  const result = await client.query<{ ingestion_paused: boolean }>(
    'SELECT ingestion_paused FROM instance_settings WHERE singleton = true',
  );
  return result.rows[0]?.ingestion_paused === true;
}

export async function setIngestionPaused(client: ScopedClient, paused: boolean): Promise<boolean> {
  const result = await client.query<{ ingestion_paused: boolean }>(
    'UPDATE instance_settings SET ingestion_paused = $1 WHERE singleton = true RETURNING ingestion_paused',
    [paused],
  );
  if (result.rows.length !== 1) throw new Error('instance_settings row is missing; run migrations');
  return result.rows[0].ingestion_paused;
}

/** The worker's liveness signal, surfaced by ingestionStats. */
export async function recordIngestionWorkerHeartbeat(client: ScopedClient): Promise<void> {
  await client.query(
    'UPDATE instance_settings SET ingestion_worker_seen_at = statement_timestamp() WHERE singleton = true',
  );
}

export interface IngestionStats {
  depth: Record<IngestionJobStatus, number>;
  /** pending + processing + retry_wait */
  queued: number;
  oldest_pending_age_seconds: number | null;
  next_retry_at: Date | null;
  attempts_histogram: Array<{ attempts: number; count: number }>;
  failure_categories: Record<IngestionFailureCategory, number>;
  /** Process-local inline fast path counters since this process started. */
  inline: InlineIngestionCounters;
  worker: { paused: boolean; last_seen_at: Date | null };
}

/** Content-free queue aggregates for the admin stats surface and dashboard. */
export async function ingestionStats(client: ScopedClient): Promise<IngestionStats> {
  const depthRows = await client.query<{ status: IngestionJobStatus; count: number | string }>(
    'SELECT status, count(*)::int AS count FROM memory_ingestion_jobs GROUP BY status',
  );
  const ages = await client.query<{ oldest_pending_age_seconds: number | string | null; next_retry_at: Date | null }>(
    `SELECT EXTRACT(EPOCH FROM (statement_timestamp() - min(accepted_at)))::double precision AS oldest_pending_age_seconds,
            min(next_attempt_at) FILTER (WHERE status = 'retry_wait') AS next_retry_at
     FROM memory_ingestion_jobs
     WHERE status IN ('pending', 'processing', 'retry_wait')`,
  );
  const attemptRows = await client.query<{ attempts: number | string; count: number | string }>(
    `SELECT attempts, count(*)::int AS count
     FROM memory_ingestion_jobs
     WHERE status IN ('pending', 'processing', 'retry_wait', 'embedding_failed')
     GROUP BY attempts
     ORDER BY attempts`,
  );
  const failureRows = await client.query<{ failure_category: IngestionFailureCategory; count: number | string }>(
    `SELECT failure_category, count(*)::int AS count
     FROM memory_ingestion_jobs
     WHERE failure_category IS NOT NULL AND status IN ('retry_wait', 'embedding_failed', 'cancelled')
     GROUP BY failure_category`,
  );
  const settings = await client.query<{ ingestion_paused: boolean; ingestion_worker_seen_at: Date | null }>(
    'SELECT ingestion_paused, ingestion_worker_seen_at FROM instance_settings WHERE singleton = true',
  );

  const depth = Object.fromEntries(INGESTION_JOB_STATUSES.map(status => [status, 0])) as Record<IngestionJobStatus, number>;
  for (const row of depthRows.rows) {
    if (row.status in depth) depth[row.status] = Number(row.count);
  }
  const failureCategories = Object.fromEntries(
    INGESTION_FAILURE_CATEGORIES.map(category => [category, 0]),
  ) as Record<IngestionFailureCategory, number>;
  for (const row of failureRows.rows) {
    if (row.failure_category in failureCategories) failureCategories[row.failure_category] = Number(row.count);
  }
  const age = ages.rows[0]?.oldest_pending_age_seconds;
  return {
    depth,
    queued: depth.pending + depth.processing + depth.retry_wait,
    oldest_pending_age_seconds: age == null ? null : Math.max(0, Number(age)),
    next_retry_at: ages.rows[0]?.next_retry_at ?? null,
    attempts_histogram: attemptRows.rows.map(row => ({ attempts: Number(row.attempts), count: Number(row.count) })),
    failure_categories: failureCategories,
    inline: inlineIngestionCounters(),
    worker: {
      paused: settings.rows[0]?.ingestion_paused === true,
      last_seen_at: settings.rows[0]?.ingestion_worker_seen_at ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Inline fast path
// ---------------------------------------------------------------------------

export interface InlineIngestionCounters {
  attempted: number;
  ready: number;
  deduplicated: number;
  queued: number;
}

const inlineCounters: InlineIngestionCounters = { attempted: 0, ready: 0, deduplicated: 0, queued: 0 };

export function inlineIngestionCounters(): InlineIngestionCounters {
  return { ...inlineCounters };
}

export function resetInlineIngestionCountersForTesting(): void {
  inlineCounters.attempted = 0;
  inlineCounters.ready = 0;
  inlineCounters.deduplicated = 0;
  inlineCounters.queued = 0;
}

export interface InlineIngestionDeps {
  /** Defaults to MEMORY_STORE_INLINE_EMBED_MS; 0 skips the inline attempt entirely. */
  budgetMs?: number;
  /** Lease for the inline claim; defaults to INGESTION_INLINE_LEASE_MS. */
  leaseMs?: number;
  /** Request-level cancellation, combined with the budget timeout. */
  signal?: AbortSignal;
  /** Test/embedding hook; production embeds with the active profile. */
  embed?: (content: string, signal: AbortSignal) => Promise<EmbeddingResult>;
  finalize?: FinalizeIngestionOptions;
  /** Test hook; production uses the bounded process-wide shadow scheduler. */
  scheduleShadow?: (task: () => Promise<void>) => void;
}

export type InlineIngestionResult =
  | { state: 'ready'; result: Extract<FinalizeIngestionResult, { outcome: 'ready' | 'deduplicated' }> }
  | {
      state: 'queued';
      /** Content-free reason the worker now owns the job. */
      reason: 'always_async' | 'not_claimed' | 'expired' | 'deleted' | 'missing' | 'stale_lease'
        | 'embed_failed' | 'finalize_failed' | 'space_mismatch' | 'cancelled' | 'stale';
      errorCode?: string;
    };

/**
 * After durable acceptance: claim the owned job, embed within the inline
 * budget, and run the shared finalize. Any failure records a content-free
 * error code without counting an attempt and leaves the job pending for the
 * worker, so request latency is bounded by the budget, not the provider.
 */
export async function inlineEmbedAndFinalize(
  memoryId: string,
  scope: DbScope,
  deps: InlineIngestionDeps = {},
): Promise<InlineIngestionResult> {
  const budgetMs = deps.budgetMs ?? inlineEmbedBudgetMsFromEnv();
  if (budgetMs === 0) return queuedInline('always_async');
  inlineCounters.attempted += 1;

  const claimed = await withScopedClient(scope, async client => {
    const job = await claimOwnedIngestionJob(client, memoryId, { leaseMs: deps.leaseMs });
    if (!job) return null;
    return { job, source: await loadIngestionJobContent(client, job) };
  });
  if (!claimed) return queuedInline('not_claimed');
  const { job, source } = claimed;
  if (!source.available) {
    if (source.reason === 'expired' || source.reason === 'deleted') {
      await quietly(() => withScopedClient(scope, client => cancelIngestionJob(client, job, source.reason as 'expired' | 'deleted')));
    }
    return queuedInline(source.reason);
  }

  let embedding: EmbeddingResult;
  try {
    const budget = AbortSignal.timeout(budgetMs);
    const signal = deps.signal ? AbortSignal.any([deps.signal, budget]) : budget;
    embedding = await (deps.embed ?? defaultEmbed)(source.content, signal);
  } catch (error) {
    const failure = classifyEmbeddingError(error);
    await quietly(() => withScopedClient(scope, client =>
      releaseIngestionJob(client, job, { errorCode: failure.errorCode, category: failure.category })));
    emitIngestionMetric(`inline_${failure.errorCode}`);
    return queuedInline('embed_failed', failure.errorCode);
  }

  let outcome: FinalizeIngestionResult;
  try {
    outcome = await withScopedClient(ingestionJobScope(job), client =>
      finalizeIngestionJob(client, job, embedding, deps.finalize));
  } catch {
    await quietly(() => withScopedClient(scope, client =>
      releaseIngestionJob(client, job, { errorCode: 'finalize_error', category: null })));
    emitIngestionMetric('inline_finalize_error');
    return queuedInline('finalize_failed', 'finalize_error');
  }
  if (outcome.outcome === 'ready' || outcome.outcome === 'deduplicated') {
    inlineCounters[outcome.outcome] += 1;
    scheduleIngestionShadow(outcome, {
      scheduleShadow: deps.scheduleShadow,
      contradictionMetric: deps.finalize?.contradictionMetric,
    });
    return { state: 'ready', result: outcome };
  }
  return queuedInline(outcome.outcome);
}

function queuedInline(
  reason: Extract<InlineIngestionResult, { state: 'queued' }>['reason'],
  errorCode?: string,
): InlineIngestionResult {
  inlineCounters.queued += 1;
  return errorCode === undefined ? { state: 'queued', reason } : { state: 'queued', reason, errorCode };
}

function defaultEmbed(content: string, signal: AbortSignal): Promise<EmbeddingResult> {
  return embedWithProfile(content, ACTIVE_EMBEDDING_PROFILE, signal);
}

async function quietly(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    // The lease expires on its own; the worker reclaims the job. Never log
    // the error, which could carry database or provider detail.
    emitIngestionMetric('inline_release_error');
  }
}

function emitIngestionMetric(outcome: string): void {
  // Fixed, content-free outcome codes only: no ids, namespaces, text, or errors.
  console.warn(`[ingestion] outcome=${outcome}`);
}
