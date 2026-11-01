import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import type pg from 'pg';
import { setPoolForTesting, withScopedClient, type DbScope, type ScopedClient } from '../src/db.js';
import { commitAutomaticRevision, type ContradictionPolicy, type SemanticMemoryInsert } from '../src/contradictions.js';
import { EmbeddingProviderError, type EmbeddingResult } from '../src/embedding.js';
import { IngestionJobNotFoundError, IngestionJobStateConflictError } from '../src/errors.js';
import {
  DEFAULT_INGESTION_MAX_ATTEMPTS,
  DEFAULT_INLINE_EMBED_MS,
  INGESTION_FAILURE_CATEGORIES,
  INGESTION_INLINE_LEASE_MS,
  INGESTION_JOB_KINDS,
  INGESTION_JOB_STATUSES,
  INGESTION_LEASE_MS,
  acceptMemory,
  cancelIngestionJob,
  claimIngestionJob,
  claimOwnedIngestionJob,
  classifyEmbeddingError,
  enqueueIngestionJob,
  failIngestionJob,
  finalizeIngestionJob,
  ingestionJobScope,
  ingestionMaxAttemptsFromEnv,
  ingestionQueueEnabled,
  ingestionStats,
  ingestionStatusFromJob,
  ingestionStatusJoinSql,
  ingestionStatusSelectSql,
  inlineEmbedAndFinalize,
  inlineEmbedBudgetMsFromEnv,
  inlineIngestionCounters,
  loadIngestionJobContent,
  parseIngestionMaxAttempts,
  parseInlineEmbedBudgetMs,
  publicIngestionState,
  releaseIngestionJob,
  requeueIngestionJob,
  resetInlineIngestionCountersForTesting,
  scheduleIngestionShadow,
  type IngestionJob,
} from '../src/ingestion.js';
import { DEDUPE_BOOST_SQL, dedupeCandidateSql } from '../src/tools/store.js';
import type { AccessLevel } from '../src/types.js';

const KEY_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_KEY_ID = '99999999-9999-4999-8999-999999999999';
const CANONICAL_ID = '22222222-2222-4222-8222-222222222222';
const MEMORY_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '44444444-4444-4444-8444-444444444444';
const LEASE = '55555555-5555-4555-8555-555555555555';
const PREDECESSOR_ID = '66666666-6666-4666-8666-666666666666';
const ACCEPTED_AT = new Date('2026-11-01T10:00:00.000Z');
const READY_AT = new Date('2026-11-01T10:00:01.000Z');
const SECRET = 'DO-NOT-LOG-accepted-memory-content-7f3a';
const VECTOR = Array(768).fill(0.25);
const SERIALIZED = `[${VECTOR.join(',')}]`;
const EMBEDDING: EmbeddingResult = { vector: VECTOR, provider: 'gemini', model: 'gemini-embedding-2-preview', dimensions: 768 };
const OWNER_SCOPE: DbScope = { namespaces: ['shared', 'private'], keyId: KEY_ID };

type Statement = { text: string; params: unknown[] };
type Responder = (params: unknown[], sql: string) => unknown[] | { rows: unknown[]; rowCount: number };

function rows(list: unknown[], command = 'MOCK') {
  return { command, rowCount: list.length, oid: 0, fields: [], rows: list };
}

class FakePool {
  statements: Statement[] = [];
  clients: Statement[][] = [];
  scopes: Array<{ namespaces: string[]; keyId: string; admin: string }> = [];
  private responders: Array<[RegExp, Responder]> = [];

  on(pattern: RegExp, respond: Responder): this {
    this.responders.push([pattern, respond]);
    return this;
  }

  async connect() {
    const own: Statement[] = [];
    this.clients.push(own);
    const scope = { namespaces: [] as string[], keyId: '', admin: '' };
    return {
      query: async (text: string, params: unknown[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        this.statements.push({ text: sql, params });
        own.push({ text: sql, params });
        if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/.test(sql)) return rows([]);
        if (sql.startsWith("SELECT set_config('app.allowed_namespaces'")) {
          if (sql.includes('true')) {
            scope.namespaces = JSON.parse(String(params[0])) as string[];
          }
          return rows([]);
        }
        if (sql.startsWith("SELECT set_config('app.current_key_id'")) { scope.keyId = String(params[0]); return rows([]); }
        if (sql.startsWith("SELECT set_config('app.current_key_is_admin'")) {
          scope.admin = String(params[0]);
          this.scopes.push({ ...scope, namespaces: [...scope.namespaces] });
          return rows([]);
        }
        for (let index = this.responders.length - 1; index >= 0; index -= 1) {
          const [pattern, respond] = this.responders[index];
          if (!pattern.test(sql)) continue;
          const out = respond(params, sql);
          if (Array.isArray(out)) return rows(out);
          return { command: 'MOCK', rowCount: out.rowCount, oid: 0, fields: [], rows: out.rows };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      release() {},
    };
  }

  async query(): Promise<never> { throw new Error('ingestion primitives must use scoped clients'); }
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    memory_id: MEMORY_ID, namespace: 'shared', kind: 'store', source_revision: 0, document_id: null, chunk_index: null,
    client_id: KEY_ID, access_level: 'normal', allowed_namespaces: ['shared', 'private'], agent_id: AGENT_ID,
    session_id: null, source_key: null, dedupe: true, ttl_seconds: null, contradiction_eligible: true,
    embedding_provider: 'gemini', embedding_model: 'gemini-embedding-2-preview', embedding_dimensions: 768,
    status: 'processing', attempts: 1, next_attempt_at: ACCEPTED_AT, lease_token: LEASE,
    lease_expires_at: new Date(ACCEPTED_AT.getTime() + INGESTION_LEASE_MS), accepted_at: ACCEPTED_AT,
    ...overrides,
  };
}

function job(overrides: Partial<IngestionJob> = {}): IngestionJob {
  return {
    memoryId: MEMORY_ID, namespace: 'shared', kind: 'store', sourceRevision: 0, documentId: null, chunkIndex: null,
    clientId: KEY_ID, accessLevel: 'normal', allowedNamespaces: ['shared', 'private'], agentId: AGENT_ID,
    sessionId: null, sourceKey: null, dedupe: true, ttlSeconds: null, contradictionEligible: true,
    embeddingProvider: 'gemini', embeddingModel: 'gemini-embedding-2-preview', embeddingDimensions: 768,
    status: 'processing', attempts: 1, nextAttemptAt: ACCEPTED_AT, leaseToken: LEASE,
    leaseExpiresAt: new Date(ACCEPTED_AT.getTime() + INGESTION_LEASE_MS), acceptedAt: ACCEPTED_AT,
    ...overrides,
  };
}

const JOB_LOCK = /^SELECT j\.memory_id, .* FROM memory_ingestion_jobs j WHERE j\.memory_id = \$1::uuid AND j\.status = 'processing' AND j\.lease_token = \$2::uuid FOR UPDATE$/;
const MEMORY_LOCK = /^SELECT m\.id, m\.namespace, m\.content, .* FROM memories m WHERE m\.id = \$1::uuid AND m\.namespace = \$2 FOR UPDATE$/;
const OWNED_CLAIM = /^UPDATE memory_ingestion_jobs j SET status = 'processing', lease_token = gen_random_uuid\(\),/;
const WORKER_CLAIM = /^WITH candidate AS \(/;
const LOAD_CONTENT = /^SELECT m\.content, m\.id IS NULL AS missing/;
const JOB_UPDATE = /^UPDATE memory_ingestion_jobs SET/;
const PLAIN_LANDING = /^UPDATE memories SET embedding = \$1::vector/;
const TOMBSTONE = /^UPDATE memories SET deleted_at = statement_timestamp\(\)/;
const BOOST = /^UPDATE memories SET access_count/;
const CANDIDATE = /AS similarity FROM memories m/;
const AUDIT = /^INSERT INTO audit_log/;

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMORY_ID, namespace: 'shared', content: SECRET, source: 'tester', tags: ['queued', 'secret-tag'],
    metadata: { note: SECRET }, expires_at: null, deleted: false, expired: false, ...overrides,
  };
}

function pool(): FakePool {
  const fake = new FakePool();
  fake.on(/^INSERT INTO memories/, params => [{ id: MEMORY_ID, namespace: String(params[3]), expires_at: params[13] == null ? null : new Date('2026-11-01T10:01:00.000Z'), created_at: ACCEPTED_AT }]);
  fake.on(/^INSERT INTO memory_ingestion_jobs/, params => [{ memory_id: params[0], accepted_at: ACCEPTED_AT }]);
  fake.on(AUDIT, () => []);
  fake.on(JOB_LOCK, () => [jobRow()]);
  fake.on(MEMORY_LOCK, () => [memoryRow()]);
  fake.on(/^SELECT pg_advisory_xact_lock/, () => [{}]);
  fake.on(CANDIDATE, () => []);
  fake.on(BOOST, () => [{ id: CANONICAL_ID, namespace: 'shared', expires_at: null }]);
  fake.on(TOMBSTONE, () => [{ id: MEMORY_ID }]);
  fake.on(PLAIN_LANDING, () => [{ id: MEMORY_ID }]);
  fake.on(JOB_UPDATE, () => [{ ready_at: READY_AT, requeued_at: READY_AT }]);
  fake.on(WORKER_CLAIM, () => []);
  fake.on(OWNED_CLAIM, () => [jobRow({ attempts: 0 })]);
  fake.on(LOAD_CONTENT, () => [{ content: SECRET, missing: false, deleted: false, expired: false }]);
  setPoolForTesting(fake as unknown as pg.Pool);
  return fake;
}

