import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type pg from 'pg';
import { setPoolForTesting, withScopedClient } from '../src/db.js';
import { EmbeddingProviderError, type EmbeddingResult } from '../src/embedding.js';
import {
  INGESTION_LEASE_MS,
  claimIngestionJob,
  failIngestionJob,
  ingestionJobScope,
  type IngestionFailureCategory,
  type IngestionJob,
  type IngestionJobStatus,
} from '../src/ingestion.js';
import {
  INGESTION_WORKER_OUTCOMES,
  ingestionWorkerScope,
  parseIngestionWorkerCli,
  runIngestionWorker,
  type IngestionWorkerDeps,
  type IngestionWorkerOptions,
} from '../scripts/ingestion-worker.js';
import type { AuthContext } from '../src/types.js';

const WORKER_KEY_ID = '99999999-9999-4999-8999-999999999999';
const OWNER_KEY_ID = '11111111-1111-4111-8111-111111111111';
const CANONICAL_ID = '22222222-2222-4222-8222-222222222222';
const OLD_LEASE = '55555555-5555-4555-8555-555555555555';
const FOREIGN_LEASE = '77777777-7777-4777-8777-777777777777';
const VECTOR = Array(768).fill(0.125);
const EMBEDDING: EmbeddingResult = { vector: VECTOR, provider: 'gemini', model: 'gemini-embedding-2-preview', dimensions: 768 };
const WORKER_AUTH: AuthContext = {
  keyId: WORKER_KEY_ID, name: 'ingestion-worker', namespaces: ['shared', 'private'],
  permissions: ['admin', 'read', 'write'], maxAccessLevel: 'normal',
};

type Scope = { namespaces: string[]; keyId: string; admin: boolean };
type Statement = { text: string; params: unknown[]; scope: Scope };
type JobState = {
  memory_id: string; namespace: string; client_id: string; access_level: string; allowed_namespaces: string[];
  agent_id: string | null; session_id: string | null; source_key: string | null; dedupe: boolean; ttl_seconds: number | null;
  contradiction_eligible: boolean; embedding_provider: string; embedding_model: string; embedding_dimensions: number;
  status: IngestionJobStatus; attempts: number; next_attempt_at: Date; locked_at: Date | null; lease_expires_at: Date | null;
  lease_token: string | null; last_error_code: string | null; failure_category: IngestionFailureCategory | null;
  accepted_at: Date; ready_at: Date | null; finalized_at: Date | null; canonical_memory_id: string | null; similarity: number | null;
};
type MemoryState = {
  id: string; namespace: string; content: string; deleted: boolean; expires_at: Date | null;
  embedded: boolean; identity: [string, string, number] | null;
};

