import assert from 'node:assert/strict';
import test from 'node:test';
import {
  purgeExpiredMemories,
  ttlPurgeBatchSizeFromEnv,
} from '../src/maintenance.js';

test('TTL purge validates its bounded batch configuration', () => {
  assert.equal(ttlPurgeBatchSizeFromEnv(undefined), 1_000);
  assert.equal(ttlPurgeBatchSizeFromEnv('1'), 1);
  assert.equal(ttlPurgeBatchSizeFromEnv('100000'), 100_000);
  for (const value of ['', '0', '-1', '1.5', '100001', 'wat']) {
    assert.throws(() => ttlPurgeBatchSizeFromEnv(value), /between 1 and 100000/);
  }
});

test('TTL purge loops bounded overlap-safe batches and aggregates namespace counts', async () => {
  const responses = [
    { rows: [
      { namespace: 'shared', count: '2', batch_count: '3' },
      { namespace: 'working', count: '1', batch_count: '3' },
    ] },
    { rows: [{ namespace: 'working', count: '1', batch_count: '1' }] },
    { rows: [] },
  ];
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return responses.shift()!;
    },
  };

  assert.deepEqual(await purgeExpiredMemories(client, 3), {
    count: 4,
    batches: 2,
    byNamespace: { shared: 2, working: 2 },
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.values), [[3], [3], [3]]);
  assert.match(calls[0].sql, /expires_at <= statement_timestamp\(\)/);
  assert.match(calls[0].sql, /ORDER BY expires_at, id[\s\S]*LIMIT \$1[\s\S]*FOR UPDATE SKIP LOCKED/);
  assert.match(calls[0].sql, /DELETE FROM public\.memories/);
  assert.match(calls[0].sql, /'ttl_purge'/);
  assert.match(calls[0].sql, /WHERE count > 0/);
});

test('TTL purge rejects invalid database batch accounting', async () => {
  const client = {
    query: async () => ({ rows: [{ namespace: 'working', count: '2', batch_count: '2' }] }),
  };
  await assert.rejects(purgeExpiredMemories(client, 1), /invalid batch count/);
});
