import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { RateLimitExceededError, consumeRateLimit, rateLimitRetentionDaysFromEnv } from '../src/security.js';

function clientWithCounts(minute: number, day: number): { client: PoolClient; sql: string[] } {
  const sql: string[] = [];
  const client = {
    async query(text: string) {
      sql.push(text);
      if (text.includes('WITH bounds AS')) {
        return { rows: [{
          now: new Date('2026-07-16T12:34:30Z'),
          minute_start: new Date('2026-07-16T12:34:00Z'),
          day_start: '2026-07-16',
          minute_count: minute,
          day_count: day,
        }] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, sql };
}

const key = '11111111-1111-4111-8111-111111111111';

test('legacy null quotas remain unlimited without touching PostgreSQL', async () => {
  const { client, sql } = clientWithCounts(100, 100);
  const result = await consumeRateLimit({ keyId: key, requestsPerMinute: null, requestsPerDay: null }, { client });
  assert.equal(result.allowed, true);
  assert.deepEqual(sql, []);
});

test('quota denial increments neither fixed window', async () => {
  const { client, sql } = clientWithCounts(2, 5);
  await assert.rejects(
    consumeRateLimit({ keyId: key, requestsPerMinute: 2, requestsPerDay: 10 }, { client }),
    (error: unknown) => error instanceof RateLimitExceededError && error.result.retryAfterSeconds === 30,
  );
  assert.equal(sql.filter(statement => statement.includes('INSERT INTO api_key_')).length, 0);
});

test('Retry-After waits for every exhausted window to reopen', async () => {
  const { client } = clientWithCounts(2, 10);
  await assert.rejects(
    consumeRateLimit({ keyId: key, requestsPerMinute: 2, requestsPerDay: 10 }, { client }),
    (error: unknown) => error instanceof RateLimitExceededError && error.result.retryAfterSeconds === 41_130,
  );
});

test('allowed operation charges both windows and reports post-charge remaining', async () => {
  const { client, sql } = clientWithCounts(1, 4);
  const result = await consumeRateLimit({ keyId: key, requestsPerMinute: 3, requestsPerDay: 10 }, { client });
  assert.equal(result.minute?.remaining, 1);
  assert.equal(result.day?.remaining, 5);
  assert.equal(sql.filter(statement => statement.includes('INSERT INTO api_key_')).length, 2);
});

test('usage retention is bounded and strict', () => {
  assert.equal(rateLimitRetentionDaysFromEnv(undefined), 7);
  assert.equal(rateLimitRetentionDaysFromEnv('30'), 30);
  assert.throws(() => rateLimitRetentionDaysFromEnv('0'), /1 to 3650/);
  assert.throws(() => rateLimitRetentionDaysFromEnv('1.5'), /positive integer/);
});
