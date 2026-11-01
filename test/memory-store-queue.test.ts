import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type pg from 'pg';
import request from 'supertest';
import { setPoolForTesting } from '../src/db.js';
import type { EmbeddingResult } from '../src/embedding.js';
import { TombstonedSourceKeyConflictError } from '../src/errors.js';
import { INGESTION_INLINE_LEASE_MS, type IngestionJobStatus } from '../src/ingestion.js';
import { keyedSourceKey, memoryStore, storeSchema, type MemoryStoreRuntimeOptions } from '../src/tools/store.js';
import type { AuthContext, StoreResult } from '../src/types.js';

const AUTH: AuthContext = {
  keyId: '11111111-1111-4111-8111-111111111111',
  name: 'tester',
  namespaces: ['shared', 'private'],
  permissions: ['write'],
  maxAccessLevel: 'secret',
};
const AGENT_ID = '44444444-4444-4444-8444-444444444444';
const CANONICAL_ID = '22222222-2222-4222-8222-222222222222';
const LEASE = '55555555-5555-4555-8555-555555555555';
const READY_AT = new Date('2026-11-01T10:00:01.000Z');
const EXPIRES_AT = new Date('2026-11-01T10:01:00.000Z');
const SECRET = 'DO-NOT-LOG-queued-store-content-91c4';
const EMBEDDING: EmbeddingResult = {
  vector: Array(768).fill(0.25), provider: 'gemini', model: 'gemini-embedding-2-preview', dimensions: 768,
};

type Statement = { text: string; params: unknown[] };
type MemoryRow = {
  id: string; namespace: string; content: string; embedded: boolean; source_key: string | null;
  deleted_at: string | null; created_at: Date; expires_at: Date | null; access_level: string;
};
type JobRow = {
  memory_id: string; namespace: string; status: IngestionJobStatus; attempts: number; accepted_at: Date;
  lease_token: string | null; last_error_code: string | null; failure_category: string | null;
  source_key: string | null; dedupe: boolean; contradiction_eligible: boolean; ttl_seconds: number | null;
  client_id: string; access_level: string; allowed_namespaces: string[]; agent_id: string | null; session_id: string | null;
};

function rows(list: unknown[], rowCount = list.length) {
  return { command: 'MOCK', rowCount, oid: 0, fields: [], rows: list };
}

const OWNED_CLAIM = /^UPDATE memory_ingestion_jobs j SET status = 'processing', lease_token = gen_random_uuid\(\),/;
const JOB_LOCK = /^SELECT j\.memory_id, .* FROM memory_ingestion_jobs j WHERE j\.memory_id = \$1::uuid AND j\.status = 'processing' AND j\.lease_token = \$2::uuid FOR UPDATE$/;
const LOAD_CONTENT = /^SELECT m\.content, m\.id IS NULL AS missing/;
const MEMORY_LOCK = /^SELECT m\.id, m\.namespace, m\.content, .* FROM memories m WHERE m\.id = \$1::uuid AND m\.namespace = \$2 FOR UPDATE$/;
const KEYED_PRIOR = /^SELECT m\.id, m\.namespace, m\.content = \$3 AS same_content, m\.embedding IS NOT NULL AS embedded, m\.created_at FROM memories m WHERE m\.client_id = \$1 AND m\.source_key = \$2 AND m\.deleted_at IS NULL$/;
const KEYED_JOB_LOCK = /^SELECT j\.status, j\.attempts, j\.accepted_at FROM memory_ingestion_jobs j WHERE j\.memory_id = \$1::uuid AND j\.namespace = \$2 FOR UPDATE$/;
const MEMORY_INSERT = /^INSERT INTO memories/;
const ENQUEUE = /^INSERT INTO memory_ingestion_jobs/;
const JOB_UPDATE = /^UPDATE memory_ingestion_jobs SET/;
const PLAIN_LANDING = /^UPDATE memories SET embedding = \$1::vector/;
const TOMBSTONE = /^UPDATE memories SET deleted_at = statement_timestamp\(\)/;
const BOOST = /^UPDATE memories SET access_count/;
const CANDIDATE = /AS similarity FROM memories m/;
const AUDIT = /^INSERT INTO audit_log/;

/**
 * A stateful stand-in for the memories/job tables: enough of the state machine
 * to drive acceptance, the inline claim, finalize, release, and keyed reuse.
 */
class QueuePool {
  memories: MemoryRow[] = [];
  jobs = new Map<string, JobRow>();
  statements: Statement[] = [];
  clients: Statement[][] = [];
  /** Dedupe candidate similarity returned at finalize; undefined means no candidate. */
  similarity: number | undefined;
  /** Throws from the keyed upsert to model an RLS-hidden conflict. */
  upsertError: Error | undefined;
  private sequence = 0;