function statements(fake: FakePool, pattern: RegExp): Statement[] {
  return fake.statements.filter(statement => pattern.test(statement.text));
}

function normalized(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function captureWarnings(t: TestContext): string[] {
  const lines: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.warn = originalWarn; console.error = originalError; });
  return lines;
}

function offlineProvider(t: TestContext): { calls: number } {
  const counter = { calls: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    counter.calls += 1;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  return counter;
}

const policyBase: ContradictionPolicy = {
  classificationEnabled: true,
  provider: 'approved',
  model: 'approved',
  endpoint: 'https://generation.example.test/v1',
  namespace: 'shared',
  timeoutMs: 1000,
  mutationConfidence: 0.95,
  mutationEnabled: false,
  shadowMaxInFlight: 2,
  shadowMaxQueued: 8,
};

test.beforeEach(() => resetInlineIngestionCountersForTesting());

test('configuration is fail-closed, bounded, and the state strings match migration 037 exactly', async () => {
  assert.equal(ingestionQueueEnabled({}), false);
  assert.equal(ingestionQueueEnabled({ MEMORY_INGESTION_QUEUE_ENABLED: 'true' }), true);
  for (const value of ['TRUE', '1', 'yes', 'on', ' true']) {
    assert.equal(ingestionQueueEnabled({ MEMORY_INGESTION_QUEUE_ENABLED: value }), false);
  }

  assert.equal(DEFAULT_INLINE_EMBED_MS, 3000);
  assert.equal(parseInlineEmbedBudgetMs(undefined), 3000);
  assert.equal(parseInlineEmbedBudgetMs(''), 3000);
  assert.equal(parseInlineEmbedBudgetMs('0'), 0);
  assert.equal(parseInlineEmbedBudgetMs('120000'), 120000);
  assert.equal(inlineEmbedBudgetMsFromEnv({ MEMORY_STORE_INLINE_EMBED_MS: '250' }), 250);
  for (const invalid of ['120001', '-1', 'abc', '1.5', 'Infinity']) {
    assert.throws(() => parseInlineEmbedBudgetMs(invalid), /MEMORY_STORE_INLINE_EMBED_MS/);
  }

  assert.equal(DEFAULT_INGESTION_MAX_ATTEMPTS, 12);
  assert.equal(parseIngestionMaxAttempts(undefined), 12);
  assert.equal(parseIngestionMaxAttempts('1'), 1);
  assert.equal(ingestionMaxAttemptsFromEnv({ MEMORY_INGESTION_MAX_ATTEMPTS: '3' }), 3);
  for (const invalid of ['0', '1001', '-4', 'x', '2.5']) {
    assert.throws(() => parseIngestionMaxAttempts(invalid), /MEMORY_INGESTION_MAX_ATTEMPTS/);
  }
  assert.equal(INGESTION_LEASE_MS, 10 * 60 * 1000);
  assert.ok(INGESTION_INLINE_LEASE_MS < INGESTION_LEASE_MS);

  const migration = await readFile('migrations/037_memory_ingestion_queue.sql', 'utf8');
  const statusCheck = /status TEXT NOT NULL DEFAULT 'pending' CHECK \(status IN \(([^)]*)\)\)/.exec(migration)!;
  assert.deepEqual([...statusCheck[1].matchAll(/'([a-z_]+)'/g)].map(match => match[1]), [...INGESTION_JOB_STATUSES]);
  const categoryCheck = /failure_category IN \(([^)]*)\)/.exec(migration)!;
  assert.deepEqual([...categoryCheck[1].matchAll(/'([a-z_]+)'/g)].map(match => match[1]), [...INGESTION_FAILURE_CATEGORIES]);
  const kindCheck = /kind IN \(([^)]*)\)/.exec(migration)!;
  assert.deepEqual([...kindCheck[1].matchAll(/'([a-z_]+)'/g)].map(match => match[1]), [...INGESTION_JOB_KINDS]);

  assert.equal(publicIngestionState('pending'), 'queued');
  assert.equal(publicIngestionState('processing'), 'queued');
  assert.equal(publicIngestionState('retry_wait'), 'queued');
  assert.equal(publicIngestionState('ready'), 'ready');
  assert.equal(publicIngestionState('deduplicated'), 'deduplicated');
  assert.equal(publicIngestionState('embedding_failed'), 'embedding_failed');
  assert.equal(publicIngestionState('cancelled'), 'cancelled');
});

test('acceptMemory durably persists the row, the job snapshot and the audit without calling the provider', async t => {
  const provider = offlineProvider(t);
  const fake = pool();
  const accepted = await withScopedClient(OWNER_SCOPE, client => acceptMemory(client, {
    content: SECRET, source: 'tester', namespace: 'shared', tags: ['a'], metadata: { k: 'v' },
    accessLevel: 'normal', clientId: KEY_ID, allowedNamespaces: ['shared', 'private'], agentId: AGENT_ID,
    sessionId: 'sess-1', ttlSeconds: null, dedupe: true, contradictionEligible: true,
  }));
  assert.equal(provider.calls, 0);
  assert.deepEqual(accepted, { id: MEMORY_ID, namespace: 'shared', expires_at: null, accepted_at: ACCEPTED_AT });

  const [insert] = statements(fake, /^INSERT INTO memories/);
  assert.ok(insert);
  assert.doesNotMatch(insert.text, /source_key|ON CONFLICT/i);
  assert.match(insert.text, /memory_kind, valid_from, expires_at\) VALUES \(\$1, \$2::vector, .* 'semantic', statement_timestamp\(\)/);
  assert.deepEqual(insert.params, [
    SECRET, null, 'tester', 'shared', ['a'], '{"k":"v"}', 'normal', KEY_ID, AGENT_ID, 'sess-1', null, null, null, null,
  ]);

  const [enqueue] = statements(fake, /^INSERT INTO memory_ingestion_jobs/);
  assert.ok(enqueue);
  assert.match(enqueue.text, /ON CONFLICT \(memory_id\) DO UPDATE SET .* status = 'pending', attempts = 0, next_attempt_at = statement_timestamp\(\)/);
  assert.doesNotMatch(enqueue.text, /\bcontent\b|\btags\b|\bmetadata\b/);
  assert.deepEqual(enqueue.params, [
    MEMORY_ID, 'shared', 'store', 0, null, null, KEY_ID, 'normal', ['shared', 'private'], AGENT_ID, 'sess-1', null,
    true, null, true, 'gemini', 'gemini-embedding-2-preview', 768,
  ]);
  assert.equal(enqueue.params.includes(SECRET), false);

  const [audit] = statements(fake, AUDIT);
  assert.ok(audit);
  assert.deepEqual(audit.params.slice(0, 4), [KEY_ID, 'memory.store', 'shared', MEMORY_ID]);
  assert.deepEqual(audit.params.slice(6, 10), [AGENT_ID, 'sess-1', 'memory', MEMORY_ID]);
  assert.equal(audit.params[10], JSON.stringify({ created: true, deduplicated: false, queued: true }));
  const transaction = fake.clients[0];
  assert.equal(transaction.at(-1)?.text, 'COMMIT');
  assert.ok(transaction.findIndex(s => /^INSERT INTO memories/.test(s.text)) < transaction.findIndex(s => /^INSERT INTO memory_ingestion_jobs/.test(s.text)));

  // TTL starts at acceptance with the synchronous path's expression; expiring stores never dedupe.
  const expiring = await withScopedClient(OWNER_SCOPE, client => acceptMemory(client, {
    content: 'temporary', source: 'tester', namespace: 'private', tags: [], metadata: {},
    accessLevel: 'sensitive', clientId: KEY_ID, allowedNamespaces: ['shared', 'private'], agentId: AGENT_ID,
    sessionId: null, ttlSeconds: 60, dedupe: false, contradictionEligible: false,
  }));
  assert.deepEqual(expiring.expires_at, new Date('2026-11-01T10:01:00.000Z'));
  const ttlInsert = statements(fake, /^INSERT INTO memories/).at(-1)!;
  assert.match(ttlInsert.text, /statement_timestamp\(\) \+ \$14::double precision \* interval '1 second'/);
  assert.equal(ttlInsert.params[13], 60);
  const ttlJob = statements(fake, /^INSERT INTO memory_ingestion_jobs/).at(-1)!;
  assert.deepEqual(ttlJob.params.slice(12, 15), [false, 60, false]);

  // The keyed path reuses the job upsert with a different kind/identity snapshot.
  await withScopedClient(OWNER_SCOPE, client => enqueueIngestionJob(client, {
    memoryId: MEMORY_ID, namespace: 'shared', kind: 'update', sourceRevision: 4, clientId: KEY_ID, accessLevel: 'normal',
    allowedNamespaces: ['shared'], agentId: null, sessionId: null, sourceKey: 'discord-safe:v1:abc', dedupe: false,
    ttlSeconds: null, contradictionEligible: false,
  }));
  const updateJob = statements(fake, /^INSERT INTO memory_ingestion_jobs/).at(-1)!;
  assert.deepEqual(updateJob.params.slice(0, 4), [MEMORY_ID, 'shared', 'update', 4]);
  assert.equal(updateJob.params[11], 'discord-safe:v1:abc');
});

