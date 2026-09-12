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