  async connect() {
    const own: Statement[] = [];
    this.clients.push(own);
    return {
      query: async (text: string, params: unknown[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        const statement = { text: sql, params };
        this.statements.push(statement);
        own.push(statement);
        if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/.test(sql)) return rows([]);
        if (sql.startsWith("SELECT set_config('app.")) return rows([]);
        if (/^INSERT INTO agents/.test(sql)) return rows([{ id: AGENT_ID }]);
        if (AUDIT.test(sql)) return rows([]);
        if (/^SELECT pg_advisory_xact_lock/.test(sql)) return rows([{}]);
        if (KEYED_PRIOR.test(sql)) {
          const row = this.memories.find(m => m.source_key === params[1] && m.deleted_at === null);
          return rows(row ? [{
            id: row.id, namespace: row.namespace, same_content: row.content === params[2], embedded: row.embedded, created_at: row.created_at,
          }] : []);
        }
        if (KEYED_JOB_LOCK.test(sql)) {
          const job = this.jobs.get(String(params[0]));
          return rows(job ? [{ status: job.status, attempts: job.attempts, accepted_at: job.accepted_at }] : []);
        }
        if (MEMORY_INSERT.test(sql)) return this.insertMemory(sql, params);
        if (/^SELECT 1 FROM memories WHERE source_key = \$1 AND client_id = \$2 AND deleted_at IS NOT NULL/.test(sql)) {
          return rows(this.memories.some(m => m.source_key === params[0] && m.deleted_at !== null) ? [{ '?column?': 1 }] : []);
        }
        if (/^SELECT 1 FROM memories WHERE source_key = \$1 AND client_id = \$2 AND deleted_at IS NULL AND superseded_at IS NOT NULL/.test(sql)) {
          return rows([]);
        }
        if (ENQUEUE.test(sql)) {
          const job: JobRow = {
            memory_id: String(params[0]), namespace: String(params[1]), status: 'pending', attempts: 0,
            accepted_at: new Date(2026, 10, 1, 10, 0, ++this.sequence), lease_token: null, last_error_code: null,
            failure_category: null, client_id: String(params[6]), access_level: String(params[7]),
            allowed_namespaces: params[8] as string[], agent_id: params[9] as string | null, session_id: params[10] as string | null,
            source_key: params[11] as string | null, dedupe: params[12] === true, ttl_seconds: params[13] as number | null,
            contradiction_eligible: params[14] === true,
          };
          this.jobs.set(job.memory_id, job);
          return rows([{ memory_id: job.memory_id, accepted_at: job.accepted_at }]);
        }
        if (OWNED_CLAIM.test(sql)) {
          const job = this.jobs.get(String(params[0]));
          if (!job || job.status !== 'pending') return rows([]);
          job.status = 'processing';
          job.lease_token = LEASE;
          return rows([this.jobColumns(job)]);
        }
        if (LOAD_CONTENT.test(sql)) {
          const job = this.jobs.get(String(params[0]));
          if (!job || job.status !== 'processing' || job.lease_token !== params[1]) return rows([]);
          const memory = this.memories.find(m => m.id === job.memory_id)!;
          return rows([{ content: memory.content, missing: false, deleted: memory.deleted_at !== null, expired: false }]);
        }
        if (JOB_LOCK.test(sql)) {
          const job = this.jobs.get(String(params[0]));
          if (!job || job.status !== 'processing' || job.lease_token !== params[1]) return rows([]);
          return rows([this.jobColumns(job)]);
        }
        if (MEMORY_LOCK.test(sql)) {
          const memory = this.memories.find(m => m.id === params[0])!;
          return rows([{
            id: memory.id, namespace: memory.namespace, content: memory.content, source: 'tester', tags: ['t'],
            metadata: { note: SECRET }, expires_at: memory.expires_at, deleted: memory.deleted_at !== null, expired: false,
          }]);
        }
        if (CANDIDATE.test(sql)) {
          return rows(this.similarity === undefined ? [] : [{ id: CANONICAL_ID, namespace: 'shared', similarity: String(this.similarity) }]);
        }
        if (BOOST.test(sql)) return rows([{ id: CANONICAL_ID, namespace: 'shared', expires_at: null }]);
        if (TOMBSTONE.test(sql)) {
          const memory = this.memories.find(m => m.id === params[0])!;
          memory.deleted_at = '2026-11-01T10:00:02.000Z';
          return rows([], 1);
        }
        if (PLAIN_LANDING.test(sql)) {
          const memory = this.memories.find(m => m.id === params[4])!;
          memory.embedded = true;
          return rows([{ id: memory.id }]);
        }
        if (JOB_UPDATE.test(sql)) {
          const job = this.jobs.get(String(params[0]));
          if (!job || job.status !== 'processing' || job.lease_token !== params[1]) return rows([], 0);
          const status = /SET status = '([a-z_]+)'/.exec(sql)?.[1];
          if (status === 'pending') {
            job.status = 'pending';
            job.last_error_code = String(params[2]);
            job.failure_category = params[3] == null ? null : String(params[3]);
          } else if (status === 'ready' || status === 'deduplicated') {
            job.status = status;
            job.last_error_code = null;
          } else {
            throw new Error(`Unexpected job update: ${sql}`);
          }
          job.lease_token = null;
          return rows([{ ready_at: READY_AT }], 1);
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      release() {},
    };
  }

  async query(): Promise<never> { throw new Error('memory_store must use request-scoped clients'); }

  private insertMemory(sql: string, params: unknown[]) {
    // Answer exactly the columns the statement's RETURNING clause names.
    const returning = /RETURNING (.*)$/.exec(sql)![1];
    const project = (row: MemoryRow, created: boolean) => Object.fromEntries([
      ['id', row.id], ['namespace', row.namespace], ['expires_at', row.expires_at],
      ...(returning.includes('AS created') ? [['created', created]] : []),
      ...(returning.includes('created_at') ? [['created_at', row.created_at]] : []),
      ...(returning.includes('AS unembedded') ? [['unembedded', !row.embedded]] : []),
    ]);
    const keyed = /ON CONFLICT \(client_id, source_key\)/.test(sql);
    if (!keyed) {
      const row = this.newMemory(params, null);
      if (params[1] !== null) row.embedded = true;
      return rows([project(row, true)]);
    }
    if (this.upsertError) throw this.upsertError;
    const sourceKey = String(params[14]);
    const existing = this.memories.find(m => m.source_key === sourceKey);
    if (existing) {
      if (existing.deleted_at !== null) return rows([]);
      const queued = /CASE WHEN memories\.content = EXCLUDED\.content/.test(sql);
      if (existing.content !== String(params[0]) || !queued) {
        existing.content = String(params[0]);
        existing.embedded = params[1] !== null;
      }
      existing.namespace = String(params[3]);
      existing.access_level = String(params[6]);
      existing.expires_at = params[13] == null ? null : EXPIRES_AT;
      return rows([project(existing, false)]);
    }
    const row = this.newMemory(params, sourceKey);
    if (params[1] !== null) row.embedded = true;
    return rows([project(row, true)]);
  }

  private newMemory(params: unknown[], sourceKey: string | null): MemoryRow {
    const row: MemoryRow = {
      id: `m-${this.memories.length + 1}`, namespace: String(params[3]), content: String(params[0]), embedded: false,
      source_key: sourceKey, deleted_at: null, created_at: new Date(2026, 10, 1, 9, 0, ++this.sequence),
      expires_at: params[13] == null ? null : EXPIRES_AT, access_level: String(params[6]),
    };
    this.memories.push(row);
    return row;
  }

  private jobColumns(job: JobRow) {
    return {
      memory_id: job.memory_id, namespace: job.namespace, kind: 'store', source_revision: 0, document_id: null, chunk_index: null,
      client_id: job.client_id, access_level: job.access_level, allowed_namespaces: job.allowed_namespaces, agent_id: job.agent_id,
      session_id: job.session_id, source_key: job.source_key, dedupe: job.dedupe, ttl_seconds: job.ttl_seconds,
      contradiction_eligible: job.contradiction_eligible, embedding_provider: 'gemini', embedding_model: 'gemini-embedding-2-preview',
      embedding_dimensions: 768, status: job.status, attempts: job.attempts, next_attempt_at: job.accepted_at,
      lease_token: job.lease_token, lease_expires_at: new Date(job.accepted_at.getTime() + INGESTION_INLINE_LEASE_MS), accepted_at: job.accepted_at,
    };
  }
}

function pool(): QueuePool {
  const fake = new QueuePool();
  setPoolForTesting(fake as unknown as pg.Pool);
  return fake;
}

function statements(fake: QueuePool, pattern: RegExp): Statement[] {
  return fake.statements.filter(statement => pattern.test(statement.text));
}

function auditDetails(statement: Statement): unknown {
  return JSON.parse(String(statement.params[10]));
}

function gate(t: TestContext, enabled: boolean, inlineBudgetMs?: string): void {
  const previous = { gate: process.env.MEMORY_INGESTION_QUEUE_ENABLED, budget: process.env.MEMORY_STORE_INLINE_EMBED_MS };
  if (enabled) process.env.MEMORY_INGESTION_QUEUE_ENABLED = 'true';
  else delete process.env.MEMORY_INGESTION_QUEUE_ENABLED;
  if (inlineBudgetMs === undefined) delete process.env.MEMORY_STORE_INLINE_EMBED_MS;
  else process.env.MEMORY_STORE_INLINE_EMBED_MS = inlineBudgetMs;
  t.after(() => {
    if (previous.gate === undefined) delete process.env.MEMORY_INGESTION_QUEUE_ENABLED;
    else process.env.MEMORY_INGESTION_QUEUE_ENABLED = previous.gate;
    if (previous.budget === undefined) delete process.env.MEMORY_STORE_INLINE_EMBED_MS;
    else process.env.MEMORY_STORE_INLINE_EMBED_MS = previous.budget;
  });
}

/** The network must never be reached: every provider call goes through the embed hook. */
function forbidFetch(t: TestContext): { calls: number } {
  const counter = { calls: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    counter.calls += 1;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  return counter;
}

function mockEmbeddingFetch(t: TestContext): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    embedding: { values: Array(768).fill(0.1) },
  }), { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
}

function quietWarnings(t: TestContext): string[] {
  const lines: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.warn = originalWarn; });
  return lines;
}