test('inline fast path with the provider failing records a content-free code, counts no attempt, and leaves the job pending', async t => {
  const fake = pool();
  const logs = captureWarnings(t);
  const error = new EmbeddingProviderError('Gemini embedContent failed (503): upstream unavailable', {
    status: 503, retryAfter: undefined, provider: 'gemini',
  });
  const result = await inlineEmbedAndFinalize(MEMORY_ID, OWNER_SCOPE, {
    budgetMs: 1000,
    embed: async () => { throw error; },
  });
  assert.deepEqual(result, { state: 'queued', reason: 'embed_failed', errorCode: 'http_503' });

  const [claim] = statements(fake, OWNED_CLAIM);
  assert.ok(claim);
  assert.doesNotMatch(claim.text.split(' WHERE ')[0], /attempts/, 'the inline claim never counts an attempt');
  assert.match(claim.text, /WHERE j\.memory_id = \$1::uuid AND j\.status = 'pending' RETURNING/);
  assert.deepEqual(claim.params, [MEMORY_ID, INGESTION_INLINE_LEASE_MS]);
  const [load] = statements(fake, LOAD_CONTENT);
  assert.deepEqual(load.params, [MEMORY_ID, LEASE]);
  const [release] = statements(fake, JOB_UPDATE);
  assert.ok(release);
  assert.match(release.text, /SET status = 'pending', last_error_code = \$3, failure_category = \$4, locked_at = NULL, lease_expires_at = NULL, lease_token = NULL WHERE memory_id = \$1::uuid AND status = 'processing' AND lease_token = \$2::uuid/);
  assert.doesNotMatch(release.text, /attempts/);
  assert.deepEqual(release.params, [MEMORY_ID, LEASE, 'http_503', 'transient']);
  assert.equal(statements(fake, /^UPDATE memories/).length, 0);
  assert.equal(statements(fake, AUDIT).length, 0);
  assert.deepEqual(inlineIngestionCounters(), { attempted: 1, ready: 0, deduplicated: 0, queued: 1 });

  // The budget, not the provider timeout, bounds the request.
  const started = Date.now();
  const timedOut = await inlineEmbedAndFinalize(MEMORY_ID, OWNER_SCOPE, {
    budgetMs: 25,
    // A real provider call holds a socket open; the stub holds a timer so the
    // unref'd AbortSignal.timeout can fire before the event loop drains.
    embed: (_content, signal) => new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('budget never fired')), 5_000);
      signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    }),
  });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(timedOut, { state: 'queued', reason: 'embed_failed', errorCode: 'provider_timeout' });
  assert.deepEqual(statements(fake, JOB_UPDATE).at(-1)!.params, [MEMORY_ID, LEASE, 'provider_timeout', 'transient']);

  // Budget zero is always-async: no claim, no provider call, no SQL.
  const before = fake.statements.length;
  let embedCalls = 0;
  const async = await inlineEmbedAndFinalize(MEMORY_ID, OWNER_SCOPE, { budgetMs: 0, embed: async () => { embedCalls += 1; return EMBEDDING; } });
  assert.deepEqual(async, { state: 'queued', reason: 'always_async' });
  assert.equal(fake.statements.length, before);
  assert.equal(embedCalls, 0);

  // A worker that claimed first wins; the request reports queued without touching the job.
  fake.on(OWNED_CLAIM, () => []);
  const raced = await inlineEmbedAndFinalize(MEMORY_ID, OWNER_SCOPE, { budgetMs: 1000, embed: async () => EMBEDDING });
  assert.deepEqual(raced, { state: 'queued', reason: 'not_claimed' });

  for (const line of logs) {
    assert.match(line, /^\[ingestion\] outcome=[a-z0-9_]+$/);
    assert.doesNotMatch(line, new RegExp(SECRET));
  }
});

test('inline fast path success finalizes under the job scope and reports ready', async t => {
  const fake = pool();
  captureWarnings(t);
  let embedded: string | undefined;
  const result = await inlineEmbedAndFinalize(MEMORY_ID, OWNER_SCOPE, {
    budgetMs: 1000,
    embed: async content => { embedded = content; return EMBEDDING; },
    finalize: { contradictionPolicy: { ...policyBase, classificationEnabled: false, reason: 'disabled' } },
  });
  assert.equal(embedded, SECRET);
  assert.equal(result.state, 'ready');
  assert.equal(result.state === 'ready' && result.result.outcome, 'ready');
  if (result.state === 'ready' && result.result.outcome === 'ready') {
    assert.deepEqual(
      { id: result.result.id, namespace: result.result.namespace, expires_at: result.result.expires_at, revised: result.result.revised },
      { id: MEMORY_ID, namespace: 'shared', expires_at: null, revised: false },
    );
    assert.equal(result.result.ready_at, READY_AT);
  }
  // Claim + content load share one owner-scoped transaction; finalize runs in the job scope.
  assert.deepEqual(fake.scopes[0], { namespaces: ['shared', 'private'], keyId: KEY_ID, admin: 'false' });
  assert.deepEqual(fake.scopes[1], { namespaces: ['shared'], keyId: KEY_ID, admin: 'false' });
  assert.deepEqual(ingestionJobScope(job()), { namespaces: ['shared'], keyId: KEY_ID });
  assert.equal(fake.clients.length, 2);
  assert.equal(fake.clients[0].at(-1)?.text, 'COMMIT');
  assert.equal(fake.clients[1].at(-1)?.text, 'COMMIT');
  assert.equal(statements(fake, PLAIN_LANDING).length, 1);
  assert.deepEqual(inlineIngestionCounters(), { attempted: 1, ready: 1, deduplicated: 0, queued: 0 });
});

test('worker claim reclaims expired leases with SKIP LOCKED, counts an attempt, and never returns content', async () => {
  const fake = pool();
  assert.equal(await withScopedClient(OWNER_SCOPE, client => claimIngestionJob(client)), null);
  const [claim] = statements(fake, WORKER_CLAIM);
  assert.match(claim.text, /\(j\.status IN \('pending', 'retry_wait'\) AND j\.next_attempt_at <= statement_timestamp\(\)\) OR \(j\.status = 'processing' AND j\.lease_expires_at IS NOT NULL AND j\.lease_expires_at < statement_timestamp\(\)\)/);
  assert.match(claim.text, /ORDER BY j\.next_attempt_at, j\.accepted_at, j\.memory_id FOR UPDATE SKIP LOCKED LIMIT 1/);
  assert.match(claim.text, /SET status = 'processing', attempts = j\.attempts \+ 1, lease_token = gen_random_uuid\(\), locked_at = statement_timestamp\(\), lease_expires_at = statement_timestamp\(\) \+ \(\$1::int \* interval '1 millisecond'\)/);
  assert.doesNotMatch(claim.text, /\bcontent\b/);
  assert.deepEqual(claim.params, [INGESTION_LEASE_MS]);

  fake.on(WORKER_CLAIM, () => [jobRow({ ttl_seconds: '60', attempts: '3', source_revision: '2', dedupe: false })]);
  const claimed = await withScopedClient(OWNER_SCOPE, client => claimIngestionJob(client, { leaseMs: 30_000 }));
  assert.ok(claimed);
  assert.deepEqual(claimed, job({ ttlSeconds: 60, attempts: 3, sourceRevision: 2, dedupe: false }));
  assert.equal(statements(fake, WORKER_CLAIM).at(-1)!.params[0], 30_000);
  assert.equal('content' in claimed, false);
  await assert.rejects(withScopedClient(OWNER_SCOPE, client => claimIngestionJob(client, { leaseMs: 5 })), /lease/);

  const owned = await withScopedClient(OWNER_SCOPE, client => claimOwnedIngestionJob(client, MEMORY_ID));
  assert.equal(owned?.attempts, 0);
  assert.equal(owned?.leaseToken, LEASE);
});

test('a stale lease token makes every finalize, fail, cancel and content load a no-op', async t => {
  const fake = pool();
  captureWarnings(t);
  fake.on(JOB_LOCK, () => []);
  fake.on(LOAD_CONTENT, () => []);
  fake.on(JOB_UPDATE, () => ({ rows: [], rowCount: 0 }));
  const stale = job({ leaseToken: '77777777-7777-4777-8777-777777777777' });

  const finalized = await withScopedClient(ingestionJobScope(stale), client => finalizeIngestionJob(client, stale, EMBEDDING));
  assert.deepEqual(finalized, { outcome: 'stale' });
  assert.equal(statements(fake, /^UPDATE/).length, 0);
  assert.equal(statements(fake, AUDIT).length, 0);
  assert.deepEqual(statements(fake, JOB_LOCK)[0].params, [MEMORY_ID, stale.leaseToken]);

  const failed = await withScopedClient(ingestionJobScope(stale), client => failIngestionJob(client, stale, new Error('x'), { maxAttempts: 12 }));
  assert.equal(failed.applied, false);
  assert.equal(await withScopedClient(ingestionJobScope(stale), client => cancelIngestionJob(client, stale, 'expired')), false);
  assert.equal(await withScopedClient(ingestionJobScope(stale), client => releaseIngestionJob(client, stale, { errorCode: 'x', category: null })), false);
  assert.deepEqual(await withScopedClient(ingestionJobScope(stale), client => loadIngestionJobContent(client, stale)), { available: false, reason: 'stale_lease' });
  for (const statement of statements(fake, JOB_UPDATE)) {
    assert.match(statement.text, /WHERE memory_id = \$1::uuid AND status = 'processing' AND lease_token = \$2::uuid/);
  }
  await assert.rejects(finalizeIngestionJob({} as ScopedClient, job({ leaseToken: null }), EMBEDDING), /lease/);
});

