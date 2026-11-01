import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type express from 'express';
import type pg from 'pg';
import request from 'supertest';
import { setPoolForTesting } from '../src/db.js';
import {
  INGESTION_FAILURE_CATEGORIES,
  INGESTION_JOB_STATUSES,
  resetInlineIngestionCountersForTesting,
  type IngestionFailureCategory,
  type IngestionJobStatus,
} from '../src/ingestion.js';
import type { AuthContext } from '../src/types.js';

const ADMIN_KEY_ID = '99999999-9999-4999-8999-999999999999';
const OWNER_KEY_ID = '11111111-1111-4111-8111-111111111111';
const READY_ID = '00000000-0000-4000-8000-000000000001';
const FAILED_ID = '00000000-0000-4000-8000-000000000002';
const CANCELLED_ID = '00000000-0000-4000-8000-000000000003';
const PENDING_OLD_ID = '00000000-0000-4000-8000-000000000004';
const PENDING_NEW_ID = '00000000-0000-4000-8000-000000000005';
const RETRY_ID = '00000000-0000-4000-8000-000000000006';
const PROCESSING_ID = '00000000-0000-4000-8000-000000000007';
const DEDUPED_ID = '00000000-0000-4000-8000-000000000008';
const FOREIGN_ID = '00000000-0000-4000-8000-000000000009';
const MISSING_ID = '00000000-0000-4000-8000-0000000000ff';
const NOW = new Date('2026-11-01T12:00:00.000Z');
const SEEN_AT = new Date('2026-11-01T11:59:58.000Z');
const NEXT_RETRY_AT = new Date('2026-11-01T12:05:00.000Z');

const BASE: AuthContext = {
  keyId: ADMIN_KEY_ID, name: 'ingestion-admin', namespaces: ['shared', 'private'],
  permissions: ['admin', 'read', 'write'], maxAccessLevel: 'normal',
};
const KEYS: Record<string, AuthContext> = {
  tr_admin: BASE,
  tr_reader: { ...BASE, permissions: ['admin', 'read'] },
  tr_writer: { ...BASE, permissions: ['admin', 'write'] },
  tr_plain: { ...BASE, keyId: OWNER_KEY_ID, name: 'owner', permissions: ['read', 'write', 'delete'] },
};
const bearer = (key: keyof typeof KEYS) => `Bearer ${key}`;

type Scope = { namespaces: string[]; keyId: string; admin: boolean };
type Statement = { text: string; params: unknown[]; scope: Scope };
type JobRow = {
  memory_id: string; namespace: string; client_id: string; status: IngestionJobStatus; attempts: number;
  accepted_at: Date; next_attempt_at: Date | null; failure_category: IngestionFailureCategory | null;
  requeued_by: string | null; requeued_at: Date | null;
};
type AuditRow = {
  clientId: unknown; action: unknown; namespace: unknown; memoryId: unknown; resourceType: unknown; resourceId: unknown;
  details: unknown; scope: Scope;
};

const REQUEUE_LOCK = /^SELECT j\.memory_id, j\.namespace, j\.status, j\.attempts FROM memory_ingestion_jobs j WHERE j\.memory_id = \$1::uuid FOR UPDATE$/;
const REQUEUE_RESET = /^UPDATE memory_ingestion_jobs SET status = 'pending', attempts = 0, next_attempt_at = statement_timestamp\(\), locked_at = NULL, lease_expires_at = NULL, lease_token = NULL, last_error_code = NULL, failure_category = NULL, finalized_at = NULL, requeued_by = \$2, requeued_at = statement_timestamp\(\) WHERE memory_id = \$1::uuid AND status IN \('embedding_failed', 'cancelled'\) RETURNING requeued_at$/;
const DEPTH = /^SELECT status, count\(\*\)::int AS count FROM memory_ingestion_jobs GROUP BY status$/;
const AGES = /^SELECT EXTRACT\(EPOCH FROM \(statement_timestamp\(\) - min\(accepted_at\)\)\)::double precision AS oldest_pending_age_seconds, min\(next_attempt_at\) FILTER \(WHERE status = 'retry_wait'\) AS next_retry_at FROM memory_ingestion_jobs WHERE status IN \('pending', 'processing', 'retry_wait'\)$/;
const ATTEMPTS = /^SELECT attempts, count\(\*\)::int AS count FROM memory_ingestion_jobs WHERE status IN \('pending', 'processing', 'retry_wait', 'embedding_failed'\) GROUP BY attempts ORDER BY attempts$/;
const FAILURES = /^SELECT failure_category, count\(\*\)::int AS count FROM memory_ingestion_jobs WHERE failure_category IS NOT NULL AND status IN \('retry_wait', 'embedding_failed', 'cancelled'\) GROUP BY failure_category$/;
const SETTINGS = /^SELECT ingestion_paused, ingestion_worker_seen_at FROM instance_settings WHERE singleton = true$/;
const PAUSE = /^UPDATE instance_settings SET ingestion_paused = \$1 WHERE singleton = true RETURNING ingestion_paused$/;
const AUDIT = /^INSERT INTO audit_log/;
const ACTIVE: IngestionJobStatus[] = ['pending', 'processing', 'retry_wait'];