function offline(): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
}

function assertQueuedStoreResult(result: StoreResult, expected: Omit<StoreResult, 'accepted_at'>): void {
  const { accepted_at, ...rest } = result;
  assert.ok(accepted_at instanceof Date, 'accepted_at is a Date');
  assert.deepEqual(rest, expected);
}

test('provider offline: the stable id is returned after durable acceptance, before any provider call completes', async t => {
  gate(t, true);
  const network = forbidFetch(t);
  const logs = quietWarnings(t);
  const fake = pool();
  let embedCalls: Array<{ content: string; statementsAtCall: number }> = [];
  const runtime: MemoryStoreRuntimeOptions = {
    embed: async content => {
      embedCalls.push({ content, statementsAtCall: fake.statements.length });
      throw offline();
    },
  };

  const result = await memoryStore(storeSchema.parse({ content: SECRET, tags: ['t'], metadata: { k: 'v' }, session_id: 'sess-1' }), AUTH, runtime);
  assertQueuedStoreResult(result, {
    id: 'm-1', namespace: 'shared', expires_at: null, created: true, deduplicated: false, state: 'queued',
  });
  assert.deepEqual(Object.keys(result), ['id', 'namespace', 'expires_at', 'created', 'deduplicated', 'state', 'accepted_at']);
  assert.equal(network.calls, 0);

  // Acceptance is one committed transaction: memory row (no vector, no identity), job row, audit.
  const acceptance = fake.clients.find(own => own.some(s => MEMORY_INSERT.test(s.text)))!;
  assert.ok(acceptance);
  const texts = acceptance.map(s => s.text);
  assert.equal(texts.at(-1), 'COMMIT');
  const [insertIndex, enqueueIndex, auditIndex] = [MEMORY_INSERT, ENQUEUE, AUDIT].map(p => texts.findIndex(text => p.test(text)));
  assert.ok(insertIndex > 0 && insertIndex < enqueueIndex && enqueueIndex < auditIndex);
  const insert = acceptance[insertIndex];
  assert.doesNotMatch(insert.text, /source_key|ON CONFLICT/);
  assert.equal(insert.params[0], SECRET);
  assert.deepEqual([insert.params[1], insert.params[10], insert.params[11], insert.params[12], insert.params[13]], [null, null, null, null, null]);
  assert.equal(insert.params[9], 'sess-1');
  const enqueue = acceptance[enqueueIndex];
  assert.deepEqual(enqueue.params.slice(0, 3), ['m-1', 'shared', 'store']);
  assert.deepEqual(enqueue.params.slice(6, 15), [AUTH.keyId, 'normal', ['shared', 'private'], AGENT_ID, 'sess-1', null, true, null, true]);
  assert.deepEqual(auditDetails(acceptance[auditIndex]), { created: true, deduplicated: false, queued: true });
  assert.deepEqual(acceptance[auditIndex].params.slice(0, 4), [AUTH.keyId, 'memory.store', 'shared', 'm-1']);

  // The provider was asked exactly once, only after that COMMIT, with the accepted content.
  assert.equal(embedCalls.length, 1);
  assert.equal(embedCalls[0].content, SECRET);
  const commitIndex = fake.statements.indexOf(acceptance[acceptance.length - 1]);
  assert.ok(embedCalls[0].statementsAtCall > commitIndex, 'embedding starts only after durable acceptance committed');

  // The inline failure released the job to the worker without counting an attempt or writing a vector.
  const job = fake.jobs.get('m-1')!;
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 0);
  assert.equal(job.lease_token, null);
  assert.equal(job.last_error_code, 'connection_error');
  assert.equal(fake.memories[0].embedded, false);
  assert.equal(statements(fake, /^UPDATE memories/).length, 0);
  assert.equal(statements(fake, AUDIT).length, 1);

  // Queue, audit and log surfaces never carry content.
  for (const statement of fake.statements) {
    assert.doesNotMatch(statement.text, new RegExp(SECRET));
    if (/memory_ingestion_jobs|audit_log/.test(statement.text)) {
      assert.equal(JSON.stringify(statement.params).includes(SECRET), false, statement.text);
    }
  }
  for (const line of logs.filter(line => line.startsWith('[ingestion]'))) {
    assert.match(line, /^\[ingestion\] outcome=[a-z0-9_]+$/);
  }

  // Expiring stores: TTL starts at acceptance, dedupe and belief events are off, still queued when offline.
  embedCalls = [];
  const expiring = await memoryStore(storeSchema.parse({ content: 'temporary', ttl: 60 }), AUTH, runtime);
  assertQueuedStoreResult(expiring, {
    id: 'm-2', namespace: 'shared', expires_at: EXPIRES_AT, created: true, deduplicated: false, state: 'queued',
  });
  const ttlInsert = statements(fake, MEMORY_INSERT).at(-1)!;
  assert.match(ttlInsert.text, /statement_timestamp\(\) \+ \$14::double precision \* interval '1 second'/);
  assert.equal(ttlInsert.params[13], 60);
  assert.deepEqual(statements(fake, ENQUEUE).at(-1)!.params.slice(12, 15), [false, 60, false]);
  assert.equal(embedCalls.length, 1);
});