test('plain finalize lands the vector, identity and updated_at, marks the job ready, and audits once', async t => {
  const fake = pool();
  captureWarnings(t);
  const current = job();
  const result = await withScopedClient(ingestionJobScope(current), client =>
    finalizeIngestionJob(client, current, EMBEDDING, { contradictionPolicy: { ...policyBase, classificationEnabled: false } }));
  assert.deepEqual(result, {
    outcome: 'ready', id: MEMORY_ID, namespace: 'shared', expires_at: null, ready_at: READY_AT, revised: false,
  });

  const transaction = fake.clients[0].map(statement => statement.text);
  const order = [JOB_LOCK, MEMORY_LOCK, /^SELECT pg_advisory_xact_lock/, CANDIDATE, PLAIN_LANDING, JOB_UPDATE, AUDIT]
    .map(pattern => transaction.findIndex(text => pattern.test(text)));
  assert.ok(order.every(index => index >= 0), `all finalize statements run: ${order.join(',')}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(transaction.at(-1), 'COMMIT');

  const [lock] = statements(fake, /^SELECT pg_advisory_xact_lock/);
  assert.deepEqual(lock.params, ['memory-store-dedupe:["shared","normal"]']);
  const [candidate] = statements(fake, CANDIDATE);
  assert.equal(candidate.text, normalized(dedupeCandidateSql(true)));
  assert.match(candidate.text, /AND m\.id <> \$7::uuid ORDER BY/);
  assert.deepEqual(candidate.params, [SERIALIZED, 'shared', 'normal', 'gemini', 'gemini-embedding-2-preview', 768, MEMORY_ID]);
  assert.equal(statements(fake, BOOST).length, 0);
  assert.equal(statements(fake, TOMBSTONE).length, 0);

  const [landing] = statements(fake, PLAIN_LANDING);
  assert.match(landing.text, /SET embedding = \$1::vector, embedding_provider = \$2, embedding_model = \$3, embedding_dimensions = \$4, updated_at = statement_timestamp\(\) WHERE id = \$5::uuid AND namespace = \$6 AND deleted_at IS NULL RETURNING id/);
  assert.deepEqual(landing.params, [SERIALIZED, 'gemini', 'gemini-embedding-2-preview', 768, MEMORY_ID, 'shared']);
  const [ready] = statements(fake, JOB_UPDATE);
  assert.match(ready.text, /SET status = 'ready', ready_at = statement_timestamp\(\), finalized_at = statement_timestamp\(\), locked_at = NULL, lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL, failure_category = NULL WHERE memory_id = \$1::uuid AND status = 'processing' AND lease_token = \$2::uuid RETURNING ready_at/);
  assert.deepEqual(ready.params, [MEMORY_ID, LEASE]);
  const audits = statements(fake, AUDIT);
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0].params.slice(0, 4), [KEY_ID, 'memory.ingest.ready', 'shared', MEMORY_ID]);
  assert.deepEqual(audits[0].params.slice(6, 10), [AGENT_ID, null, 'memory', MEMORY_ID]);
  assert.equal(audits[0].params[10], JSON.stringify({ created: true, deduplicated: false, attempts: 1 }));

  // dedupe:false and ttl stores never take the lock or query candidates.
  for (const variant of [job({ dedupe: false }), job({ ttlSeconds: 60, dedupe: false, contradictionEligible: false })]) {
    const before = fake.statements.length;
    fake.on(JOB_LOCK, () => [jobRow({ dedupe: variant.dedupe, ttl_seconds: variant.ttlSeconds, contradiction_eligible: variant.contradictionEligible })]);
    await withScopedClient(ingestionJobScope(variant), client => finalizeIngestionJob(client, variant, EMBEDDING, { contradictionPolicy: { ...policyBase, classificationEnabled: false } }));
    const after = fake.statements.slice(before);
    assert.equal(after.some(statement => /pg_advisory_xact_lock|AS similarity/.test(statement.text)), false);
    assert.equal(after.filter(statement => PLAIN_LANDING.test(statement.text)).length, 1);
  }
});

test('dedupe hit at finalize boosts the canonical exactly as today, tombstones the pending row, and records the canonical', async t => {
  const fake = pool();
  captureWarnings(t);
  fake.on(CANDIDATE, () => [{ id: CANONICAL_ID, namespace: 'shared', similarity: '0.97' }]);
  const current = job();
  const result = await withScopedClient(ingestionJobScope(current), client => finalizeIngestionJob(client, current, EMBEDDING));
  assert.deepEqual(result, {
    outcome: 'deduplicated', id: CANONICAL_ID, namespace: 'shared', expires_at: null, similarity: 0.97, ready_at: READY_AT,
  });

  const [boost] = statements(fake, BOOST);
  assert.equal(boost.text, normalized(DEDUPE_BOOST_SQL));
  assert.deepEqual(boost.params, [CANONICAL_ID, ['queued', 'secret-tag']]);
  assert.doesNotMatch(boost.text, /content\s*=|metadata\s*=|source\s*=|client_id\s*=|agent_id\s*=/);
  const [tombstone] = statements(fake, TOMBSTONE);
  assert.match(tombstone.text, /SET deleted_at = statement_timestamp\(\), deletion_reason = 'ingestion_deduplicated', updated_at = statement_timestamp\(\) WHERE id = \$1::uuid AND namespace = \$2 AND deleted_at IS NULL/);
  assert.deepEqual(tombstone.params, [MEMORY_ID, 'shared']);
  const [done] = statements(fake, JOB_UPDATE);
  assert.match(done.text, /SET status = 'deduplicated', canonical_memory_id = \$3::uuid, similarity = \$4, ready_at = statement_timestamp\(\), finalized_at = statement_timestamp\(\)/);
  assert.match(done.text, /WHERE memory_id = \$1::uuid AND status = 'processing' AND lease_token = \$2::uuid/);
  assert.deepEqual(done.params, [MEMORY_ID, LEASE, CANONICAL_ID, 0.97]);
  assert.equal(statements(fake, PLAIN_LANDING).length, 0);
  const audits = statements(fake, AUDIT);
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0].params.slice(0, 4), [KEY_ID, 'memory.ingest.deduplicated', 'shared', MEMORY_ID]);
  assert.deepEqual(audits[0].params.slice(8, 10), ['memory', CANONICAL_ID]);
  assert.equal(audits[0].params[10], JSON.stringify({ created: false, deduplicated: true, attempts: 1 }));
  const transaction = fake.clients[0].map(statement => statement.text);
  assert.ok(transaction.findIndex(text => BOOST.test(text)) < transaction.findIndex(text => TOMBSTONE.test(text)));
  assert.equal(transaction.at(-1), 'COMMIT');

  // Exactly the threshold is a hit; just below it is a miss that lands normally.
  fake.on(CANDIDATE, () => [{ id: CANONICAL_ID, namespace: 'shared', similarity: 0.95 }]);
  const atThreshold = await withScopedClient(ingestionJobScope(current), client => finalizeIngestionJob(client, current, EMBEDDING));
  assert.equal(atThreshold.outcome, 'deduplicated');
  fake.on(CANDIDATE, () => [{ id: CANONICAL_ID, namespace: 'shared', similarity: 0.949999 }]);
  const miss = await withScopedClient(ingestionJobScope(current), client => finalizeIngestionJob(client, current, EMBEDDING, { contradictionPolicy: { ...policyBase, classificationEnabled: false } }));
  assert.equal(miss.outcome, 'ready');
  assert.equal(statements(fake, BOOST).length, 2);
  assert.equal(statements(fake, PLAIN_LANDING).length, 1);
  fake.on(CANDIDATE, () => [{ id: CANONICAL_ID, namespace: 'shared', similarity: 0.8 }]);
  const lowered = await withScopedClient(ingestionJobScope(current), client => finalizeIngestionJob(client, current, EMBEDDING, { dedupeThreshold: 0.5 }));
  assert.equal(lowered.outcome, 'deduplicated');

  // A canonical that changed under the lock aborts the transaction instead of landing twice.
  fake.on(CANDIDATE, () => [{ id: CANONICAL_ID, namespace: 'shared', similarity: 0.99 }]);
  fake.on(BOOST, () => []);
  await assert.rejects(
    withScopedClient(ingestionJobScope(current), client => finalizeIngestionJob(client, current, EMBEDDING)),
    /Dedupe candidate changed/,
  );
  assert.equal(fake.clients.at(-1)?.at(-1)?.text, 'ROLLBACK');
});

test('contradiction mutation finalizes the pending row in place and shadow classification waits for commit', async t => {
  const fake = pool();
  captureWarnings(t);
  const calls: Array<{ memory: SemanticMemoryInsert; auth: unknown; options: Record<string, unknown> }> = [];
  let revisionResult: { id: string; namespace: string } | null = { id: MEMORY_ID, namespace: 'shared' };
  const reviseBelief = (async (memory: SemanticMemoryInsert, auth: unknown, options: Record<string, unknown> = {}) => {
    calls.push({ memory, auth, options });
    return revisionResult;
  }) as never;
  const mutation = { ...policyBase, mutationEnabled: true };
  const current = job();

  const revised = await withScopedClient(ingestionJobScope(current), client =>
    finalizeIngestionJob(client, current, EMBEDDING, { contradictionPolicy: mutation, reviseBelief }));
  assert.equal(revised.outcome, 'ready');
  assert.equal(revised.outcome === 'ready' && revised.revised, true);
  assert.equal(revised.outcome === 'ready' && revised.shadowTask, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.finalizeExistingId, MEMORY_ID);
  assert.equal(calls[0].options.allowMutation, true);
  assert.equal(calls[0].options.policy, mutation);
  assert.equal(typeof (calls[0].options.client as { query?: unknown }).query, 'function');
  assert.deepEqual(calls[0].memory, {
    content: SECRET, vector: SERIALIZED, source: 'tester', namespace: 'shared', tags: ['queued', 'secret-tag'],
    metadata: { note: SECRET }, accessLevel: 'normal', clientId: KEY_ID, agentId: AGENT_ID, sessionId: null,
  });
  assert.deepEqual(calls[0].auth, { keyId: KEY_ID, name: 'ingestion', namespaces: ['shared'], permissions: ['write'], maxAccessLevel: 'normal' });
  assert.equal(statements(fake, PLAIN_LANDING).length, 0, 'the revision landed the vector; no plain update');
  assert.equal(statements(fake, JOB_UPDATE).length, 1);
  assert.equal(statements(fake, AUDIT).length, 1);
  assert.equal(statements(fake, AUDIT)[0].params[1], 'memory.ingest.ready');
  // The revision ran inside the finalize transaction, before the job flipped to ready.
  const transaction = fake.clients[0].map(statement => statement.text);
  assert.ok(transaction.findIndex(text => MEMORY_LOCK.test(text)) < transaction.findIndex(text => JOB_UPDATE.test(text)));

  // No mutation (stale candidate, no match, etc.) falls through to the plain landing.
  revisionResult = null;
  const plain = await withScopedClient(ingestionJobScope(current), client =>
    finalizeIngestionJob(client, current, EMBEDDING, { contradictionPolicy: mutation, reviseBelief }));
  assert.equal(plain.outcome === 'ready' && plain.revised, false);
  assert.equal(statements(fake, PLAIN_LANDING).length, 1);
  assert.equal(calls.length, 2);

  // Shadow-only policy: nothing runs inside the transaction; the task is scheduled after commit.
  const shadowPolicy = { ...policyBase, mutationEnabled: false };
  const shadowed = await withScopedClient(ingestionJobScope(current), client =>
    finalizeIngestionJob(client, current, EMBEDDING, { contradictionPolicy: shadowPolicy, reviseBelief }));
  assert.equal(calls.length, 2);
  assert.ok(shadowed.outcome === 'ready' && shadowed.shadowTask);
  let scheduled: (() => Promise<void>) | undefined;
  assert.equal(scheduleIngestionShadow(shadowed, { scheduleShadow: task => { scheduled = task; } }), true);
  assert.equal(fake.clients.at(-1)?.at(-1)?.text, 'COMMIT');
  await scheduled!();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.allowMutation, false);
  assert.equal(calls[2].options.excludeCandidateId, MEMORY_ID);
  assert.equal(calls[2].options.finalizeExistingId, undefined);

  // Out of the approved namespace: no shadow task; not eligible: the policy is never consulted.
  const elsewhere = await withScopedClient(ingestionJobScope(current), client =>
    finalizeIngestionJob(client, current, EMBEDDING, { contradictionPolicy: { ...shadowPolicy, namespace: 'other' }, reviseBelief }));
  assert.equal(elsewhere.outcome === 'ready' && elsewhere.shadowTask, undefined);
  assert.equal(scheduleIngestionShadow(elsewhere, { scheduleShadow: () => assert.fail('must not schedule') }), false);
  fake.on(JOB_LOCK, () => [jobRow({ contradiction_eligible: false })]);
  const ineligible = await withScopedClient(ingestionJobScope(current), client =>
    finalizeIngestionJob(client, job({ contradictionEligible: false }), EMBEDDING, { contradictionPolicy: mutation, reviseBelief }));
  assert.equal(ineligible.outcome === 'ready' && ineligible.shadowTask, undefined);
  assert.equal(calls.length, 3);
});

test('commitAutomaticRevision in finalize-existing mode updates the accepted row under a savepoint', async () => {
  const fake = pool();
  const memory: SemanticMemoryInsert = {
    content: SECRET, vector: SERIALIZED, source: 'tester', namespace: 'shared', tags: [], metadata: {},
    accessLevel: 'normal', clientId: KEY_ID, agentId: AGENT_ID, sessionId: null,
  };
  const auth = { keyId: KEY_ID, name: 'ingestion', namespaces: ['shared'], permissions: ['write'], maxAccessLevel: 'normal' as AccessLevel };
  const PENDING_LOCK = /^SELECT m\.id FROM memories m WHERE m\.id = \$1::uuid AND m\.namespace = \$2 AND m\.deleted_at IS NULL .* AND m\.embedding IS NULL .* FOR UPDATE$/;
  const PREDECESSOR_LOCK = /^SELECT m\.id FROM memories m WHERE m\.id = \$1::uuid AND m\.namespace = \$2 AND m\.namespace = ANY\(\$3::text\[\]\)/;
  const CLOSE = /^UPDATE memories SET superseded_at = \$2::timestamptz/;
  const FINALIZE = /^UPDATE memories SET embedding = \$2::vector, embedding_provider = \$3, embedding_model = \$4, embedding_dimensions = \$5, memory_kind = 'semantic', valid_from = \$6::timestamptz, supersedes_id = \$7::uuid, updated_at = \$6::timestamptz WHERE id = \$1::uuid AND namespace = \$8 RETURNING id, namespace$/;
  fake.on(PENDING_LOCK, () => [{ id: MEMORY_ID }]);
  fake.on(PREDECESSOR_LOCK, () => [{ id: PREDECESSOR_ID }]);
  fake.on(/^SELECT statement_timestamp\(\)::text AS revision_at/, () => [{ revision_at: '2026-11-01 10:00:02.123456+00' }]);
  fake.on(CLOSE, () => [{}]);
  fake.on(FINALIZE, params => [{ id: params[0], namespace: 'shared' }]);

  const successor = await withScopedClient({ namespaces: ['shared'], keyId: KEY_ID }, client =>
    commitAutomaticRevision(memory, PREDECESSOR_ID, auth, { client, finalizeExistingId: MEMORY_ID }));
  assert.deepEqual(successor, { id: MEMORY_ID, namespace: 'shared' });
  const texts = fake.clients[0].map(statement => statement.text);
  const sequence = ['SAVEPOINT belief_revision', PENDING_LOCK, PREDECESSOR_LOCK, /revision_at/, CLOSE, FINALIZE, AUDIT, 'RELEASE SAVEPOINT belief_revision', 'COMMIT']
    .map(pattern => texts.findIndex(text => typeof pattern === 'string' ? text === pattern : pattern.test(text)));
  assert.ok(sequence.every(index => index >= 0), sequence.join(','));
  assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b));
  assert.equal(texts.some(text => /^INSERT INTO memories/.test(text)), false);
  assert.deepEqual(statements(fake, PENDING_LOCK)[0].params, [MEMORY_ID, 'shared']);
  assert.deepEqual(statements(fake, PREDECESSOR_LOCK)[0].params, [PREDECESSOR_ID, 'shared', ['shared']]);
  assert.deepEqual(statements(fake, CLOSE)[0].params, [PREDECESSOR_ID, '2026-11-01 10:00:02.123456+00']);
  assert.deepEqual(statements(fake, FINALIZE)[0].params, [
    MEMORY_ID, SERIALIZED, 'gemini', 'gemini-embedding-2-preview', 768, '2026-11-01 10:00:02.123456+00', PREDECESSOR_ID, 'shared',
  ]);
  const [audit] = statements(fake, AUDIT);
  assert.deepEqual(audit.params.slice(0, 4), [KEY_ID, 'belief.supersede', 'shared', MEMORY_ID]);
  assert.equal(audit.params[6], AGENT_ID);

  // A row that is no longer pending rolls the savepoint back without touching the predecessor.
  fake.on(PENDING_LOCK, () => []);
  const stale = await withScopedClient({ namespaces: ['shared'], keyId: KEY_ID }, client =>
    commitAutomaticRevision(memory, PREDECESSOR_ID, auth, { client, finalizeExistingId: MEMORY_ID }));
  assert.equal(stale, null);
  const second = fake.clients[1].map(statement => statement.text);
  assert.ok(second.includes('ROLLBACK TO SAVEPOINT belief_revision'));
  assert.equal(second.some(text => CLOSE.test(text)), false);
  assert.equal(second.at(-1), 'COMMIT');

  // A constraint conflict inside the enclosing transaction is isolated and rethrown for the caller's classifier.
  fake.on(PENDING_LOCK, () => [{ id: MEMORY_ID }]);
  fake.on(CLOSE, () => { throw Object.assign(new Error('could not serialize'), { code: '40001' }); });
  await assert.rejects(
    withScopedClient({ namespaces: ['shared'], keyId: KEY_ID }, async client => {
      await assert.rejects(commitAutomaticRevision(memory, PREDECESSOR_ID, auth, { client, finalizeExistingId: MEMORY_ID }), { code: '40001' });
      const texts = fake.clients.at(-1)!.map(statement => statement.text);
      assert.equal(texts.at(-1), 'ROLLBACK TO SAVEPOINT belief_revision');
      throw new Error('stop');
    }),
    /stop/,
  );
  assert.equal(await withScopedClient({ namespaces: ['shared'], keyId: KEY_ID }, client =>
    commitAutomaticRevision(memory, MEMORY_ID, auth, { client, finalizeExistingId: MEMORY_ID })), null);

  // Without a client the revision keeps its own transaction and insert path.
  fake.on(CLOSE, () => [{}]);
  fake.on(/^INSERT INTO memories \( content, embedding/, () => [{ id: CANONICAL_ID, namespace: 'shared' }]);
  const inserted = await commitAutomaticRevision(memory, PREDECESSOR_ID, auth);
  assert.deepEqual(inserted, { id: CANONICAL_ID, namespace: 'shared' });
  const standalone = fake.clients.at(-1)!.map(statement => statement.text);
  assert.equal(standalone.some(text => /SAVEPOINT/.test(text)), false);
  assert.equal(standalone.some(text => PENDING_LOCK.test(text)), false);
  assert.ok(standalone.some(text => /^INSERT INTO memories/.test(text)));
  assert.equal(standalone.at(-1), 'COMMIT');
});

test('expired, forgotten and missing memories are cancelled at finalize without an embedding write', async t => {
  const fake = pool();
  captureWarnings(t);
  const current = job({ ttlSeconds: 1, dedupe: false, contradictionEligible: false });
  fake.on(JOB_LOCK, () => [jobRow({ ttl_seconds: 1, dedupe: false, contradiction_eligible: false })]);
  fake.on(MEMORY_LOCK, () => [memoryRow({ expires_at: new Date('2026-11-01T10:00:01.000Z'), expired: true })]);
  const expired = await withScopedClient(ingestionJobScope(current), client => finalizeIngestionJob(client, current, EMBEDDING));
  assert.deepEqual(expired, { outcome: 'cancelled', reason: 'expired' });
  const [cancel] = statements(fake, JOB_UPDATE);
  assert.match(cancel.text, /SET status = 'cancelled', failure_category = \$3, last_error_code = \$4, finalized_at = statement_timestamp\(\), locked_at = NULL, lease_expires_at = NULL, lease_token = NULL WHERE memory_id = \$1::uuid AND status = 'processing' AND lease_token = \$2::uuid/);
  assert.deepEqual(cancel.params, [MEMORY_ID, LEASE, 'expired', 'memory_expired']);
  assert.equal(statements(fake, /^UPDATE memories/).length, 0);
  assert.equal(statements(fake, AUDIT).length, 0);
  assert.equal(fake.clients[0].at(-1)?.text, 'COMMIT');

  fake.on(MEMORY_LOCK, () => [memoryRow({ deleted: true })]);
  assert.deepEqual(await withScopedClient(ingestionJobScope(current), client => finalizeIngestionJob(client, current, EMBEDDING)), { outcome: 'cancelled', reason: 'deleted' });
  assert.deepEqual(statements(fake, JOB_UPDATE).at(-1)!.params, [MEMORY_ID, LEASE, null, 'memory_deleted']);
  fake.on(MEMORY_LOCK, () => []);
  assert.deepEqual(await withScopedClient(ingestionJobScope(current), client => finalizeIngestionJob(client, current, EMBEDDING)), { outcome: 'cancelled', reason: 'missing' });
  assert.equal(statements(fake, /^UPDATE memories/).length, 0);

  // The content load reports the same conditions before any provider call.
  fake.on(LOAD_CONTENT, () => [{ content: SECRET, missing: false, deleted: false, expired: true }]);
  assert.deepEqual(await withScopedClient(ingestionJobScope(current), client => loadIngestionJobContent(client, current)), { available: false, reason: 'expired' });
  fake.on(LOAD_CONTENT, () => [{ content: SECRET, missing: false, deleted: true, expired: false }]);
  assert.deepEqual(await withScopedClient(ingestionJobScope(current), client => loadIngestionJobContent(client, current)), { available: false, reason: 'deleted' });
  fake.on(LOAD_CONTENT, () => [{ content: null, missing: true, deleted: false, expired: false }]);
  assert.deepEqual(await withScopedClient(ingestionJobScope(current), client => loadIngestionJobContent(client, current)), { available: false, reason: 'missing' });
  fake.on(LOAD_CONTENT, () => [{ content: SECRET, missing: false, deleted: false, expired: false }]);
  assert.deepEqual(await withScopedClient(ingestionJobScope(current), client => loadIngestionJobContent(client, current)), { available: true, content: SECRET });
  const [load] = statements(fake, LOAD_CONTENT);
  assert.match(load.text, /WHERE j\.memory_id = \$1::uuid AND j\.status = 'processing' AND j\.lease_token = \$2::uuid/);

  // The inline path cancels an expired job itself and reports queued, never ready.
  fake.on(LOAD_CONTENT, () => [{ content: SECRET, missing: false, deleted: false, expired: true }]);
  let embedCalls = 0;
  assert.deepEqual(
    await inlineEmbedAndFinalize(MEMORY_ID, OWNER_SCOPE, { budgetMs: 1000, embed: async () => { embedCalls += 1; return EMBEDDING; } }),
    { state: 'queued', reason: 'expired' },
  );
  assert.equal(embedCalls, 0);
  assert.deepEqual(statements(fake, JOB_UPDATE).at(-1)!.params, [MEMORY_ID, LEASE, 'expired', 'memory_expired']);
});

test('finalize refuses a vector from a different space than the job accepted', async t => {
  const fake = pool();
  captureWarnings(t);
  const current = job();
  const rotated = await withScopedClient(ingestionJobScope(current), client =>
    finalizeIngestionJob(client, current, { ...EMBEDDING, model: 'other-model' }));
  assert.deepEqual(rotated, { outcome: 'space_mismatch' });
  const [failed] = statements(fake, JOB_UPDATE);
  assert.match(failed.text, /SET status = 'embedding_failed', failure_category = 'space_mismatch', last_error_code = 'space_mismatch', finalized_at = statement_timestamp\(\), locked_at = NULL, lease_expires_at = NULL, lease_token = NULL WHERE memory_id = \$1::uuid AND status = 'processing' AND lease_token = \$2::uuid/);
  assert.deepEqual(failed.params, [MEMORY_ID, LEASE]);
  assert.equal(statements(fake, MEMORY_LOCK).length, 0);
  assert.equal(statements(fake, /^UPDATE memories/).length, 0);

  // The job's snapshot must also still be the active profile (operator rotated profiles mid-queue).
  fake.on(JOB_LOCK, () => [jobRow({ embedding_model: 'legacy-model' })]);
  const stale = await withScopedClient(ingestionJobScope(current), client =>
    finalizeIngestionJob(client, job({ embeddingModel: 'legacy-model' }), { ...EMBEDDING, model: 'legacy-model' }));
  assert.deepEqual(stale, { outcome: 'space_mismatch' });
  assert.equal(statements(fake, /^UPDATE memories/).length, 0);
  assert.equal(statements(fake, AUDIT).length, 0);

  // The inline path reports queued (the operator fixes it with reembed/requeue), not ready.
  fake.on(JOB_LOCK, () => [jobRow()]);
  assert.deepEqual(
    await inlineEmbedAndFinalize(MEMORY_ID, OWNER_SCOPE, { budgetMs: 1000, embed: async () => ({ ...EMBEDDING, provider: 'ollama' }) }),
    { state: 'queued', reason: 'space_mismatch' },
  );
});

test('embedding errors classify by typed status, abort, socket and validation shape, never by content', () => {
  const provider = (status: number, retryAfter?: string) =>
    new EmbeddingProviderError(`Gemini embedContent failed (${status}): ${SECRET}`, { status, retryAfter, provider: 'gemini' });
  const matrix: Array<[unknown, { category: string; errorCode: string; retryAfter: string | undefined; terminal: boolean }]> = [
    [provider(429, '30'), { category: 'rate_limited', errorCode: 'http_429', retryAfter: '30', terminal: false }],
    [provider(408), { category: 'transient', errorCode: 'http_408', retryAfter: undefined, terminal: false }],
    [provider(425), { category: 'transient', errorCode: 'http_425', retryAfter: undefined, terminal: false }],
    [provider(500), { category: 'transient', errorCode: 'http_500', retryAfter: undefined, terminal: false }],
    [provider(503, '120'), { category: 'transient', errorCode: 'http_503', retryAfter: '120', terminal: false }],
    [provider(401), { category: 'provider_auth', errorCode: 'http_401', retryAfter: undefined, terminal: false }],
    [provider(403), { category: 'provider_auth', errorCode: 'http_403', retryAfter: undefined, terminal: false }],
    [provider(400), { category: 'input_rejected', errorCode: 'http_400', retryAfter: undefined, terminal: true }],
    [provider(404), { category: 'input_rejected', errorCode: 'http_404', retryAfter: undefined, terminal: true }],
    [provider(413), { category: 'input_rejected', errorCode: 'http_413', retryAfter: undefined, terminal: true }],
    [provider(422), { category: 'input_rejected', errorCode: 'http_422', retryAfter: undefined, terminal: true }],
    [provider(402), { category: 'transient', errorCode: 'http_402', retryAfter: undefined, terminal: false }],
    [new DOMException('timed out', 'TimeoutError'), { category: 'transient', errorCode: 'provider_timeout', retryAfter: undefined, terminal: false }],
    [new DOMException('aborted', 'AbortError'), { category: 'transient', errorCode: 'aborted', retryAfter: undefined, terminal: false }],
    [new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }),
      { category: 'transient', errorCode: 'dns_error', retryAfter: undefined, terminal: false }],
    [new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'EAI_AGAIN' }) }),
      { category: 'transient', errorCode: 'dns_error', retryAfter: undefined, terminal: false }],
    [new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }),
      { category: 'transient', errorCode: 'connection_error', retryAfter: undefined, terminal: false }],
    [new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }),
      { category: 'transient', errorCode: 'connection_error', retryAfter: undefined, terminal: false }],
    [new TypeError('fetch failed'), { category: 'transient', errorCode: 'network_error', retryAfter: undefined, terminal: false }],
    [new Error('Gemini scalar embedding length 512 does not match 768'), { category: 'input_rejected', errorCode: 'invalid_vector', retryAfter: undefined, terminal: true }],
    [new Error('Gemini scalar embedding response did not contain a vector array'), { category: 'input_rejected', errorCode: 'invalid_vector', retryAfter: undefined, terminal: true }],
    [new Error('batch[0] embedding value at index 3 must be finite'), { category: 'input_rejected', errorCode: 'invalid_vector', retryAfter: undefined, terminal: true }],
    [new Error('Batch embedding count 1 does not match requested count 2'), { category: 'input_rejected', errorCode: 'invalid_vector', retryAfter: undefined, terminal: true }],
    [new Error(SECRET), { category: 'transient', errorCode: 'embed_error', retryAfter: undefined, terminal: false }],
    ['not even an error', { category: 'transient', errorCode: 'embed_error', retryAfter: undefined, terminal: false }],
  ];
  for (const [error, expected] of matrix) {
    const actual = classifyEmbeddingError(error);
    assert.deepEqual(actual, expected, `classification of ${String(error)}`);
    assert.match(actual.errorCode, /^[a-z0-9_.-]{1,64}$/);
    assert.ok(INGESTION_FAILURE_CATEGORIES.includes(actual.category));
  }
});

test('failIngestionJob applies the bounded backoff, honors Retry-After, and dead-letters terminal or exhausted jobs', async t => {
  const fake = pool();
  captureWarnings(t);
  const now = new Date('2026-11-01T12:00:00.000Z');
  const seconds = (at: Date | null) => at === null ? null : (at.getTime() - now.getTime()) / 1000;
  const fail = (current: IngestionJob, error: unknown) =>
    withScopedClient(ingestionJobScope(current), client => failIngestionJob(client, current, error, { maxAttempts: 12, now }));
  const provider = (status: number, retryAfter?: string) =>
    new EmbeddingProviderError(`failed (${status})`, { status, retryAfter, provider: 'gemini' });

  const limited = await fail(job({ attempts: 1 }), provider(429, '300'));
  assert.equal(limited.applied, true);
  assert.equal(limited.status, 'retry_wait');
  assert.equal(limited.classification.category, 'rate_limited');
  const limitedDelay = seconds(limited.nextAttemptAt)!;
  assert.ok(limitedDelay >= 300 && limitedDelay <= 360, `Retry-After wins over the 60s base: ${limitedDelay}`);
  const [update] = statements(fake, JOB_UPDATE);
  assert.match(update.text, /SET status = \$3, next_attempt_at = COALESCE\(\$4::timestamptz, next_attempt_at\), last_error_code = \$5, failure_category = \$6, finalized_at = CASE WHEN \$3 = 'embedding_failed' THEN statement_timestamp\(\) ELSE NULL END, locked_at = NULL, lease_expires_at = NULL, lease_token = NULL WHERE memory_id = \$1::uuid AND status = 'processing' AND lease_token = \$2::uuid/);
  assert.doesNotMatch(update.text, /attempts =/);
  assert.deepEqual(update.params, [MEMORY_ID, LEASE, 'retry_wait', limited.nextAttemptAt, 'http_429', 'rate_limited']);

  const shortRetryAfter = await fail(job({ attempts: 1 }), provider(429, '5'));
  const shortDelay = seconds(shortRetryAfter.nextAttemptAt)!;
  assert.ok(shortDelay >= 60 && shortDelay <= 72, `base schedule is a floor: ${shortDelay}`);

  const dated = await fail(job({ attempts: 1 }), provider(429, new Date(now.getTime() + 600_000).toUTCString()));
  const datedDelay = seconds(dated.nextAttemptAt)!;
  assert.ok(datedDelay >= 599 && datedDelay <= 720, `HTTP-date Retry-After: ${datedDelay}`);

  const capped = await fail(job({ attempts: 1 }), provider(429, '100000'));
  assert.equal(seconds(capped.nextAttemptAt), 43_200);

  for (const [attempts, base] of [[1, 60], [2, 300], [3, 1800], [4, 7200], [5, 43200], [9, 43200]] as const) {
    const transient = await fail(job({ attempts }), provider(503));
    assert.equal(transient.status, 'retry_wait');
    assert.equal(transient.classification.category, 'transient');
    const delay = seconds(transient.nextAttemptAt)!;
    assert.ok(delay >= base && delay <= Math.min(43_200, base * 1.2), `attempt ${attempts}: ${delay} within [${base}, ${base * 1.2}]`);
  }

  const timeout = await fail(job({ attempts: 2 }), new DOMException('timed out', 'TimeoutError'));
  assert.equal(timeout.classification.errorCode, 'provider_timeout');
  assert.ok(seconds(timeout.nextAttemptAt)! >= 300);

  const auth = await fail(job({ attempts: 1 }), provider(401));
  assert.equal(auth.status, 'retry_wait');
  assert.equal(auth.classification.category, 'provider_auth');
  assert.equal(seconds(auth.nextAttemptAt), 43_200, 'credential failures wait at the cap, never hot-loop');

  const rejected = await fail(job({ attempts: 1 }), provider(400));
  assert.equal(rejected.status, 'embedding_failed');
  assert.equal(rejected.nextAttemptAt, null);
  assert.deepEqual(statements(fake, JOB_UPDATE).at(-1)!.params, [MEMORY_ID, LEASE, 'embedding_failed', null, 'http_400', 'input_rejected']);
  const invalid = await fail(job({ attempts: 1 }), new Error('Gemini scalar embedding length 10 does not match 768'));
  assert.equal(invalid.status, 'embedding_failed');
  assert.equal(invalid.classification.errorCode, 'invalid_vector');

  const exhausted = await fail(job({ attempts: 12 }), provider(503));
  assert.equal(exhausted.status, 'embedding_failed');
  assert.equal(exhausted.classification.category, 'transient');
  assert.equal(exhausted.nextAttemptAt, null);
  const stillRetrying = await fail(job({ attempts: 11 }), provider(503));
  assert.equal(stillRetrying.status, 'retry_wait');
  const envBound = await withScopedClient(ingestionJobScope(job()), client =>
    failIngestionJob(client, job({ attempts: 3 }), provider(503), { now }));
  assert.equal(envBound.status, 'retry_wait', 'default MEMORY_INGESTION_MAX_ATTEMPTS is 12');

  // Every failure write clears the lease and keeps the accepted row untouched.
  for (const statement of statements(fake, JOB_UPDATE)) {
    assert.match(statement.text, /locked_at = NULL, lease_expires_at = NULL, lease_token = NULL/);
  }
  assert.equal(statements(fake, /^UPDATE memories/).length, 0);
  assert.equal(statements(fake, /DELETE/).length, 0);
});

test('requeue resets only failed or cancelled jobs, rejects the rest with typed errors, and audits', async t => {
  const fake = pool();
  captureWarnings(t);
  const REQUEUE_LOCK = /^SELECT j\.memory_id, j\.namespace, j\.status, j\.attempts FROM memory_ingestion_jobs j WHERE j\.memory_id = \$1::uuid FOR UPDATE$/;
  const adminScope: DbScope = { namespaces: ['shared'], keyId: ADMIN_KEY_ID, isAdmin: true };
  fake.on(REQUEUE_LOCK, () => []);
  await assert.rejects(
    withScopedClient(adminScope, client => requeueIngestionJob(client, MEMORY_ID, { keyId: ADMIN_KEY_ID })),
    (error: unknown) => error instanceof IngestionJobNotFoundError && error.statusCode === 404 && error.code === 'ingestion_job_not_found',
  );
  for (const status of ['ready', 'deduplicated', 'pending', 'processing', 'retry_wait']) {
    fake.on(REQUEUE_LOCK, () => [{ memory_id: MEMORY_ID, namespace: 'shared', status, attempts: 2 }]);
    await assert.rejects(
      withScopedClient(adminScope, client => requeueIngestionJob(client, MEMORY_ID, { keyId: ADMIN_KEY_ID })),
      (error: unknown) => error instanceof IngestionJobStateConflictError && error.statusCode === 409 &&
        error.code === 'ingestion_job_state_conflict' && error.status === status,
    );
  }
  assert.equal(statements(fake, JOB_UPDATE).length, 0);
  assert.equal(statements(fake, AUDIT).length, 0);

  fake.on(REQUEUE_LOCK, () => [{ memory_id: MEMORY_ID, namespace: 'shared', status: 'embedding_failed', attempts: '5' }]);
  const requeued = await withScopedClient(adminScope, client => requeueIngestionJob(client, MEMORY_ID, { keyId: ADMIN_KEY_ID }));
  assert.deepEqual(requeued, {
    memory_id: MEMORY_ID, namespace: 'shared', previous_status: 'embedding_failed', previous_attempts: 5, requeued_at: READY_AT,
  });
  const [reset] = statements(fake, JOB_UPDATE);
  assert.match(reset.text, /SET status = 'pending', attempts = 0, next_attempt_at = statement_timestamp\(\), locked_at = NULL, lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL, failure_category = NULL, finalized_at = NULL, requeued_by = \$2, requeued_at = statement_timestamp\(\) WHERE memory_id = \$1::uuid AND status IN \('embedding_failed', 'cancelled'\) RETURNING requeued_at/);
  assert.deepEqual(reset.params, [MEMORY_ID, ADMIN_KEY_ID]);
  const [audit] = statements(fake, AUDIT);
  assert.deepEqual(audit.params.slice(0, 4), [ADMIN_KEY_ID, 'ingestion.requeue', 'shared', MEMORY_ID]);
  assert.deepEqual(audit.params.slice(8, 10), ['memory', MEMORY_ID]);
  assert.equal(audit.params[10], JSON.stringify({ requeued: true, attempts: 5 }));
  assert.equal(fake.clients.at(-1)?.at(-1)?.text, 'COMMIT');

  fake.on(REQUEUE_LOCK, () => [{ memory_id: MEMORY_ID, namespace: 'shared', status: 'cancelled', attempts: 0 }]);
  const cancelled = await withScopedClient(adminScope, client => requeueIngestionJob(client, MEMORY_ID, { keyId: ADMIN_KEY_ID }));
  assert.equal(cancelled.previous_status, 'cancelled');
});

test('ingestionStats aggregates the queue without reading content and surfaces worker health', async () => {
  const fake = pool();
  fake.on(/^SELECT status, count\(\*\)::int AS count FROM memory_ingestion_jobs GROUP BY status$/, () => [
    { status: 'pending', count: '3' }, { status: 'retry_wait', count: 2 }, { status: 'ready', count: 40 }, { status: 'embedding_failed', count: 1 },
  ]);
  fake.on(/oldest_pending_age_seconds/, () => [{ oldest_pending_age_seconds: '125.5', next_retry_at: READY_AT }]);
  fake.on(/^SELECT attempts, count\(\*\)::int AS count/, () => [{ attempts: 0, count: 3 }, { attempts: '2', count: '2' }, { attempts: 12, count: 1 }]);
  fake.on(/^SELECT failure_category, count\(\*\)::int AS count/, () => [{ failure_category: 'transient', count: 2 }, { failure_category: 'input_rejected', count: '1' }]);
  fake.on(/^SELECT ingestion_paused, ingestion_worker_seen_at FROM instance_settings/, () => [{ ingestion_paused: true, ingestion_worker_seen_at: ACCEPTED_AT }]);
  const stats = await withScopedClient({ namespaces: ['shared'], keyId: ADMIN_KEY_ID, isAdmin: true }, client => ingestionStats(client));
  assert.deepEqual(stats, {
    depth: { pending: 3, processing: 0, retry_wait: 2, ready: 40, deduplicated: 0, embedding_failed: 1, cancelled: 0 },
    queued: 5,
    oldest_pending_age_seconds: 125.5,
    next_retry_at: READY_AT,
    attempts_histogram: [{ attempts: 0, count: 3 }, { attempts: 2, count: 2 }, { attempts: 12, count: 1 }],
    failure_categories: { transient: 2, rate_limited: 0, provider_auth: 0, input_rejected: 1, space_mismatch: 0, expired: 0 },
    inline: { attempted: 0, ready: 0, deduplicated: 0, queued: 0 },
    worker: { paused: true, last_seen_at: ACCEPTED_AT },
  });
  for (const statement of fake.statements) {
    assert.doesNotMatch(statement.text, /\bcontent\b|\bmemories\b/);
  }
  fake.on(/oldest_pending_age_seconds/, () => [{ oldest_pending_age_seconds: null, next_retry_at: null }]);
  fake.on(/^SELECT ingestion_paused, ingestion_worker_seen_at FROM instance_settings/, () => []);
  const empty = await withScopedClient({ namespaces: ['shared'], keyId: ADMIN_KEY_ID, isAdmin: true }, client => ingestionStats(client));
  assert.equal(empty.oldest_pending_age_seconds, null);
  assert.deepEqual(empty.worker, { paused: false, last_seen_at: null });
});

test('read-path status helpers expose state without content and collapse in-flight statuses to queued', () => {
  assert.equal(ingestionStatusJoinSql(), 'LEFT JOIN memory_ingestion_jobs ij ON ij.memory_id = m.id AND ij.namespace = m.namespace');
  const select = normalized(ingestionStatusSelectSql('mem', 'job'));
  assert.match(select, /WHEN job\.memory_id IS NOT NULL THEN jsonb_build_object\( 'state', CASE WHEN job\.status IN \('pending', 'processing', 'retry_wait'\) THEN 'queued' ELSE job\.status END/);
  assert.match(select, /'next_retry_at', CASE WHEN job\.status = 'retry_wait' THEN job\.next_attempt_at ELSE NULL END/);
  assert.match(select, /WHEN mem\.embedding IS NULL THEN jsonb_build_object\('state', 'queued'\) ELSE NULL END/);
  assert.doesNotMatch(select, /content|source_key|lease_token/);
  for (const key of ['accepted_at', 'ready_at', 'attempts', 'failure_category', 'canonical_memory_id', 'similarity']) {
    assert.match(select, new RegExp(`'${key}', job\\.${key}`));
  }
  assert.deepEqual(ingestionStatusFromJob({
    status: 'retry_wait', accepted_at: ACCEPTED_AT, ready_at: null, attempts: '3', next_attempt_at: READY_AT,
    failure_category: 'transient', canonical_memory_id: null,
  }), {
    state: 'queued', accepted_at: ACCEPTED_AT.toISOString(), ready_at: null, attempts: 3,
    next_retry_at: READY_AT.toISOString(), failure_category: 'transient', canonical_memory_id: null, similarity: null,
  });
  assert.deepEqual(ingestionStatusFromJob({
    status: 'deduplicated', accepted_at: ACCEPTED_AT.toISOString(), ready_at: READY_AT, attempts: 1, next_attempt_at: READY_AT,
    failure_category: null, canonical_memory_id: CANONICAL_ID, similarity: '0.97',
  }), {
    state: 'deduplicated', accepted_at: ACCEPTED_AT.toISOString(), ready_at: READY_AT.toISOString(), attempts: 1,
    next_retry_at: null, failure_category: null, canonical_memory_id: CANONICAL_ID, similarity: 0.97,
  });
});

test('no SQL text, job parameter, metric or log line ever carries memory content', async t => {
  const fake = pool();
  const logs = captureWarnings(t);
  fake.on(CANDIDATE, () => [{ id: CANONICAL_ID, namespace: 'shared', similarity: 0.99 }]);
  await withScopedClient(OWNER_SCOPE, client => acceptMemory(client, {
    content: SECRET, source: SECRET, namespace: 'shared', tags: [SECRET], metadata: { secret: SECRET },
    accessLevel: 'normal', clientId: KEY_ID, allowedNamespaces: ['shared'], agentId: AGENT_ID,
    sessionId: null, ttlSeconds: null, dedupe: true, contradictionEligible: true,
  }));
  await inlineEmbedAndFinalize(MEMORY_ID, OWNER_SCOPE, { budgetMs: 1000, embed: async () => EMBEDDING });
  await inlineEmbedAndFinalize(MEMORY_ID, OWNER_SCOPE, {
    budgetMs: 1000,
    embed: async () => { throw new EmbeddingProviderError(`Gemini embedContent failed (500): ${SECRET}`, { status: 500, retryAfter: undefined, provider: 'gemini' }); },
  });
  await withScopedClient(ingestionJobScope(job()), client => failIngestionJob(client, job(), new Error(SECRET), { maxAttempts: 12 }));
  await withScopedClient(ingestionJobScope(job()), client => finalizeIngestionJob(client, job(), { ...EMBEDDING, model: 'rotated' }));
  await withScopedClient(ingestionJobScope(job()), client => cancelIngestionJob(client, job(), 'deleted'));

  assert.ok(fake.statements.length > 20);
  for (const statement of fake.statements) {
    assert.doesNotMatch(statement.text, new RegExp(SECRET));
    if (/memory_ingestion_jobs|audit_log/.test(statement.text)) {
      assert.equal(JSON.stringify(statement.params).includes(SECRET), false, `content-free queue/audit params: ${statement.text}`);
    }
  }
  assert.ok(logs.length > 0);
  for (const line of logs) {
    assert.match(line, /^\[ingestion\] outcome=[a-z0-9_]+$/);
    assert.doesNotMatch(line, new RegExp(`${SECRET}|${MEMORY_ID}|${KEY_ID}|shared`));
  }
});