function rows(list: unknown[]) {
  return { command: 'MOCK', rowCount: list.length, oid: 0, fields: [], rows: list };
}

/**
 * A stateful stand-in for memory_ingestion_jobs and instance_settings that
 * models the owner-or-admin plus namespace RLS rule, the requeue state
 * machine, the pause flag, and the content-free aggregates. It records the
 * transaction scope behind every statement and which connection issued it.
 */
class AdminPool {
  jobs = new Map<string, JobRow>();
  paused = false;
  seenAt: Date | null = null;
  statements: Statement[] = [];
  clients: Statement[][] = [];
  audits: AuditRow[] = [];
  transactions: Scope[] = [];
  readOnlyTransactions = 0;
  checkedOut = 0;

  async connect() {
    this.checkedOut += 1;
    const own: Statement[] = [];
    this.clients.push(own);
    const scope: Scope = { namespaces: [], keyId: '', admin: false };
    return {
      query: async (text: string, params: unknown[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        const statement = { text: sql, params, scope: { ...scope, namespaces: [...scope.namespaces] } };
        this.statements.push(statement);
        own.push(statement);
        if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return rows([]);
        if (sql === 'SET TRANSACTION READ ONLY') { this.readOnlyTransactions += 1; return rows([]); }
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

  async query(): Promise<never> { throw new Error('ingestion administration must use scoped transactions'); }

  seed(id: string, overrides: Partial<JobRow> = {}): JobRow {
    const job: JobRow = {
      memory_id: id, namespace: 'shared', client_id: OWNER_KEY_ID, status: 'pending', attempts: 0,
      accepted_at: NOW, next_attempt_at: null, failure_category: null, requeued_by: null, requeued_at: null, ...overrides,
    };
    this.jobs.set(id, job);
    return job;
  }

  matching(pattern: RegExp): Statement[] { return this.statements.filter(statement => pattern.test(statement.text)); }

  private dispatch(sql: string, params: unknown[], scope: Scope) {
    const visible = (job: JobRow) => (scope.admin || job.client_id === scope.keyId) && scope.namespaces.includes(job.namespace);
    const visibleJobs = [...this.jobs.values()].filter(visible);
    const grouped = <K extends string | number>(list: JobRow[], key: (job: JobRow) => K) => {
      const counts = new Map<K, number>();
      for (const job of list) counts.set(key(job), (counts.get(key(job)) ?? 0) + 1);
      return [...counts.entries()];
    };
    if (REQUEUE_LOCK.test(sql)) {
      const job = this.jobs.get(String(params[0]));
      if (!job || !visible(job)) return rows([]);
      return rows([{ memory_id: job.memory_id, namespace: job.namespace, status: job.status, attempts: String(job.attempts) }]);
    }
    if (REQUEUE_RESET.test(sql)) {
      const job = this.jobs.get(String(params[0]));
      if (!job || !visible(job) || (job.status !== 'embedding_failed' && job.status !== 'cancelled')) return rows([]);
      job.status = 'pending'; job.attempts = 0; job.failure_category = null; job.next_attempt_at = NOW;
      job.requeued_by = String(params[1]); job.requeued_at = NOW;
      return rows([{ requeued_at: NOW }]);
    }
    if (DEPTH.test(sql)) return rows(grouped(visibleJobs, job => job.status).map(([status, count]) => ({ status, count })));
    if (AGES.test(sql)) {
      const active = visibleJobs.filter(job => ACTIVE.includes(job.status));
      const oldest = active.length ? Math.min(...active.map(job => job.accepted_at.getTime())) : null;
      const retries = active.filter(job => job.status === 'retry_wait' && job.next_attempt_at).map(job => job.next_attempt_at!.getTime());
      return rows([{
        oldest_pending_age_seconds: oldest === null ? null : String((NOW.getTime() - oldest) / 1000),
        next_retry_at: retries.length ? new Date(Math.min(...retries)) : null,
      }]);
    }
    if (ATTEMPTS.test(sql)) {
      const counted = visibleJobs.filter(job => ACTIVE.includes(job.status) || job.status === 'embedding_failed');
      return rows(grouped(counted, job => job.attempts).sort((a, b) => a[0] - b[0]).map(([attempts, count]) => ({ attempts: String(attempts), count })));
    }
    if (FAILURES.test(sql)) {
      const counted = visibleJobs.filter(job => job.failure_category !== null &&
        (job.status === 'retry_wait' || job.status === 'embedding_failed' || job.status === 'cancelled'));
      return rows(grouped(counted, job => job.failure_category!).map(([failure_category, count]) => ({ failure_category, count })));
    }
    if (SETTINGS.test(sql)) return rows([{ ingestion_paused: this.paused, ingestion_worker_seen_at: this.seenAt }]);
    if (PAUSE.test(sql)) { this.paused = params[0] === true; return rows([{ ingestion_paused: this.paused }]); }
    if (AUDIT.test(sql)) {
      this.audits.push({
        clientId: params[0], action: params[1], namespace: params[2], memoryId: params[3],
        resourceType: params[8], resourceId: params[9], details: params[10], scope: { ...scope, namespaces: [...scope.namespaces] },
      });
      return rows([]);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

function seedQueue(pool: AdminPool): void {
  const hours = (count: number) => new Date(NOW.getTime() - count * 3_600_000);
  pool.seed(PENDING_OLD_ID, { accepted_at: hours(2) });
  pool.seed(PENDING_NEW_ID, { accepted_at: hours(0.5) });
  pool.seed(RETRY_ID, { status: 'retry_wait', attempts: 2, accepted_at: hours(1), failure_category: 'transient', next_attempt_at: NEXT_RETRY_AT });
  pool.seed(PROCESSING_ID, { status: 'processing', attempts: 1, accepted_at: hours(0.25) });
  pool.seed(READY_ID, { status: 'ready', attempts: 1, accepted_at: hours(3) });
  pool.seed(DEDUPED_ID, { status: 'deduplicated', attempts: 1, accepted_at: hours(3) });
  pool.seed(FAILED_ID, { status: 'embedding_failed', attempts: 12, accepted_at: hours(20), failure_category: 'input_rejected' });
  pool.seed(CANCELLED_ID, { status: 'cancelled', attempts: 0, accepted_at: hours(6), failure_category: 'expired' });
  // Outside the admin key's namespaces: RLS hides it from every aggregate and from requeue.
  pool.seed(FOREIGN_ID, { namespace: 'elsewhere', accepted_at: hours(10) });
}

async function harness(t: TestContext): Promise<{ pool: AdminPool; app: express.Express }> {
  const pool = new AdminPool();
  setPoolForTesting(pool as unknown as pg.Pool);
  resetInlineIngestionCountersForTesting();
  const previousGate = process.env.MEMORY_INGESTION_QUEUE_ENABLED;
  delete process.env.MEMORY_INGESTION_QUEUE_ENABLED;
  const { createApp, setServerTestOverrides } = await import('../src/server.js');
  setServerTestOverrides({ validateKey: async (key) => KEYS[key] ?? null });
  t.after(() => {
    setServerTestOverrides({});
    setPoolForTesting(null);
    if (previousGate === undefined) delete process.env.MEMORY_INGESTION_QUEUE_ENABLED;
    else process.env.MEMORY_INGESTION_QUEUE_ENABLED = previousGate;
  });
  return { pool, app: createApp() };
}

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) { into.add(key); keysOf(nested, into); }
  }
  return into;
}

const ROUTES: Array<['get' | 'post', string]> = [
  ['get', '/api/ingestion/stats'],
  ['post', `/api/ingestion/jobs/${READY_ID}/requeue`],
  ['post', '/api/ingestion/pause'],
  ['post', '/api/ingestion/resume'],
];

test('ingestion admin routes require bearer auth, then admin, then read or write, before any SQL runs', async t => {
  const { pool, app } = await harness(t);
  seedQueue(pool);

  for (const [method, path] of ROUTES) {
    const anonymous = await request(app)[method](path).send({});
    assert.equal(anonymous.status, 401, `${method} ${path} without a key`);
    const invalid = await request(app)[method](path).set('Authorization', 'Bearer tr_unknown').send({});
    assert.equal(invalid.status, 403, `${method} ${path} with an unknown key`);
    assert.match(invalid.body.error, /invalid API key/);
    const plain = await request(app)[method](path).set('Authorization', bearer('tr_plain')).send({});
    assert.equal(plain.status, 403, `${method} ${path} without admin`);
    assert.match(plain.body.error, /requires 'admin'/);
  }
  for (const [method, path] of ROUTES.slice(1)) {
    const reader = await request(app)[method](path).set('Authorization', bearer('tr_reader')).send({});
    assert.equal(reader.status, 403, `${method} ${path} with admin but no write`);
    assert.match(reader.body.error, /requires 'write'/);
  }
  const writer = await request(app).get('/api/ingestion/stats').set('Authorization', bearer('tr_writer'));
  assert.equal(writer.status, 403);
  assert.match(writer.body.error, /requires 'read'/);

  assert.equal(pool.statements.length, 0, 'every denial happens before a connection is checked out');
  assert.equal(pool.checkedOut, 0);
  assert.deepEqual(pool.jobs.get(READY_ID)?.status, 'ready');
  assert.equal(pool.paused, false);
});

test('GET /api/ingestion/stats aggregates only the jobs visible to the key, reports the gate, pause flag and heartbeat, and never carries content', async t => {
  const { pool, app } = await harness(t);
  seedQueue(pool);
  pool.paused = true;
  pool.seenAt = SEEN_AT;

  const response = await request(app).get('/api/ingestion/stats').set('Authorization', bearer('tr_admin'));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body, {
    enabled: false,
    depth: { pending: 2, processing: 1, retry_wait: 1, ready: 1, deduplicated: 1, embedding_failed: 1, cancelled: 1 },
    queued: 4,
    oldest_pending_age_seconds: 7200,
    next_retry_at: NEXT_RETRY_AT.toISOString(),
    attempts_histogram: [{ attempts: 0, count: 2 }, { attempts: 1, count: 1 }, { attempts: 2, count: 1 }, { attempts: 12, count: 1 }],
    failure_categories: { transient: 1, rate_limited: 0, provider_auth: 0, input_rejected: 1, space_mismatch: 0, expired: 1 },
    inline: { attempted: 0, ready: 0, deduplicated: 0, queued: 0 },
    worker: { paused: true, last_seen_at: SEEN_AT.toISOString() },
  });
  assert.deepEqual(Object.keys(response.body.depth), [...INGESTION_JOB_STATUSES]);
  assert.deepEqual(Object.keys(response.body.failure_categories), [...INGESTION_FAILURE_CATEGORIES]);

  // One read-only admin-scoped transaction bounded by the key's namespaces.
  assert.deepEqual(pool.transactions, [{ namespaces: ['shared', 'private'], keyId: ADMIN_KEY_ID, admin: true }]);
  assert.equal(pool.readOnlyTransactions, 1);
  assert.equal(pool.checkedOut, 0);
  assert.equal(pool.clients.at(-1)?.at(-1)?.text, 'COMMIT');
  assert.equal(pool.audits.length, 0, 'reading queue statistics is not audited');

  // Content-free by construction: no memory columns in the response, no memories table in the SQL.
  const forbidden = ['content', 'source', 'tags', 'metadata', 'source_key', 'lease_token', 'client_id', 'agent_id', 'session_id', 'memory_id'];
  for (const key of keysOf(response.body)) assert.equal(forbidden.includes(key), false, `response key ${key}`);
  for (const statement of pool.statements) {
    assert.doesNotMatch(statement.text, /\bcontent\b|\bmemories\b|\bsource_key\b/);
  }
  assert.equal(pool.matching(/FROM memory_ingestion_jobs/).length, 4);
  assert.equal(pool.matching(/FROM instance_settings/).length, 1);

  // The gate flag reflects the API process; the statistics stay available either way so a drain can be watched.
  process.env.MEMORY_INGESTION_QUEUE_ENABLED = 'true';
  const enabled = await request(app).get('/api/ingestion/stats').set('Authorization', bearer('tr_admin'));
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.enabled, true);
  assert.deepEqual(enabled.body.depth, response.body.depth);

  // An empty queue and a never-started worker answer with nulls rather than errors.
  pool.jobs.clear();
  pool.paused = false;
  pool.seenAt = null;
  const empty = await request(app).get('/api/ingestion/stats').set('Authorization', bearer('tr_admin'));
  assert.equal(empty.status, 200);
  assert.equal(empty.body.queued, 0);
  assert.equal(empty.body.oldest_pending_age_seconds, null);
  assert.equal(empty.body.next_retry_at, null);
  assert.deepEqual(empty.body.attempts_histogram, []);
  assert.deepEqual(empty.body.worker, { paused: false, last_seen_at: null });
});

test('POST requeue resets only failed or cancelled jobs, answers 409 for a ready job and 404 for an absent one, validates the id, and audits', async t => {
  const { pool, app } = await harness(t);
  seedQueue(pool);
  const requeue = (id: string) => request(app).post(`/api/ingestion/jobs/${id}/requeue`).set('Authorization', bearer('tr_admin'));

  const ready = await requeue(READY_ID);
  assert.equal(ready.status, 409, JSON.stringify(ready.body));
  assert.deepEqual(ready.body, { error: "Ingestion job in state 'ready' cannot be requeued", code: 'ingestion_job_state_conflict' });
  for (const [id, status] of [[PENDING_OLD_ID, 'pending'], [RETRY_ID, 'retry_wait'], [PROCESSING_ID, 'processing'], [DEDUPED_ID, 'deduplicated']]) {
    const conflict = await requeue(id);
    assert.equal(conflict.status, 409, status);
    assert.equal(conflict.body.code, 'ingestion_job_state_conflict');
    assert.match(conflict.body.error, new RegExp(`'${status}'`));
  }
  const missing = await requeue(MISSING_ID);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Ingestion job not found or access denied', code: 'ingestion_job_not_found' });
  const foreign = await requeue(FOREIGN_ID);
  assert.equal(foreign.status, 404, 'a job outside the key namespaces is invisible, not conflicting');
  const malformed = await requeue('not-a-uuid');
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, { error: 'Invalid id: expected UUID' });

  assert.equal(pool.matching(REQUEUE_RESET).length, 0, 'no reset ran for a refused requeue');
  assert.equal(pool.audits.length, 0);
  assert.equal(pool.matching(/^ROLLBACK$/).length, 7, 'each refused requeue rolled back its transaction');
  assert.equal(pool.jobs.get(READY_ID)?.status, 'ready');
  assert.equal(pool.jobs.get(FOREIGN_ID)?.status, 'pending');

  const failed = await requeue(FAILED_ID);
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  assert.deepEqual(failed.body, {
    memory_id: FAILED_ID, namespace: 'shared', previous_status: 'embedding_failed', previous_attempts: 12,
    requeued_at: NOW.toISOString(), status: 'pending',
  });
  const job = pool.jobs.get(FAILED_ID)!;
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 0);
  assert.equal(job.failure_category, null);
  assert.equal(job.requeued_by, ADMIN_KEY_ID);
  const [reset] = pool.matching(REQUEUE_RESET);
  assert.deepEqual(reset.params, [FAILED_ID, ADMIN_KEY_ID]);
  assert.deepEqual(reset.scope, { namespaces: ['shared', 'private'], keyId: ADMIN_KEY_ID, admin: true });
  assert.equal(pool.audits.length, 1);
  assert.deepEqual(pool.audits[0], {
    clientId: ADMIN_KEY_ID, action: 'ingestion.requeue', namespace: 'shared', memoryId: FAILED_ID,
    resourceType: 'memory', resourceId: FAILED_ID, details: JSON.stringify({ requeued: true, attempts: 12 }),
    scope: { namespaces: ['shared', 'private'], keyId: ADMIN_KEY_ID, admin: true },
  });
  const transaction = pool.clients.at(-1)!;
  assert.ok(transaction.some(statement => REQUEUE_RESET.test(statement.text)) && transaction.some(statement => AUDIT.test(statement.text)));
  assert.equal(transaction.at(-1)?.text, 'COMMIT', 'reset and audit commit together');

  const cancelled = await requeue(CANCELLED_ID);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.previous_status, 'cancelled');
  assert.equal(cancelled.body.previous_attempts, 0);
  assert.equal(pool.jobs.get(CANCELLED_ID)?.status, 'pending');