test('provider ok: the request finalizes inline and reports ready with the synchronous dedupe outcome', async t => {
  gate(t, true);
  forbidFetch(t);
  quietWarnings(t);
  const runtime: MemoryStoreRuntimeOptions = { embed: async () => EMBEDDING };

  // No near-duplicate: plain landing of the accepted row.
  const plain = pool();
  const created = await memoryStore(storeSchema.parse({ content: 'fresh fact' }), AUTH, runtime);
  assertQueuedStoreResult(created, {
    id: 'm-1', namespace: 'shared', expires_at: null, created: true, deduplicated: false, state: 'ready',
  });
  assert.deepEqual(Object.keys(created), ['id', 'namespace', 'expires_at', 'created', 'deduplicated', 'state', 'accepted_at']);
  assert.equal(plain.jobs.get('m-1')!.status, 'ready');
  assert.equal(plain.memories[0].embedded, true);
  assert.equal(statements(plain, PLAIN_LANDING).length, 1);
  assert.ok(statements(plain, CANDIDATE).length === 1, 'dedupe runs at finalization');
  assert.deepEqual(statements(plain, AUDIT).map(s => s.params[1]), ['memory.store', 'memory.ingest.ready']);
  assert.deepEqual(auditDetails(statements(plain, AUDIT)[0]), { created: true, deduplicated: false, queued: true });
  // Claim/load, then finalize, each committed; finalize runs under the job's own scope.
  const transactions = plain.clients.filter(own => own.some(s => OWNED_CLAIM.test(s.text) || JOB_LOCK.test(s.text)));
  assert.equal(transactions.length, 2);
  for (const own of transactions) assert.equal(own.at(-1)?.text, 'COMMIT');
  const finalizeScope = transactions[1].find(s => s.text.startsWith("SELECT set_config('app.allowed_namespaces'") && s.text.includes('true'))!;
  assert.equal(finalizeScope.params[0], JSON.stringify(['shared']));

  // Near-duplicate at the threshold: today's reuse-and-boost result, the accepted row tombstoned.
  const duplicate = pool();
  duplicate.similarity = 0.99;
  const reused = await memoryStore(storeSchema.parse({ content: 'near duplicate', tags: ['new'] }), AUTH, runtime);
  assertQueuedStoreResult(reused, {
    id: CANONICAL_ID, namespace: 'shared', expires_at: null, created: false, deduplicated: true, similarity: 0.99, state: 'ready',
  });
  assert.deepEqual(Object.keys(reused), ['id', 'namespace', 'expires_at', 'created', 'deduplicated', 'similarity', 'state', 'accepted_at']);
  assert.equal(duplicate.jobs.get('m-1')!.status, 'deduplicated');
  assert.notEqual(duplicate.memories[0].deleted_at, null);
  assert.equal(duplicate.memories[0].embedded, false);
  const boost = statements(duplicate, BOOST)[0];
  assert.deepEqual(boost.params, [CANONICAL_ID, ['t']]);
  assert.deepEqual(statements(duplicate, AUDIT).map(s => s.params[1]), ['memory.store', 'memory.ingest.deduplicated']);

  // Opt-out keeps the distinct row even with a perfect candidate available.
  const optOut = pool();
  optOut.similarity = 1;
  const distinct = await memoryStore(storeSchema.parse({ content: 'intentionally distinct', dedupe: false }), AUTH, runtime);
  assert.equal(distinct.state, 'ready');
  assert.deepEqual({ id: distinct.id, created: distinct.created, deduplicated: distinct.deduplicated }, { id: 'm-1', created: true, deduplicated: false });
  assert.equal(statements(optOut, CANDIDATE).length, 0);
  assert.equal(statements(optOut, ENQUEUE)[0].params[12], false);
});

