import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import { setPoolForTesting } from '../src/db.js';
import { memoryStats } from '../src/tools/stats.js';
import type { AuthContext } from '../src/types.js';

type QueryCall = { text: string; params?: unknown[] };

const auth: AuthContext = {
  keyId: '22222222-2222-4222-8222-222222222222',
  name: 'stats-admin',
  namespaces: ['shared', 'projects'],
  permissions: ['admin', 'read'],
  maxAccessLevel: 'sensitive',
};

function rows<T extends pg.QueryResultRow>(value: T[]): pg.QueryResult<T> {
  return { command: 'MOCK', rowCount: value.length, oid: 0, fields: [], rows: value };
}

class StatsPool {
  readonly calls: QueryCall[] = [];
  connectCount = 0;
  releaseCount = 0;

  async connect() {
    this.connectCount += 1;
    return {
      query: async (text: string, params?: unknown[]) => {
        this.calls.push({ text, params });
        if (text.includes("attname = 'consolidated_into_id'")) {
          return rows([{ present: true }]);
        }
        if (text.includes('FROM memory_ingestion_jobs GROUP BY status')) {
          return rows([{ status: 'pending', count: 2 }, { status: 'embedding_failed', count: '1' }]);
        }
        if (text.includes('oldest_pending_age_seconds')) {
          return rows([{ oldest_pending_age_seconds: '90.25', next_retry_at: null }]);
        }
        if (text.includes('GROUP BY attempts')) {
          return rows([{ attempts: 0, count: 2 }, { attempts: '12', count: 1 }]);
        }
        if (text.includes('GROUP BY failure_category')) {
          return rows([{ failure_category: 'input_rejected', count: 1 }]);
        }
        if (text.includes('FROM instance_settings')) {
          return rows([{ ingestion_paused: false, ingestion_worker_seen_at: new Date('2026-09-12T01:02:03.000Z') }]);
        }
        if (text.includes('WITH grouped AS')) {
          return rows([{
            total: '7',
            by_namespace: [
              { namespace: 'shared', count: 5 },
              { namespace: 'projects', count: 2 },
            ],
            by_source: [
              { source: 'openclaw', count: 4 },
              { source: 'manual', count: 2 },
              { source: null, count: 1 },
            ],
            total_documents: '3',
            oldest_memory: new Date('2024-01-02T03:04:05.000Z'),
            newest_memory: new Date('2026-09-12T01:02:03.000Z'),
          }]);
        }
        return rows([]);
      },
      release: () => { this.releaseCount += 1; },
    };
  }
}

test.afterEach(() => setPoolForTesting(null));

test('memoryStats preserves its response while using one scoped checkout and aggregate query', async () => {
  const pool = new StatsPool();
  setPoolForTesting(pool as unknown as pg.Pool);

  const result = await memoryStats({}, auth);

  assert.deepEqual(result, {
    total_memories: 7,
    by_namespace: [
      { namespace: 'shared', count: 5 },
      { namespace: 'projects', count: 2 },
    ],
    by_source: [
      { source: 'openclaw', count: 4 },
      { source: 'manual', count: 2 },
      { source: null, count: 1 },
    ],
    total_documents: 3,
    oldest_memory: new Date('2024-01-02T03:04:05.000Z'),
    newest_memory: new Date('2026-09-12T01:02:03.000Z'),
  });
  assert.equal(pool.connectCount, 1);
  assert.equal(pool.releaseCount, 1);

  const aggregateCalls = pool.calls.filter(call => call.text.includes('FROM memories'));
  assert.equal(aggregateCalls.length, 1);
  assert.match(aggregateCalls[0].text, /GROUP BY GROUPING SETS \(\(\), \(namespace\), \(source\), \(document_id\)\)/);
  assert.match(aggregateCalls[0].text, /deleted_at IS NULL/);
  assert.match(aggregateCalls[0].text, /expires_at IS NULL OR expires_at > statement_timestamp\(\)/);
  assert.match(aggregateCalls[0].text, /consolidated_into_id IS NULL/);
  assert.doesNotMatch(aggregateCalls[0].text, /to_jsonb\(memories\)/);
  assert.match(aggregateCalls[0].text, /access_level IS NULL OR access_level = ANY\(\$2::text\[\]\)/);
  assert.deepEqual(aggregateCalls[0].params, [auth.namespaces, ['normal', 'sensitive']]);
  assert.ok(pool.calls.some(call =>
    call.text.includes("set_config('statement_timeout'") && call.params?.[0] === '10000'
  ));
  assert.ok(pool.calls.some(call => call.text.includes("set_config('enable_seqscan', 'off'")));
  assert.ok(pool.calls.some(call => call.text.includes("set_config('enable_bitmapscan', 'off'")));
  assert.equal(pool.calls.filter(call => call.text.includes("attname = 'consolidated_into_id'")).length, 1);
  assert.equal(pool.calls.filter(call => call.text.includes('INSERT INTO audit_log')).length, 1);
});