  const again = await requeue(FAILED_ID);
  assert.equal(again.status, 409, 'a requeued job is pending and cannot be requeued twice');
  assert.equal(pool.audits.length, 2);
  for (const statement of pool.statements) {
    assert.doesNotMatch(statement.text, /\bcontent\b|\bmemories\b|DELETE/);
  }
});

test('POST pause and resume flip the instance flag, answer with the new state, and audit as system operations in the same transaction', async t => {
  const { pool, app } = await harness(t);
  seedQueue(pool);

  const paused = await request(app).post('/api/ingestion/pause').set('Authorization', bearer('tr_admin'));
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.deepEqual(paused.body, { paused: true });
  assert.equal(pool.paused, true);

  const pausedAgain = await request(app).post('/api/ingestion/pause').set('Authorization', bearer('tr_admin')).send({});
  assert.deepEqual(pausedAgain.body, { paused: true }, 'pausing a paused queue is idempotent');

  const resumed = await request(app).post('/api/ingestion/resume').set('Authorization', bearer('tr_admin'));
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumed.body, { paused: false });
  assert.equal(pool.paused, false);

  assert.deepEqual(pool.audits.map(audit => [audit.action, audit.resourceType, audit.resourceId, audit.memoryId, audit.namespace, audit.details, audit.clientId]), [
    ['ingestion.pause', 'system', null, null, null, '{}', ADMIN_KEY_ID],
    ['ingestion.pause', 'system', null, null, null, '{}', ADMIN_KEY_ID],
    ['ingestion.resume', 'system', null, null, null, '{}', ADMIN_KEY_ID],
  ]);
  assert.deepEqual(pool.transactions, Array(3).fill({ namespaces: ['shared', 'private'], keyId: ADMIN_KEY_ID, admin: true }));
  for (const transaction of pool.clients) {
    const flip = transaction.findIndex(statement => PAUSE.test(statement.text));
    const audit = transaction.findIndex(statement => AUDIT.test(statement.text));
    assert.ok(flip >= 0 && audit > flip, 'the audit row follows the flip on the same connection');
    assert.equal(transaction.at(-1)?.text, 'COMMIT');
  }
  assert.deepEqual(pool.matching(PAUSE).map(statement => statement.params), [[true], [true], [false]]);
  for (const statement of pool.statements) {
    assert.doesNotMatch(statement.text, /memory_ingestion_jobs|\bmemories\b|\bcontent\b/);
  }
  assert.equal(pool.readOnlyTransactions, 0);
  assert.equal(pool.checkedOut, 0);

  // The stats surface reflects the flag the worker will read at its next poll.
  pool.paused = true;
  const stats = await request(app).get('/api/ingestion/stats').set('Authorization', bearer('tr_admin'));
  assert.equal(stats.body.worker.paused, true);
});