test('budget exceeded: a slow provider is cut off at the inline budget and the request returns queued', async t => {
  gate(t, true, '50');
  forbidFetch(t);
  quietWarnings(t);
  const fake = pool();
  let aborted = false;
  const runtime: MemoryStoreRuntimeOptions = {
    // A real provider call holds a socket open; the stub holds a timer so the
    // unref'd budget timeout can fire before the event loop drains.
    embed: (_content, signal) => new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('budget never fired')), 5_000);
      signal.addEventListener('abort', () => { aborted = true; clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    }),
  };

  const started = Date.now();
  const result = await memoryStore(storeSchema.parse({ content: 'slow provider' }), AUTH, runtime);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, `returned in ${elapsed}ms, bounded by the 50ms budget plus margin`);
  assert.equal(aborted, true);
  assertQueuedStoreResult(result, {
    id: 'm-1', namespace: 'shared', expires_at: null, created: true, deduplicated: false, state: 'queued',
  });
  const job = fake.jobs.get('m-1')!;
  assert.deepEqual({ status: job.status, attempts: job.attempts, code: job.last_error_code, category: job.failure_category },
    { status: 'pending', attempts: 0, code: 'provider_timeout', category: 'transient' });
  assert.equal(fake.memories[0].embedded, false);

  // Budget 0 is always-async: durable acceptance only, no claim and no provider call.
  gate(t, true, '0');
  let embedCalls = 0;
  const async = await memoryStore(storeSchema.parse({ content: 'always async' }), AUTH, { embed: async () => { embedCalls += 1; return EMBEDDING; } });
  assert.equal(async.state, 'queued');
  assert.equal(embedCalls, 0);
  assert.equal(statements(fake, OWNED_CLAIM).length, 1, 'no second inline claim');
  assert.equal(fake.jobs.get('m-2')!.status, 'pending');
});