test('memoryStats maps every access ceiling to only its permitted levels', async () => {
  const cases: Array<[AuthContext['maxAccessLevel'], string[]]> = [
    ['normal', ['normal']],
    ['sensitive', ['normal', 'sensitive']],
    ['secret', ['normal', 'sensitive', 'secret']],
  ];

  for (const [maxAccessLevel, expected] of cases) {
    const pool = new StatsPool();
    setPoolForTesting(pool as unknown as pg.Pool);
    await memoryStats({}, { ...auth, maxAccessLevel });
    const aggregate = pool.calls.find(call => call.text.includes('WITH grouped AS'));
    assert.deepEqual(aggregate?.params, [auth.namespaces, expected]);
  }
});

test('memoryStats checks both admin and read permissions before checking out a connection', async () => {
  const pool = new StatsPool();
  setPoolForTesting(pool as unknown as pg.Pool);

  await assert.rejects(memoryStats({}, { ...auth, permissions: ['read'] }), /requires 'admin'/);
  await assert.rejects(memoryStats({}, { ...auth, permissions: ['admin'] }), /requires 'read'/);
  assert.equal(pool.connectCount, 0);
});

test('memoryStats adds a content-free ingestion block only while the queue gate is on', async t => {
  const previousGate = process.env.MEMORY_INGESTION_QUEUE_ENABLED;
  t.after(() => {
    if (previousGate === undefined) delete process.env.MEMORY_INGESTION_QUEUE_ENABLED;
    else process.env.MEMORY_INGESTION_QUEUE_ENABLED = previousGate;
  });

  delete process.env.MEMORY_INGESTION_QUEUE_ENABLED;
  const offPool = new StatsPool();
  setPoolForTesting(offPool as unknown as pg.Pool);
  const off = await memoryStats({}, auth);
  assert.equal('ingestion' in off, false, 'gate off: the response shape is unchanged');
  assert.equal(offPool.calls.some(call => /memory_ingestion_jobs|instance_settings/.test(call.text)), false, 'gate off: no queue table traffic');

  process.env.MEMORY_INGESTION_QUEUE_ENABLED = 'true';
  const onPool = new StatsPool();
  setPoolForTesting(onPool as unknown as pg.Pool);
  const on = await memoryStats({}, auth);
  assert.deepEqual(Object.keys(on), ['total_memories', 'by_namespace', 'by_source', 'total_documents', 'oldest_memory', 'newest_memory', 'ingestion']);
  assert.equal(on.total_memories, 7);
  assert.deepEqual(on.ingestion, {
    depth: { pending: 2, processing: 0, retry_wait: 0, ready: 0, deduplicated: 0, embedding_failed: 1, cancelled: 0 },
    queued: 2,
    oldest_pending_age_seconds: 90.25,
    next_retry_at: null,
    attempts_histogram: [{ attempts: 0, count: 2 }, { attempts: 12, count: 1 }],
    failure_categories: { transient: 0, rate_limited: 0, provider_auth: 0, input_rejected: 1, space_mismatch: 0, expired: 0 },
    inline: { attempted: 0, ready: 0, deduplicated: 0, queued: 0 },
    worker: { paused: false, last_seen_at: new Date('2026-09-12T01:02:03.000Z') },
  });
  assert.equal(onPool.connectCount, 1, 'the queue aggregates ride the same scoped checkout');
  assert.equal(onPool.releaseCount, 1);
  const queueCalls = onPool.calls.filter(call => /memory_ingestion_jobs|instance_settings/.test(call.text));
  assert.equal(queueCalls.length, 5);
  for (const call of queueCalls) {
    assert.doesNotMatch(call.text, /\bcontent\b|\bmemories\b|source_key|lease_token/);
  }
  const audits = onPool.calls.filter(call => call.text.includes('INSERT INTO audit_log'));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].params?.[1], 'memory.stats');
  assert.ok(onPool.calls.indexOf(queueCalls[0]) < onPool.calls.indexOf(audits[0]), 'aggregates precede the audit row inside the transaction');
});

test('concurrent memoryStats requests each use one checkout and one aggregate', async () => {
  const pool = new StatsPool();
  setPoolForTesting(pool as unknown as pg.Pool);

  const results = await Promise.all(Array.from({ length: 12 }, () => memoryStats({}, auth)));

  assert.equal(results.length, 12);
  assert.equal(pool.connectCount, 12);
  assert.equal(pool.releaseCount, 12);
  assert.equal(pool.calls.filter(call => call.text.includes('WITH grouped AS')).length, 12);
  assert.equal(pool.calls.filter(call => call.text.includes('INSERT INTO audit_log')).length, 12);
});