const WORKER_CLAIM = /^WITH candidate AS \(/;
const LOAD_CONTENT = /^SELECT m\.content, m\.id IS NULL AS missing/;
const JOB_LOCK = /^SELECT j\.memory_id, .* FROM memory_ingestion_jobs j WHERE j\.memory_id = \$1::uuid AND j\.status = 'processing' AND j\.lease_token = \$2::uuid FOR UPDATE$/;
const MEMORY_LOCK = /^SELECT m\.id, m\.namespace, m\.content, .* FROM memories m WHERE m\.id = \$1::uuid AND m\.namespace = \$2 FOR UPDATE$/;
const JOB_UPDATE = /^UPDATE memory_ingestion_jobs SET/;
const PLAIN_LANDING = /^UPDATE memories SET embedding = \$1::vector/;
const TOMBSTONE = /^UPDATE memories SET deleted_at = statement_timestamp\(\)/;
const BOOST = /^UPDATE memories SET access_count/;
const CANDIDATE = /AS similarity FROM memories m/;
const AUDIT = /^INSERT INTO audit_log/;
const PAUSED = /^SELECT ingestion_paused FROM instance_settings WHERE singleton = true$/;
const HEARTBEAT = /^UPDATE instance_settings SET ingestion_worker_seen_at = statement_timestamp\(\) WHERE singleton = true$/;
const ADVISORY = /^SELECT pg_advisory_xact_lock/;
const OWNER_WRITES = [LOAD_CONTENT, JOB_LOCK, MEMORY_LOCK, JOB_UPDATE, PLAIN_LANDING, TOMBSTONE, BOOST, CANDIDATE, AUDIT];

function rows(list: unknown[], rowCount = list.length) {
  return { command: 'MOCK', rowCount, oid: 0, fields: [], rows: list };
}

/**
 * A stateful stand-in for memory_ingestion_jobs, memories and
 * instance_settings: the claim/lease state machine, the owner-or-admin plus
 * namespace RLS rule, and enough of the finalize statements to land, dedupe
 * or cancel a job. It also records which transaction scope issued each
 * statement and whether any transaction or connection is open at a moment.
 */
class WorkerPool {
  jobs = new Map<string, JobState>();
  memories = new Map<string, MemoryState>();
  statements: Statement[] = [];
  transactions: Scope[] = [];
  audits: Array<{ action: string; details: string; scope: Scope }> = [];
  heartbeats: Scope[] = [];
  seenAt: Date | null = null;
  paused = false;
  /** Dedupe candidate similarity returned at finalize; undefined means no candidate. */
  similarity: number | undefined;
  /** Models a race where the accepted row changed before the landing UPDATE. */
  landingFails = false;
  openTransactions = 0;
  checkedOut = 0;
  private leaseSequence = 0;

  async connect() {
    this.checkedOut += 1;
    const scope: Scope = { namespaces: [], keyId: '', admin: false };
    let open = false;
    return {
      query: async (text: string, params: unknown[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        this.statements.push({ text: sql, params, scope: { ...scope, namespaces: [...scope.namespaces] } });
        if (sql === 'BEGIN') { open = true; this.openTransactions += 1; return rows([]); }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          if (open) { open = false; this.openTransactions -= 1; }
          return rows([]);
        }
        if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/.test(sql)) return rows([]);
        if (sql.startsWith("SELECT set_config('app.")) {
          const local = sql.includes(', true)');
          if (sql.includes('allowed_namespaces')) scope.namespaces = local ? JSON.parse(String(params[0])) as string[] : [];
          else if (sql.includes('current_key_id')) scope.keyId = local ? String(params[0]) : '';
          else {
            scope.admin = local && params[0] === 'true';
            if (local) this.transactions.push({ ...scope, namespaces: [...scope.namespaces] });
          }
          return rows([]);
        }
        return this.dispatch(sql, params, scope);
      },
      release: () => { this.checkedOut -= 1; },
    };
  }

  async query(): Promise<never> { throw new Error('the worker must use scoped transactions'); }

  seed(label: string, overrides: Partial<JobState & { expires_at: Date | null; deleted: boolean; withMemory: boolean }> = {}): string {
    const index = this.jobs.size + 1;
    const id = `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const acceptedAt = new Date(Date.UTC(2026, 10, 1, 10, 0, index));
    const { expires_at = null, deleted = false, withMemory = true, ...job } = overrides;
    this.jobs.set(id, {
      memory_id: id, namespace: 'shared', client_id: OWNER_KEY_ID, access_level: 'normal', allowed_namespaces: ['shared', 'private'],
      agent_id: null, session_id: null, source_key: null, dedupe: false, ttl_seconds: expires_at ? 60 : null,
      contradiction_eligible: false, embedding_provider: 'gemini', embedding_model: 'gemini-embedding-2-preview',
      embedding_dimensions: 768, status: 'pending', attempts: 0, next_attempt_at: acceptedAt, locked_at: null,
      lease_expires_at: null, lease_token: null, last_error_code: null, failure_category: null, accepted_at: acceptedAt,
      ready_at: null, finalized_at: null, canonical_memory_id: null, similarity: null, ...job,
    });
    if (withMemory) {
      this.memories.set(id, {
        id, namespace: job.namespace ?? 'shared', content: `DO-NOT-LOG-${label}`, deleted, expires_at, embedded: false, identity: null,
      });
    }
    return id;
  }

  job(id: string): JobState { return this.jobs.get(id)!; }
  memory(id: string): MemoryState { return this.memories.get(id)!; }
  matching(pattern: RegExp): Statement[] { return this.statements.filter(statement => pattern.test(statement.text)); }

  private dispatch(sql: string, params: unknown[], scope: Scope) {
    const visible = (job: JobState) => (scope.admin || job.client_id === scope.keyId) && scope.namespaces.includes(job.namespace);
    const now = new Date();
    if (PAUSED.test(sql)) return rows([{ ingestion_paused: this.paused }]);
    if (HEARTBEAT.test(sql)) {
      this.heartbeats.push({ ...scope });
      this.seenAt = now;
      return rows([], 1);
    }
    if (WORKER_CLAIM.test(sql)) {
      const job = [...this.jobs.values()].filter(visible).filter(candidate =>
        ((candidate.status === 'pending' || candidate.status === 'retry_wait') && candidate.next_attempt_at.getTime() <= now.getTime()) ||
        (candidate.status === 'processing' && candidate.lease_expires_at !== null && candidate.lease_expires_at.getTime() < now.getTime()))
        .sort((a, b) => a.next_attempt_at.getTime() - b.next_attempt_at.getTime() ||
          a.accepted_at.getTime() - b.accepted_at.getTime() || a.memory_id.localeCompare(b.memory_id))[0];
      if (!job) return rows([]);
      job.status = 'processing';
      job.attempts += 1;
      job.lease_token = `aaaaaaaa-aaaa-4aaa-8aaa-${String(++this.leaseSequence).padStart(12, '0')}`;
      job.locked_at = now;
      job.lease_expires_at = new Date(now.getTime() + Number(params[0]));
      job.last_error_code = null;
      return rows([this.columns(job)]);
    }
    if (LOAD_CONTENT.test(sql)) {
      const job = this.jobs.get(String(params[0]));
      if (!job || !visible(job) || job.status !== 'processing' || job.lease_token !== params[1]) return rows([]);
      const memory = this.memories.get(job.memory_id);
      if (!memory || !scope.namespaces.includes(memory.namespace)) return rows([{ content: null, missing: true, deleted: false, expired: false }]);
      return rows([{
        content: memory.content, missing: false, deleted: memory.deleted,
        expired: memory.expires_at !== null && memory.expires_at.getTime() <= now.getTime(),
      }]);
    }
    if (JOB_LOCK.test(sql)) {
      const job = this.jobs.get(String(params[0]));
      if (!job || !visible(job) || job.status !== 'processing' || job.lease_token !== params[1]) return rows([]);
      return rows([this.columns(job)]);
    }
    if (MEMORY_LOCK.test(sql)) {
      const memory = this.memories.get(String(params[0]));
      if (!memory || memory.namespace !== params[1] || !scope.namespaces.includes(memory.namespace)) return rows([]);
      return rows([{
        id: memory.id, namespace: memory.namespace, content: memory.content, source: 'tester', tags: ['t'], metadata: {},
        expires_at: memory.expires_at, deleted: memory.deleted,
        expired: memory.expires_at !== null && memory.expires_at.getTime() <= now.getTime(),
      }]);
    }
    if (ADVISORY.test(sql)) return rows([{}]);
    if (CANDIDATE.test(sql)) {
      return rows(this.similarity === undefined ? [] : [{ id: CANONICAL_ID, namespace: String(params[1]), similarity: String(this.similarity) }]);
    }
    if (BOOST.test(sql)) return rows([{ id: CANONICAL_ID, namespace: 'shared', expires_at: null }]);
    if (TOMBSTONE.test(sql)) {
      const memory = this.memories.get(String(params[0]));
      if (!memory || memory.deleted) return rows([], 0);
      memory.deleted = true;
      return rows([], 1);
    }
    if (PLAIN_LANDING.test(sql)) {
      const memory = this.memories.get(String(params[4]));
      if (this.landingFails || !memory || memory.deleted) return rows([]);
      memory.embedded = true;
      memory.identity = [String(params[1]), String(params[2]), Number(params[3])];
      return rows([{ id: memory.id }]);
    }
    if (JOB_UPDATE.test(sql)) return this.updateJob(sql, params, visible);
    if (AUDIT.test(sql)) {
      this.audits.push({ action: String(params[1]), details: String(params[10]), scope: { ...scope } });
      return rows([]);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }

  private updateJob(sql: string, params: unknown[], visible: (job: JobState) => boolean) {
    const job = this.jobs.get(String(params[0]));
    if (!job || !visible(job) || job.status !== 'processing' || job.lease_token !== params[1]) return rows([], 0);
    const now = new Date();
    const literal = /^UPDATE memory_ingestion_jobs SET status = '([a-z_]+)'/.exec(sql)?.[1];
    if (literal === 'ready') {
      Object.assign(job, { status: 'ready', ready_at: now, finalized_at: now, last_error_code: null, failure_category: null });
    } else if (literal === 'deduplicated') {
      Object.assign(job, {
        status: 'deduplicated', canonical_memory_id: String(params[2]), similarity: Number(params[3]),
        ready_at: now, finalized_at: now, last_error_code: null, failure_category: null,
      });
    } else if (literal === 'cancelled') {
      Object.assign(job, {
        status: 'cancelled', failure_category: params[2] == null ? null : String(params[2]), last_error_code: String(params[3]), finalized_at: now,
      });
    } else if (literal === 'embedding_failed') {
      Object.assign(job, { status: 'embedding_failed', failure_category: 'space_mismatch', last_error_code: 'space_mismatch', finalized_at: now });
    } else if (literal === 'pending') {
      Object.assign(job, { status: 'pending', last_error_code: String(params[2]), failure_category: params[3] == null ? null : String(params[3]) });
    } else if (/^UPDATE memory_ingestion_jobs SET status = \$3, next_attempt_at = COALESCE\(\$4::timestamptz, next_attempt_at\)/.test(sql)) {
      job.status = params[2] as IngestionJobStatus;
      if (params[3] != null) job.next_attempt_at = params[3] as Date;
      job.last_error_code = String(params[4]);
      job.failure_category = params[5] as IngestionFailureCategory;
      job.finalized_at = job.status === 'embedding_failed' ? now : null;
    } else {
      throw new Error(`Unexpected job update: ${sql}`);
    }
    job.locked_at = null;
    job.lease_expires_at = null;
    job.lease_token = null;
    return rows([{ ready_at: job.ready_at }], 1);
  }

  private columns(job: JobState) {
    return {
      memory_id: job.memory_id, namespace: job.namespace, kind: 'store', source_revision: 0, document_id: null, chunk_index: null,
      client_id: job.client_id, access_level: job.access_level, allowed_namespaces: job.allowed_namespaces, agent_id: job.agent_id,
      session_id: job.session_id, source_key: job.source_key, dedupe: job.dedupe, ttl_seconds: job.ttl_seconds,
      contradiction_eligible: job.contradiction_eligible, embedding_provider: job.embedding_provider,
      embedding_model: job.embedding_model, embedding_dimensions: job.embedding_dimensions, status: job.status,
      attempts: job.attempts, next_attempt_at: job.next_attempt_at, lease_token: job.lease_token,
      lease_expires_at: job.lease_expires_at, accepted_at: job.accepted_at,
    };
  }
}

function pool(): WorkerPool {
  const fake = new WorkerPool();
  setPoolForTesting(fake as unknown as pg.Pool);
  return fake;
}

function run(fake: WorkerPool, options: Partial<IngestionWorkerOptions> = {}, deps: IngestionWorkerDeps = {}) {
  return runIngestionWorker(
    { once: true, maxJobs: Number.MAX_SAFE_INTEGER, pollMs: 1000, concurrency: 1, ...options },
    {
      env: { INGESTION_WORKER_API_KEY: 'tr_worker' },
      authenticate: async () => WORKER_AUTH,
      sleep: async () => { throw new Error('the worker should not sleep in this scenario'); },
      embed: scripted(fake, {}),
      ...deps,
    },
  );
}

type Scripted = EmbeddingResult | Error | ((signal: AbortSignal) => Promise<EmbeddingResult>);

/**
 * Provider responses keyed by the accepted content. With one job in flight it
 * also asserts that no transaction or pool connection is held while embedding.
 */
function scripted(fake: WorkerPool, responses: Record<string, Scripted>, isolated = true) {
  return async (content: string, signal: AbortSignal): Promise<EmbeddingResult> => {
    if (isolated) {
      assert.equal(fake.openTransactions, 0, 'embedding must run outside any transaction');
      assert.equal(fake.checkedOut, 0, 'embedding must not hold a pool connection');
    }
    const response = responses[content.replace('DO-NOT-LOG-', '')];
    if (response === undefined) throw new Error('unscripted provider call');
    if (typeof response === 'function') return response(signal);
    if (response instanceof Error) throw response;
    return response;
  };
}

function provider(status: number, retryAfter?: string): EmbeddingProviderError {
  return new EmbeddingProviderError(`Gemini embedContent failed (${status}): provider body`, { status, retryAfter, provider: 'gemini' });
}
function refused(): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }) });
}

function captureLogs(t: TestContext): string[] {
  const lines: string[] = [];
  const original = { warn: console.warn, error: console.error, log: console.log };
  for (const level of ['warn', 'error', 'log'] as const) {
    console[level] = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  }
  t.after(() => { Object.assign(console, original); });
  return lines;
}

function seconds(from: number, at: Date): number {
  return (at.getTime() - from) / 1000;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('worker CLI enforces bounded concurrency and polling like the webhook worker', () => {
  assert.deepEqual(parseIngestionWorkerCli([], {}), { once: false, maxJobs: Number.MAX_SAFE_INTEGER, pollMs: 1000, concurrency: 4 });
  assert.deepEqual(parseIngestionWorkerCli(['--once', '--max-jobs', '2', '--poll-ms', '250', '--concurrency', '1'], {}),
    { once: true, maxJobs: 2, pollMs: 250, concurrency: 1 });
  assert.equal(parseIngestionWorkerCli([], { INGESTION_WORKER_CONCURRENCY: '8' }).concurrency, 8);
  assert.throws(() => parseIngestionWorkerCli(['--concurrency', '33'], {}), /--concurrency must be an integer from 1 to 32/);
  assert.throws(() => parseIngestionWorkerCli(['--concurrency', '0'], {}), /--concurrency/);
  assert.throws(() => parseIngestionWorkerCli(['--poll-ms', '10'], {}), /--poll-ms/);
  assert.throws(() => parseIngestionWorkerCli(['--max-jobs', 'x'], {}), /--max-jobs/);
  assert.throws(() => parseIngestionWorkerCli(['--drain'], {}), /Unknown ingestion worker option: --drain/);
  assert.throws(() => parseIngestionWorkerCli([], { INGESTION_WORKER_CONCURRENCY: '64' }), /INGESTION_WORKER_CONCURRENCY/);
  assert.deepEqual([...INGESTION_WORKER_OUTCOMES], ['ready', 'deduplicated', 'retry', 'failed', 'cancelled', 'stale', 'error']);
});

test('the worker refuses a missing, invalid, disabled or non-admin key before touching the queue', async () => {
  const fake = pool();
  fake.seed('never-claimed');
  await assert.rejects(run(fake, {}, { env: {} }), /INGESTION_WORKER_API_KEY is required/);
  await assert.rejects(run(fake, {}, { env: { INGESTION_WORKER_API_KEY: '   ' } }), /INGESTION_WORKER_API_KEY is required/);
  await assert.rejects(run(fake, {}, { authenticate: async () => null }), /Invalid or disabled ingestion worker API key/);
  const writer: AuthContext = { ...WORKER_AUTH, permissions: ['read', 'write'] };
  await assert.rejects(run(fake, {}, { authenticate: async () => writer }), /'admin' permission/);
  assert.throws(() => ingestionWorkerScope(writer), /'admin' permission/);
  assert.deepEqual(ingestionWorkerScope(WORKER_AUTH), { namespaces: ['shared', 'private'], keyId: WORKER_KEY_ID, isAdmin: true });
  assert.equal(fake.statements.length, 0, 'no poll, heartbeat or claim ran');
  assert.equal(fake.job([...fake.jobs.keys()][0]).status, 'pending');
});

test('scripted provider failures schedule bounded retries by category and dead-letter input rejections', async t => {
  const logs = captureLogs(t);
  const fake = pool();
  const ids = {
    limited: fake.seed('limited'), server: fake.seed('server'), timeout: fake.seed('timeout'), aborted: fake.seed('aborted'),
    refused: fake.seed('refused'), auth: fake.seed('auth'), rejected: fake.seed('rejected'),
  };
  const embed = scripted(fake, {
    limited: provider(429, '120'),
    server: provider(500),
    timeout: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    aborted: new DOMException('This operation was aborted', 'AbortError'),
    refused: refused(),
    auth: provider(401),
    rejected: provider(400),
  });
  const before = Date.now();
  const result = await run(fake, { concurrency: 1 }, { embed });
  assert.deepEqual(result, { processed: 7, ready: 0, deduplicated: 0, retry: 6, failed: 1, cancelled: 0, stale: 0, error: 0 });

  const expect = (id: string, status: IngestionJobStatus, category: IngestionFailureCategory, code: string, min: number | null, max: number | null) => {
    const job = fake.job(id);
    assert.equal(job.status, status, code);
    assert.equal(job.failure_category, category, code);
    assert.equal(job.last_error_code, code);
    assert.equal(job.attempts, 1, code);
    assert.equal(job.lease_token, null, 'the lease is released with the outcome');
    assert.equal(job.lease_expires_at, null);
    if (min === null || max === null) {
      assert.deepEqual(job.next_attempt_at, job.accepted_at, 'terminal jobs keep their schedule untouched');
      assert.ok(job.finalized_at, 'terminal jobs are finalized');
    } else {
      const delay = seconds(before, job.next_attempt_at);
      assert.ok(delay >= min && delay <= max, `${code}: ${delay}s within [${min}, ${max}]`);
      assert.equal(job.finalized_at, null);
    }
  };
  expect(ids.limited, 'retry_wait', 'rate_limited', 'http_429', 120, 145);
  expect(ids.server, 'retry_wait', 'transient', 'http_500', 60, 73);
  expect(ids.timeout, 'retry_wait', 'transient', 'provider_timeout', 60, 73);
  expect(ids.aborted, 'retry_wait', 'transient', 'aborted', 60, 73);
  expect(ids.refused, 'retry_wait', 'transient', 'connection_error', 60, 73);
  expect(ids.auth, 'retry_wait', 'provider_auth', 'http_401', 43_200, 43_201);
  expect(ids.rejected, 'embedding_failed', 'input_rejected', 'http_400', null, null);

  // Accepted content is never touched by a failure: no landing, tombstone, delete or audit.
  for (const id of Object.values(ids)) {
    const memory = fake.memory(id);
    assert.equal(memory.embedded, false);
    assert.equal(memory.deleted, false);
    assert.ok(memory.content.startsWith('DO-NOT-LOG-'));
  }
  assert.equal(fake.matching(/^UPDATE memories/).length, 0);
  assert.equal(fake.matching(/DELETE/).length, 0);
  assert.equal(fake.audits.length, 0);
  for (const statement of fake.matching(JOB_UPDATE)) {
    assert.match(statement.text, /WHERE memory_id = \$1::uuid AND status = 'processing' AND lease_token = \$2::uuid$/);
    assert.deepEqual(statement.scope, { namespaces: ['shared'], keyId: OWNER_KEY_ID, admin: false });
  }
  const outcomes = logs.filter(line => line.startsWith('[ingestion-worker] outcome=')).map(line => line.slice('[ingestion-worker] outcome='.length));
  assert.deepEqual(outcomes.filter(code => code !== 'stale'), [
    'retry_rate_limited', 'retry_transient', 'retry_transient', 'retry_transient', 'retry_transient', 'retry_provider_auth', 'failed_input_rejected',
  ]);
  for (const line of logs) assert.doesNotMatch(line, /DO-NOT-LOG|provider body|ECONNREFUSED|0000-4000-8000/);

  // Nothing is claimable again until its backoff elapses: no hot loop.
  const again = await run(fake, { concurrency: 4 }, { embed });
  assert.equal(again.processed, 0);
  assert.equal(fake.matching(WORKER_CLAIM).length, 8 + 1, 'one empty claim per --once poll after the matrix');
});

test('successful embeddings finalize under the owner scope: ready with identity, deduplicated, or space mismatch', async t => {
  const logs = captureLogs(t);
  const fake = pool();
  const plain = fake.seed('plain', { namespace: 'private', agent_id: '44444444-4444-4444-8444-444444444444' });
  const duplicate = fake.seed('duplicate', { dedupe: true });
  const rotated = fake.seed('rotated', { embedding_model: 'retired-model' });
  fake.similarity = 0.97;
  const result = await run(fake, { concurrency: 1 }, { embed: scripted(fake, { plain: EMBEDDING, duplicate: EMBEDDING, rotated: EMBEDDING }) });
  assert.deepEqual(result, { processed: 3, ready: 1, deduplicated: 1, retry: 0, failed: 1, cancelled: 0, stale: 0, error: 0 });

  const landed = fake.job(plain);
  assert.equal(landed.status, 'ready');
  assert.ok(landed.ready_at && landed.finalized_at);
  assert.equal(landed.lease_token, null);
  assert.deepEqual(fake.memory(plain).identity, ['gemini', 'gemini-embedding-2-preview', 768]);
  assert.equal(fake.memory(plain).embedded, true);
  const [landing] = fake.matching(PLAIN_LANDING);
  assert.equal(landing.params[0], `[${VECTOR.join(',')}]`);
  assert.deepEqual(landing.params.slice(4), [plain, 'private']);
  assert.deepEqual(landing.scope, { namespaces: ['private'], keyId: OWNER_KEY_ID, admin: false });

  const collapsed = fake.job(duplicate);
  assert.equal(collapsed.status, 'deduplicated');
  assert.equal(collapsed.canonical_memory_id, CANONICAL_ID);
  assert.equal(collapsed.similarity, 0.97);
  assert.equal(fake.memory(duplicate).deleted, true, 'the pending row is soft-deleted into the canonical');
  assert.equal(fake.memory(duplicate).embedded, false);
  assert.equal(fake.matching(ADVISORY).length, 1, 'the dedupe namespace lock is taken only for dedupe jobs');
  assert.equal(fake.matching(CANDIDATE).length, 1);
  assert.ok(fake.matching(CANDIDATE)[0].params.includes(duplicate), 'the candidate query excludes the pending row itself');

  const mismatched = fake.job(rotated);
  assert.equal(mismatched.status, 'embedding_failed');
  assert.equal(mismatched.failure_category, 'space_mismatch');
  assert.equal(mismatched.last_error_code, 'space_mismatch');
  assert.equal(fake.memory(rotated).embedded, false, 'a vector never lands in a different space');
  assert.equal(fake.memory(rotated).deleted, false);

  assert.deepEqual(fake.audits.map(audit => audit.action), ['memory.ingest.ready', 'memory.ingest.deduplicated']);
  assert.deepEqual(fake.audits.map(audit => JSON.parse(audit.details)), [
    { created: true, deduplicated: false, attempts: 1 }, { created: false, deduplicated: true, attempts: 1 },
  ]);
  assert.deepEqual(fake.audits.map(audit => audit.scope.keyId), [OWNER_KEY_ID, OWNER_KEY_ID]);

  // Claims, heartbeats and pause checks run under the admin worker scope;
  // every memory and job write runs under exactly the job's owner scope.
  for (const statement of fake.matching(WORKER_CLAIM).concat(fake.matching(HEARTBEAT), fake.matching(PAUSED))) {
    assert.deepEqual(statement.scope, { namespaces: ['shared', 'private'], keyId: WORKER_KEY_ID, admin: true });
  }
  const owned = fake.statements.filter(statement => OWNER_WRITES.some(pattern => pattern.test(statement.text)));
  assert.ok(owned.length >= 12);
  for (const statement of owned) {
    assert.equal(statement.scope.admin, false, statement.text);
    assert.equal(statement.scope.keyId, OWNER_KEY_ID);
    assert.equal(statement.scope.namespaces.length, 1);
    assert.ok(['shared', 'private'].includes(statement.scope.namespaces[0]));
  }
  assert.ok(fake.matching(WORKER_CLAIM).every(statement => !/\bcontent\b/.test(statement.text)));
  const outcomes = logs.filter(line => line.startsWith('[ingestion-worker]'));
  assert.deepEqual(outcomes, [
    '[ingestion-worker] outcome=ready', '[ingestion-worker] outcome=deduplicated', '[ingestion-worker] outcome=failed_space_mismatch',
  ]);
  for (const line of logs) assert.doesNotMatch(line, /DO-NOT-LOG|0000-4000-8000/);
  for (const statement of fake.statements) {
    assert.ok(!statement.params.some(param => typeof param === 'string' && param.includes('DO-NOT-LOG')), statement.text);
  }
});

test('the default embed calls the active profile outside any transaction, bounded by EMBEDDING_TIMEOUT_MS', async t => {
  captureLogs(t);
  const fake = pool();
  const limited = fake.seed('limited');
  const landed = fake.seed('landed');
  const hung = fake.seed('hung');
  const previousTimeout = process.env.EMBEDDING_TIMEOUT_MS;
  process.env.EMBEDDING_TIMEOUT_MS = '100';
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(fake.openTransactions, 0, 'the provider call must run outside any transaction');
    assert.equal(fake.checkedOut, 0, 'the provider call must not hold a pool connection');
    requests.push(String(input));
    const body = JSON.parse(String(init?.body)) as { content: { parts: Array<{ text: string }> } };
    const label = body.content.parts[0].text.replace('DO-NOT-LOG-', '');
    if (label === 'limited') return new Response('{"error":"slow down"}', { status: 429, headers: { 'Retry-After': '300' } });
    if (label === 'landed') return new Response(JSON.stringify({ embedding: { values: VECTOR } }), { status: 200 });
    return new Promise<Response>((_, reject) => {
      // A real socket keeps the event loop alive; the stub must too, because
      // the AbortSignal.timeout timer behind EMBEDDING_TIMEOUT_MS is unref'd.
      const keepAlive = setTimeout(() => reject(new Error('the hung provider call was never aborted')), 10_000);
      init!.signal!.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init!.signal!.reason); }, { once: true });
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousTimeout === undefined) delete process.env.EMBEDDING_TIMEOUT_MS;
    else process.env.EMBEDDING_TIMEOUT_MS = previousTimeout;
  });

  const before = Date.now();
  const result = await run(fake, { concurrency: 1 }, { embed: undefined });
  assert.deepEqual(result, { processed: 3, ready: 1, deduplicated: 0, retry: 2, failed: 0, cancelled: 0, stale: 0, error: 0 });
  assert.equal(requests.length, 3);
  assert.ok(requests.every(url => url.includes('gemini-embedding-2-preview:embedContent')));

  assert.equal(fake.job(limited).status, 'retry_wait');
  assert.equal(fake.job(limited).failure_category, 'rate_limited');
  assert.equal(fake.job(limited).last_error_code, 'http_429');
  const delay = seconds(before, fake.job(limited).next_attempt_at);
  assert.ok(delay >= 300 && delay <= 361, `Retry-After honored: ${delay}`);

  assert.equal(fake.job(landed).status, 'ready');
  assert.deepEqual(fake.memory(landed).identity, ['gemini', 'gemini-embedding-2-preview', 768]);

  assert.equal(fake.job(hung).status, 'retry_wait');
  assert.equal(fake.job(hung).last_error_code, 'provider_timeout');
  assert.equal(fake.job(hung).failure_category, 'transient');
  assert.ok(Date.now() - before < 5_000, 'the hung provider call was cut off by EMBEDDING_TIMEOUT_MS');
});

test('expired leases are reclaimed with a counted attempt while live leases and future retries are left alone', async t => {
  captureLogs(t);
  const fake = pool();
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60 * 60_000);
  const crashed = fake.seed('crashed', { status: 'processing', attempts: 2, lease_token: OLD_LEASE, lease_expires_at: past, next_attempt_at: past, locked_at: past });
  const held = fake.seed('held', { status: 'processing', attempts: 1, lease_token: FOREIGN_LEASE, lease_expires_at: future, next_attempt_at: past });
  const waiting = fake.seed('waiting', { status: 'retry_wait', attempts: 1, next_attempt_at: future, last_error_code: 'http_503', failure_category: 'transient' });
  const fresh = fake.seed('fresh');
  const done = fake.seed('done', { status: 'ready', attempts: 1 });
  const result = await run(fake, { concurrency: 1 }, { embed: scripted(fake, { crashed: EMBEDDING, fresh: EMBEDDING }) });
  assert.deepEqual(result, { processed: 2, ready: 2, deduplicated: 0, retry: 0, failed: 0, cancelled: 0, stale: 0, error: 0 });

  assert.equal(fake.job(crashed).status, 'ready');
  assert.equal(fake.job(crashed).attempts, 3, 'the reclaim counted an attempt');
  assert.equal(fake.job(fresh).status, 'ready');
  assert.equal(fake.job(fresh).attempts, 1);
  assert.deepEqual(fake.job(held), { ...fake.job(held), status: 'processing', attempts: 1, lease_token: FOREIGN_LEASE, lease_expires_at: future });
  assert.deepEqual(fake.job(waiting), { ...fake.job(waiting), status: 'retry_wait', attempts: 1, next_attempt_at: future });
  assert.equal(fake.job(done).status, 'ready');
  assert.equal(fake.memory(held).embedded, false);
  assert.equal(fake.memory(waiting).embedded, false);
  for (const statement of fake.matching(WORKER_CLAIM)) {
    assert.match(statement.text, /j\.status = 'processing' AND j\.lease_expires_at IS NOT NULL AND j\.lease_expires_at < statement_timestamp\(\)/);
    assert.deepEqual(statement.params, [INGESTION_LEASE_MS]);
  }
  assert.equal(fake.matching(WORKER_CLAIM).length, 3, 'two claims plus the empty one that ends --once');
  const custom = await run(fake, {}, { leaseMs: 30_000 });
  assert.equal(custom.processed, 0);
  assert.deepEqual(fake.matching(WORKER_CLAIM).at(-1)!.params, [30_000]);
});

test('a lease reclaimed elsewhere makes finalize and failure recording no-ops that leave the job untouched', async t => {
  const logs = captureLogs(t);
  const fake = pool();
  const landing = fake.seed('landing');
  const failing = fake.seed('failing');
  const result = await run(fake, { concurrency: 1 }, {
    embed: scripted(fake, {
      landing: async () => { fake.job(landing).lease_token = FOREIGN_LEASE; return EMBEDDING; },
      failing: async () => { fake.job(failing).lease_token = FOREIGN_LEASE; throw provider(500); },
    }),
  });
  assert.deepEqual(result, { processed: 2, ready: 0, deduplicated: 0, retry: 0, failed: 0, cancelled: 0, stale: 2, error: 0 });
  for (const id of [landing, failing]) {
    const job = fake.job(id);
    assert.equal(job.status, 'processing', 'the other lease holder owns the job');
    assert.equal(job.lease_token, FOREIGN_LEASE);
    assert.equal(job.attempts, 1);
    assert.equal(job.last_error_code, null);
    assert.equal(job.failure_category, null);
    assert.equal(fake.memory(id).embedded, false);
  }
  assert.equal(fake.matching(PLAIN_LANDING).length, 0);
  assert.equal(fake.audits.length, 0);
  const [staleFail] = fake.matching(JOB_UPDATE);
  assert.ok(staleFail, 'the failure write was attempted with the lease this worker was issued');
  assert.equal(staleFail.params[0], failing);
  assert.match(String(staleFail.params[1]), /^aaaaaaaa-aaaa-4aaa-8aaa-/);
  assert.notEqual(staleFail.params[1], FOREIGN_LEASE);
  assert.match(staleFail.text, /status = 'processing' AND lease_token = \$2::uuid$/);
  assert.deepEqual(logs.filter(line => line.startsWith('[ingestion-worker]')), ['[ingestion-worker] outcome=stale', '[ingestion-worker] outcome=stale']);
});

test('exhausting MEMORY_INGESTION_MAX_ATTEMPTS dead-letters the job with its content intact and visible', async t => {
  captureLogs(t);
  const fake = pool();
  const last = fake.seed('last', { attempts: 11, status: 'retry_wait' });
  const penultimate = fake.seed('penultimate', { attempts: 10, status: 'retry_wait' });
  const result = await run(fake, { concurrency: 1 }, { embed: scripted(fake, { last: provider(503), penultimate: provider(503) }) });
  assert.deepEqual(result, { processed: 2, ready: 0, deduplicated: 0, retry: 1, failed: 1, cancelled: 0, stale: 0, error: 0 });

  const dead = fake.job(last);
  assert.equal(dead.attempts, 12);
  assert.equal(dead.status, 'embedding_failed');
  assert.equal(dead.failure_category, 'transient');
  assert.equal(dead.last_error_code, 'http_503');
  assert.ok(dead.finalized_at);
  assert.equal(dead.lease_token, null);
  assert.equal(fake.memory(last).content, 'DO-NOT-LOG-last');
  assert.equal(fake.memory(last).deleted, false);
  assert.equal(fake.memory(last).embedded, false);

  const alive = fake.job(penultimate);
  assert.equal(alive.attempts, 11);
  assert.equal(alive.status, 'retry_wait');
  assert.ok(alive.next_attempt_at.getTime() >= Date.now() + 43_000_000, 'attempt 11 waits at the 12h cap');
  assert.equal(fake.matching(/^UPDATE memories|DELETE/).length, 0);

  // The cap is read from the environment, fail-closed, and overridable for tests.
  const low = fake.seed('low', { attempts: 1, status: 'retry_wait' });
  const bounded = await run(fake, {}, {
    env: { INGESTION_WORKER_API_KEY: 'tr_worker', MEMORY_INGESTION_MAX_ATTEMPTS: '2' },
    embed: scripted(fake, { low: provider(503) }),
  });
  assert.equal(bounded.failed, 1);
  assert.equal(fake.job(low).status, 'embedding_failed');
  assert.equal(fake.job(low).attempts, 2);
  await assert.rejects(run(fake, {}, { env: { INGESTION_WORKER_API_KEY: 'tr_worker', MEMORY_INGESTION_MAX_ATTEMPTS: '0' } }), /MEMORY_INGESTION_MAX_ATTEMPTS/);
});

test('expired TTL, forgotten and unreachable memories are cancelled without a provider call', async t => {
  const logs = captureLogs(t);
  const fake = pool();
  const expired = fake.seed('expired', { expires_at: new Date(Date.now() - 1_000) });
  const forgotten = fake.seed('forgotten', { deleted: true });
  const vanished = fake.seed('vanished', { withMemory: false });
  const alive = fake.seed('alive', { expires_at: new Date(Date.now() + 60_000) });
  let calls = 0;
  const result = await run(fake, { concurrency: 1 }, {
    embed: async (content, signal) => { calls += 1; return scripted(fake, { alive: EMBEDDING })(content, signal); },
  });
  assert.deepEqual(result, { processed: 4, ready: 1, deduplicated: 0, retry: 0, failed: 0, cancelled: 3, stale: 0, error: 0 });
  assert.equal(calls, 1, 'only the live memory reached the provider');

  assert.equal(fake.job(expired).status, 'cancelled');
  assert.equal(fake.job(expired).failure_category, 'expired');
  assert.equal(fake.job(expired).last_error_code, 'memory_expired');
  assert.equal(fake.job(forgotten).status, 'cancelled');
  assert.equal(fake.job(forgotten).failure_category, null);
  assert.equal(fake.job(forgotten).last_error_code, 'memory_deleted');
  assert.equal(fake.job(vanished).status, 'cancelled');
  assert.equal(fake.job(vanished).last_error_code, 'memory_missing');
  assert.equal(fake.job(alive).status, 'ready');
  for (const id of [expired, forgotten, vanished]) {
    assert.ok(fake.job(id).finalized_at);
    assert.equal(fake.job(id).lease_token, null);
  }
  assert.equal(fake.memory(expired).embedded, false);
  assert.equal(fake.memory(expired).content, 'DO-NOT-LOG-expired', 'expired content is kept until lifecycle removes it');
  assert.deepEqual(logs.filter(line => line.includes('[ingestion-worker]')), [
    '[ingestion-worker] outcome=cancelled_expired', '[ingestion-worker] outcome=cancelled_deleted',
    '[ingestion-worker] outcome=cancelled_missing', '[ingestion-worker] outcome=ready',
  ]);
});

test('the pause switch is honored on every poll and each poll writes the worker heartbeat', async t => {
  const logs = captureLogs(t);
  const fake = pool();
  const queued = fake.seed('queued');
  fake.paused = true;
  const stop = new AbortController();
  const sleeps: number[] = [];
  const result = await run(fake, { once: false, pollMs: 250 }, {
    signal: stop.signal,
    embed: scripted(fake, { queued: EMBEDDING }),
    sleep: async (milliseconds, signal) => {
      sleeps.push(milliseconds);
      assert.equal(signal, stop.signal, 'sleep is interruptible by the drain signal');
      if (sleeps.length === 1) {
        assert.equal(fake.matching(WORKER_CLAIM).length, 0, 'nothing is claimed while paused');
        assert.ok(fake.heartbeats.length >= 1, 'the heartbeat is written even while paused');
        fake.paused = false;
      } else {
        stop.abort();
      }
    },
  });
  assert.deepEqual(result, { processed: 1, ready: 1, deduplicated: 0, retry: 0, failed: 0, cancelled: 0, stale: 0, error: 0 });
  assert.deepEqual(sleeps, [250, 250]);
  assert.equal(fake.job(queued).status, 'ready');
  assert.ok(fake.seenAt);
  assert.equal(fake.heartbeats.length, fake.matching(PAUSED).length, 'one heartbeat per pause check');
  assert.ok(fake.heartbeats.length >= 3);
  for (const scope of fake.heartbeats) assert.deepEqual(scope, { namespaces: ['shared', 'private'], keyId: WORKER_KEY_ID, admin: true });
  assert.ok(logs.includes('[ingestion-worker] outcome=paused'));
  // The heartbeat and pause check share one transaction, before any claim.
  const first = fake.statements.findIndex(statement => HEARTBEAT.test(statement.text));
  const firstPause = fake.statements.findIndex(statement => PAUSED.test(statement.text));
  const firstClaim = fake.statements.findIndex(statement => WORKER_CLAIM.test(statement.text));
  assert.ok(first >= 0 && first < firstPause && firstPause < firstClaim);

  // A --once drain while paused exits without claiming.
  fake.paused = true;
  const idle = fake.seed('idle');
  const paused = await run(fake, {}, { embed: scripted(fake, { idle: EMBEDDING }) });
  assert.equal(paused.processed, 0);
  assert.equal(fake.job(idle).status, 'pending');
  assert.equal(fake.matching(WORKER_CLAIM).length, 2, 'no new claim statement ran while paused');
});

test('--once exits on an empty queue, --max-jobs bounds claims, and a drain finishes in-flight work', async t => {
  captureLogs(t);
  const fake = pool();
  const empty = await run(fake, { concurrency: 4 });
  assert.deepEqual(empty, { processed: 0, ready: 0, deduplicated: 0, retry: 0, failed: 0, cancelled: 0, stale: 0, error: 0 });
  assert.equal(fake.matching(WORKER_CLAIM).length, 1);
  assert.equal(fake.heartbeats.length, 1);

  const first = fake.seed('first');
  const second = fake.seed('second');
  const third = fake.seed('third');
  const embed = scripted(fake, { first: EMBEDDING, second: EMBEDDING, third: EMBEDDING }, false);
  const bounded = await run(fake, { maxJobs: 2, concurrency: 4 }, { embed });
  assert.equal(bounded.processed, 2);
  assert.equal(bounded.ready, 2);
  assert.equal(fake.job(first).status, 'ready');
  assert.equal(fake.job(second).status, 'ready');
  assert.deepEqual([fake.job(third).status, fake.job(third).attempts], ['pending', 0]);

  // Drain: the stop signal ends claiming, the in-flight embed still finalizes.
  const fourth = fake.seed('fourth');
  const stop = new AbortController();
  const started = deferred<void>();
  const release = deferred<EmbeddingResult>();
  const drained = run(fake, { once: false, concurrency: 1 }, {
    signal: stop.signal,
    embed: scripted(fake, { third: EMBEDDING, fourth: async () => { started.resolve(); return release.promise; } }),
    sleep: async () => { throw new Error('a busy worker never sleeps'); },
  });
  await started.promise;
  assert.equal(fake.job(fourth).status, 'processing');
  stop.abort();
  release.resolve(EMBEDDING);
  const result = await drained;
  assert.equal(result.processed, 2);
  assert.equal(result.ready, 2);
  assert.equal(fake.job(third).status, 'ready');
  assert.equal(fake.job(fourth).status, 'ready');
  assert.equal(fake.openTransactions, 0);
  assert.equal(fake.checkedOut, 0);
});

test('a second signal aborts in-flight provider calls and records them as retryable', async t => {
  captureLogs(t);
  const fake = pool();
  const slow = fake.seed('slow');
  const stop = new AbortController();
  const abort = new AbortController();
  const started = deferred<void>();
  const running = run(fake, { once: false, concurrency: 1 }, {
    signal: stop.signal,
    abortSignal: abort.signal,
    embed: scripted(fake, {
      slow: signal => new Promise<EmbeddingResult>((_, reject) => {
        started.resolve();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    }),
    sleep: async () => { throw new Error('a busy worker never sleeps'); },
  });
  await started.promise;
  stop.abort();
  abort.abort();
  const result = await running;
  assert.deepEqual(result, { processed: 1, ready: 0, deduplicated: 0, retry: 1, failed: 0, cancelled: 0, stale: 0, error: 0 });
  assert.equal(fake.job(slow).status, 'retry_wait');
  assert.equal(fake.job(slow).last_error_code, 'aborted');
  assert.equal(fake.job(slow).failure_category, 'transient');
  assert.equal(fake.job(slow).attempts, 1);
  assert.equal(fake.memory(slow).embedded, false);
});

test('concurrency bounds in-flight provider calls with a simple in-flight counter', async t => {
  captureLogs(t);
  const fake = pool();
  const ids = ['a', 'b', 'c', 'd', 'e'].map(label => fake.seed(label));
  let active = 0;
  let peak = 0;
  const embed = async (): Promise<EmbeddingResult> => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return EMBEDDING;
  };
  const result = await run(fake, { concurrency: 2 }, { embed });
  assert.equal(result.processed, 5);
  assert.equal(result.ready, 5);
  assert.equal(peak, 2, 'never more embeddings in flight than --concurrency');
  for (const id of ids) assert.equal(fake.job(id).status, 'ready');

  const more = ['f', 'g', 'h'].map(label => fake.seed(label));
  peak = 0;
  const single = await run(fake, { concurrency: 1 }, { embed });
  assert.equal(single.ready, 3);
  assert.equal(peak, 1);
  for (const id of more) assert.equal(fake.job(id).status, 'ready');
});

test('a finalize failure after a successful embed is recorded as finalize_error with backoff, and a claim failure still drains', async t => {
  const logs = captureLogs(t);
  const fake = pool();
  const raced = fake.seed('raced');
  fake.landingFails = true;
  const before = Date.now();
  const result = await run(fake, {}, { embed: scripted(fake, { raced: EMBEDDING }) });
  assert.deepEqual(result, { processed: 1, ready: 0, deduplicated: 0, retry: 1, failed: 0, cancelled: 0, stale: 0, error: 0 });
  const job = fake.job(raced);
  assert.equal(job.status, 'retry_wait');
  assert.equal(job.last_error_code, 'finalize_error');
  assert.equal(job.failure_category, 'transient');
  assert.equal(job.attempts, 1);
  const delay = seconds(before, job.next_attempt_at);
  assert.ok(delay >= 60 && delay <= 73, `finalize failures use the bounded backoff: ${delay}`);
  assert.equal(fake.memory(raced).embedded, false);
  assert.ok(logs.includes('[ingestion-worker] outcome=finalize_error'));
  assert.ok(logs.includes('[ingestion-worker] outcome=retry_transient'));
  assert.ok(fake.matching(/^ROLLBACK$/).length >= 1, 'the failed finalize transaction rolled back');
  fake.landingFails = false;

  // An injected claim: the first call claims for real, the second fails like a
  // lost database. The run rejects only after the claimed job was finalized.
  const survivor = fake.seed('survivor');
  let calls = 0;
  await assert.rejects(run(fake, { concurrency: 2 }, {
    embed: scripted(fake, { survivor: EMBEDDING, raced: EMBEDDING }),
    claim: async client => {
      calls += 1;
      if (calls === 1) return claimIngestionJob(client);
      throw new Error('database unavailable');
    },
  }), /database unavailable/);
  assert.equal(fake.job(survivor).status, 'ready');
  assert.equal(fake.openTransactions, 0);
  assert.equal(fake.checkedOut, 0);

  // The override the worker relies on only accepts content-free codes.
  const claimed = fake.job(survivor);
  const stale: IngestionJob = {
    memoryId: claimed.memory_id, namespace: claimed.namespace, kind: 'store', sourceRevision: 0, documentId: null, chunkIndex: null,
    clientId: claimed.client_id, accessLevel: 'normal', allowedNamespaces: claimed.allowed_namespaces, agentId: null, sessionId: null,
    sourceKey: null, dedupe: false, ttlSeconds: null, contradictionEligible: false, embeddingProvider: 'gemini',
    embeddingModel: 'gemini-embedding-2-preview', embeddingDimensions: 768, status: 'processing', attempts: 1,
    nextAttemptAt: claimed.next_attempt_at, leaseToken: OLD_LEASE, leaseExpiresAt: null, acceptedAt: claimed.accepted_at,
  };
  await assert.rejects(
    withScopedClient(ingestionJobScope(stale), client => failIngestionJob(client, stale, new Error('x'), { errorCode: 'Not A Code' })),
    /Invalid content-free ingestion error code/,
  );
});