test('idempotency key reuse returns the same id and the current state in every job state', async t => {
  gate(t, true);
  forbidFetch(t);
  quietWarnings(t);
  const fake = pool();
  let providerUp = false;
  let embedCalls = 0;
  const runtime: MemoryStoreRuntimeOptions = {
    embed: async () => {
      embedCalls += 1;
      if (!providerUp) throw offline();
      return EMBEDDING;
    },
  };
  const text = (version: string) => `${SECRET}-${version}`;
  const keyed = (version: string, extra: Record<string, unknown> = {}) =>
    memoryStore(storeSchema.parse({ content: text(version), idempotency_key: 'same', ...extra }), AUTH, runtime);
  const sourceKey = keyedSourceKey(AUTH.keyId, 'same');
  const enqueues = () => statements(fake, ENQUEUE).length;
  const job = () => fake.jobs.get('m-1')!;
  const memory = () => fake.memories[0];

  // First keyed store with the provider down: created, queued, honored.
  const first = await keyed('v1');
  assertQueuedStoreResult(first, {
    id: 'm-1', namespace: 'shared', created: true, deduplicated: false, idempotency_key_honored: true, expires_at: null, state: 'queued',
  });
  assert.deepEqual(Object.keys(first), ['id', 'namespace', 'expires_at', 'created', 'deduplicated', 'idempotency_key_honored', 'state', 'accepted_at']);
  assert.equal(memory().source_key, sourceKey);
  assert.deepEqual({ status: job().status, attempts: job().attempts, dedupe: job().dedupe, belief: job().contradiction_eligible, key: job().source_key },
    { status: 'pending', attempts: 0, dedupe: false, belief: false, key: sourceKey });
  assert.equal(embedCalls, 1);
  assert.equal(enqueues(), 1);
  const acceptedAt = first.accepted_at!;
  // The keyed transaction reads the prior row, locks its job, then upserts: job before memory, like finalize.
  const keyedTransaction = fake.clients.find(own => own.some(s => KEYED_PRIOR.test(s.text)))!;
  const order = [KEYED_PRIOR, MEMORY_INSERT, ENQUEUE, AUDIT].map(p => keyedTransaction.findIndex(s => p.test(s.text)));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(keyedTransaction.at(-1)?.text, 'COMMIT');
  const upsert = keyedTransaction[order[1]];
  assert.match(upsert.text, /ON CONFLICT \(client_id, source_key\) DO UPDATE SET content = EXCLUDED\.content, embedding = CASE WHEN memories\.content = EXCLUDED\.content THEN memories\.embedding ELSE NULL END,/);
  assert.match(upsert.text, /embedding_provider = CASE WHEN memories\.content = EXCLUDED\.content THEN memories\.embedding_provider ELSE NULL END, embedding_model = CASE WHEN memories\.content = EXCLUDED\.content THEN memories\.embedding_model ELSE NULL END, embedding_dimensions = CASE WHEN memories\.content = EXCLUDED\.content THEN memories\.embedding_dimensions ELSE NULL END,/);
  assert.match(upsert.text, /memories\.namespace = ANY\(\$16::text\[\]\) AND EXCLUDED\.namespace = ANY\(\$16::text\[\]\) RETURNING id, namespace, expires_at, \(xmax = 0\) AS created, created_at, embedding IS NULL AS unembedded$/);
  assert.deepEqual([upsert.params[1], upsert.params[10], upsert.params[11], upsert.params[12], upsert.params[14]], [null, null, null, null, sourceKey]);
  assert.deepEqual(auditDetails(keyedTransaction[order[3]]), { created: true, deduplicated: false, idempotent: true, queued: true });

  // Pending + identical content: same id, current state, no job change, no provider call.
  const pendingRetry = await keyed('v1', { tags: ['refreshed'] });
  assertQueuedStoreResult(pendingRetry, {
    id: 'm-1', namespace: 'shared', created: false, deduplicated: false, idempotency_key_honored: true, expires_at: null, state: 'queued',
  });
  assert.equal(pendingRetry.accepted_at!.getTime(), acceptedAt.getTime());
  assert.equal(enqueues(), 1);
  assert.equal(embedCalls, 1);
  assert.equal(job().status, 'pending');
  assert.deepEqual(auditDetails(statements(fake, AUDIT).at(-1)!), { created: false, deduplicated: false, idempotent: true });
  assert.equal(statements(fake, KEYED_JOB_LOCK).at(-1)!.params[0], 'm-1');

  // Pending + changed content: payload replaced, the job stays pending (reset to attempts 0), inline runs again.
  job().attempts = 3;
  const pendingChanged = await keyed('v2');
  assert.equal(pendingChanged.state, 'queued');
  assert.equal(pendingChanged.created, false);
  assert.equal(memory().content, text('v2'));
  assert.equal(memory().embedded, false);
  assert.equal(enqueues(), 2);
  assert.equal(embedCalls, 2);
  assert.deepEqual({ status: job().status, attempts: job().attempts }, { status: 'pending', attempts: 0 });
  assert.ok(pendingChanged.accepted_at!.getTime() > acceptedAt.getTime(), 'a replaced payload is a new acceptance');
  assert.deepEqual(auditDetails(statements(fake, AUDIT).at(-1)!), { created: false, deduplicated: false, idempotent: true, queued: true });

  // retry_wait: identical content is a no-op; changed content resets the job.
  job().status = 'retry_wait'; job().attempts = 2;
  const waitingSame = await keyed('v2');
  assert.deepEqual({ state: waitingSame.state, status: job().status, attempts: job().attempts, enqueues: enqueues(), embeds: embedCalls },
    { state: 'queued', status: 'retry_wait', attempts: 2, enqueues: 2, embeds: 2 });
  const waitingChanged = await keyed('v3');
  assert.deepEqual({ state: waitingChanged.state, status: job().status, attempts: job().attempts, enqueues: enqueues(), embeds: embedCalls, content: memory().content },
    { state: 'queued', status: 'pending', attempts: 0, enqueues: 3, embeds: 3, content: text('v3') });

  // processing (a worker holds the lease): identical content leaves it alone; changed content takes it back.
  job().status = 'processing'; job().lease_token = 'worker-lease';
  const inFlightSame = await keyed('v3');
  assert.deepEqual({ state: inFlightSame.state, status: job().status, lease: job().lease_token, enqueues: enqueues(), embeds: embedCalls },
    { state: 'queued', status: 'processing', lease: 'worker-lease', enqueues: 3, embeds: 3 });
  const inFlightChanged = await keyed('v4');
  assert.deepEqual({ state: inFlightChanged.state, enqueues: enqueues(), embeds: embedCalls, content: memory().content },
    { state: 'queued', enqueues: 4, embeds: 4, content: text('v4') });
  assert.equal(job().status, 'pending', 'the reset cleared the worker lease; its finalize is now a no-op');

  // embedding_failed + changed content with the provider back: reset, inline lands it, ready.
  job().status = 'embedding_failed'; job().attempts = 12; job().failure_category = 'transient';
  providerUp = true;
  const recovered = await keyed('v5');
  assertQueuedStoreResult(recovered, {
    id: 'm-1', namespace: 'shared', created: false, deduplicated: false, idempotency_key_honored: true, expires_at: null, state: 'ready',
  });
  assert.deepEqual(Object.keys(recovered), ['id', 'namespace', 'expires_at', 'created', 'deduplicated', 'idempotency_key_honored', 'state', 'accepted_at']);
  assert.deepEqual({ status: job().status, embedded: memory().embedded, enqueues: enqueues(), embeds: embedCalls },
    { status: 'ready', embedded: true, enqueues: 5, embeds: 5 });
  assert.equal(statements(fake, CANDIDATE).length, 0, 'keyed stores never dedupe');

  // ready + identical content: today's refresh, vector kept, no requeue, no provider call.
  const readyAt = recovered.accepted_at!;
  const readySame = await keyed('v5', { namespace: 'private', tags: ['moved'] });
  assertQueuedStoreResult(readySame, {
    id: 'm-1', namespace: 'private', created: false, deduplicated: false, idempotency_key_honored: true, expires_at: null, state: 'ready',
  });
  assert.equal(readySame.accepted_at!.getTime(), readyAt.getTime());
  assert.deepEqual({ status: job().status, embedded: memory().embedded, namespace: memory().namespace, enqueues: enqueues(), embeds: embedCalls },
    { status: 'ready', embedded: true, namespace: 'private', enqueues: 5, embeds: 5 });
  assert.deepEqual(auditDetails(statements(fake, AUDIT).at(-1)!), { created: false, deduplicated: false, idempotent: true });

  // ready + changed content: vector and identity cleared, job reset, inline re-embeds.
  const readyChanged = await keyed('v6', { namespace: 'private' });
  assert.deepEqual({ state: readyChanged.state, status: job().status, embedded: memory().embedded, enqueues: enqueues(), embeds: embedCalls },
    { state: 'ready', status: 'ready', embedded: true, enqueues: 6, embeds: 6 });

  // embedding_failed + identical content: the caller's retry re-queues the content it still owns.
  job().status = 'embedding_failed'; memory().embedded = false;
  const failedSame = await keyed('v6', { namespace: 'private' });
  assert.deepEqual({ state: failedSame.state, status: job().status, enqueues: enqueues(), embeds: embedCalls },
    { state: 'ready', status: 'ready', enqueues: 7, embeds: 7 });

  // cancelled (expired) + identical content with a fresh ttl: re-queued the same way.
  job().status = 'cancelled'; memory().embedded = false;
  const revived = await keyed('v6', { namespace: 'private', ttl: 60 });
  assert.deepEqual({ state: revived.state, expires: revived.expires_at, status: job().status, enqueues: enqueues() },
    { state: 'ready', expires: EXPIRES_AT, status: 'ready', enqueues: 8 });

  // A row stored before the gate existed (no job row, vector present): ready, accepted when created.
  fake.jobs.delete('m-1'); memory().embedded = true;
  const legacy = await keyed('v6', { namespace: 'private', ttl: 60 });
  assertQueuedStoreResult(legacy, {
    id: 'm-1', namespace: 'private', created: false, deduplicated: false, idempotency_key_honored: true, expires_at: EXPIRES_AT, state: 'ready',
  });
  assert.equal(legacy.accepted_at!.getTime(), memory().created_at.getTime());
  assert.equal(enqueues(), 8);
  assert.equal(fake.jobs.has('m-1'), false);

  // A tenant with its own key gets its own row; the conflict branches are unchanged.
  const other = { ...AUTH, keyId: '22222222-2222-4222-8222-222222222222', name: 'other' };
  const tenant = await memoryStore(storeSchema.parse({ content: 'v1', idempotency_key: 'same' }), other, runtime);
  assert.deepEqual({ id: tenant.id, created: tenant.created, key: fake.memories[1].source_key }, { id: 'm-2', created: true, key: keyedSourceKey(other.keyId, 'same') });
  memory().deleted_at = '2026-11-01T11:00:00.000Z';
  await assert.rejects(keyed('v7', { namespace: 'private' }), (error: unknown) => error instanceof TombstonedSourceKeyConflictError);
  assert.equal(fake.clients.at(-1)?.at(-1)?.text, 'ROLLBACK');
  memory().deleted_at = null;
  fake.upsertError = Object.assign(new Error('duplicate key value violates unique constraint "memories_client_source_key_key"'), { code: '23505' });
  await assert.rejects(keyed('v7', { namespace: 'private' }), { message: 'Access denied to existing idempotent memory' });
  fake.upsertError = undefined;
  assert.equal(enqueues(), 9);

  for (const statement of fake.statements) {
    if (/memory_ingestion_jobs|audit_log/.test(statement.text)) {
      assert.equal(JSON.stringify(statement.params).includes(SECRET), false, `content-free queue/audit params: ${statement.text}`);
    }
  }
});

test('gate off: the legacy result shape, SQL and REST body are unchanged', async t => {
  gate(t, false);
  mockEmbeddingFetch(t);
  quietWarnings(t);
  const fake = pool();
  let hookCalls = 0;
  const runtime: MemoryStoreRuntimeOptions = { embed: async () => { hookCalls += 1; return EMBEDDING; } };

  const plain = await memoryStore(storeSchema.parse({ content: 'legacy insert', dedupe: false }), AUTH, runtime);
  assert.deepEqual(plain, { id: 'm-1', namespace: 'shared', created: true, deduplicated: false, expires_at: null });
  assert.deepEqual(Object.keys(plain), ['id', 'namespace', 'expires_at', 'created', 'deduplicated']);
  assert.equal(hookCalls, 0, 'the synchronous path never consults the inline embed hook');
  const insert = statements(fake, MEMORY_INSERT)[0];
  assert.match(String(insert.params[1]), /^\[0\.1,/);
  assert.deepEqual(insert.params.slice(10, 13), ['gemini', 'gemini-embedding-2-preview', 768]);

  const keyed = await memoryStore(storeSchema.parse({ content: 'legacy keyed', idempotency_key: 'k' }), AUTH, runtime);
  assert.deepEqual(keyed, { id: 'm-2', namespace: 'shared', created: true, deduplicated: false, idempotency_key_honored: true, expires_at: null });
  assert.deepEqual(Object.keys(keyed), ['id', 'namespace', 'created', 'deduplicated', 'idempotency_key_honored', 'expires_at']);
  const upsert = statements(fake, MEMORY_INSERT)[1];
  assert.match(upsert.text, /DO UPDATE SET content = EXCLUDED\.content, embedding = EXCLUDED\.embedding, embedding_provider = EXCLUDED\.embedding_provider, embedding_model = EXCLUDED\.embedding_model, embedding_dimensions = EXCLUDED\.embedding_dimensions, source = EXCLUDED\.source,/);
  assert.match(upsert.text, /RETURNING id, namespace, expires_at, \(xmax = 0\) AS created$/);
  assert.doesNotMatch(upsert.text, /CASE WHEN memories\.content|unembedded|created_at/);

  assert.equal(fake.statements.some(s => /memory_ingestion_jobs|same_content/.test(s.text)), false, 'no queue table traffic when the gate is off');
  for (const detail of statements(fake, AUDIT).map(auditDetails) as Array<Record<string, unknown>>) {
    assert.equal('queued' in detail, false);
  }
  for (const value of ['TRUE', '1', 'yes', ' true', 'false']) {
    process.env.MEMORY_INGESTION_QUEUE_ENABLED = value;
    const result = await memoryStore(storeSchema.parse({ content: `gate ${value}`, dedupe: false }), AUTH, runtime);
    assert.equal('state' in result, false, `gate value ${JSON.stringify(value)} is off`);
  }

  const { createApp, setServerTestOverrides } = await import('../src/server.js');
  setServerTestOverrides({ validateKey: async () => AUTH });
  t.after(() => setServerTestOverrides({}));
  delete process.env.MEMORY_INGESTION_QUEUE_ENABLED;
  const response = await request(createApp())
    .post('/api/store')
    .set('Authorization', 'Bearer tr_test')
    .send({ content: 'legacy over REST', dedupe: false });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { id: 'm-8', namespace: 'shared', created: true, deduplicated: false, expires_at: null });
});

test('REST passes state and accepted_at through only when the queue is on', async t => {
  gate(t, true);
  const network = forbidFetch(t);
  quietWarnings(t);
  const fake = pool();
  const { createApp, setServerTestOverrides } = await import('../src/server.js');
  setServerTestOverrides({ validateKey: async () => AUTH });
  t.after(() => setServerTestOverrides({}));

  const started = Date.now();
  const response = await request(createApp())
    .post('/api/store')
    .set('Authorization', 'Bearer tr_test')
    .send({ content: 'queued over REST', idempotency_key: 'rest' });
  assert.equal(response.status, 200);
  assert.ok(Date.now() - started < 2_000);
  assert.ok(network.calls >= 1, 'without a hook the inline path uses the real provider client, which is offline');
  const { accepted_at, ...body } = response.body as Record<string, unknown>;
  assert.deepEqual(body, {
    id: 'm-1', namespace: 'shared', created: true, deduplicated: false, expires_at: null, idempotency_key_honored: true, state: 'queued',
  });
  assert.equal(typeof accepted_at, 'string');
  assert.equal(new Date(String(accepted_at)).toISOString(), accepted_at);
  assert.deepEqual(Object.keys(response.body), ['id', 'namespace', 'created', 'deduplicated', 'expires_at', 'idempotency_key_honored', 'state', 'accepted_at']);
  assert.equal(fake.jobs.get('m-1')!.status, 'pending');
  assert.equal(fake.jobs.get('m-1')!.last_error_code, 'connection_error');
});
