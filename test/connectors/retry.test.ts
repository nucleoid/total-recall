import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HttpStatusError,
  retryAfterMilliseconds,
  retryConnectorOperation,
} from '../../src/connectors/retry.js';

test('connector retry is bounded and respects Retry-After for transient responses', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await retryConnectorOperation(async () => {
    attempts++;
    if (attempts < 3) throw new HttpStatusError('limited', 429, '2');
    return 'ok';
  }, {
    maxAttempts: 3,
    sleep: async (delay) => { delays.push(delay); },
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [2000, 2000]);
});

test('connector retry never retries auth/validation failures', async () => {
  let attempts = 0;
  await assert.rejects(
    () => retryConnectorOperation(async () => {
      attempts++;
      throw new HttpStatusError('forbidden', 403);
    }),
    /forbidden/,
  );
  assert.equal(attempts, 1);
});

test('connector retry cancellation interrupts jitter sleep', async () => {
  const abort = new AbortController();
  const promise = retryConnectorOperation(async () => {
    throw new HttpStatusError('unavailable', 503);
  }, { signal: abort.signal, baseDelayMs: 10_000 });
  abort.abort(new Error('stopped'));
  await assert.rejects(() => promise, /stopped/);
});

test('Retry-After accepts seconds and HTTP dates', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(retryAfterMilliseconds('1.5', now), 1500);
  assert.equal(retryAfterMilliseconds('Thu, 01 Jan 2026 00:00:03 GMT', now), 3000);
  assert.equal(retryAfterMilliseconds('invalid', now), null);
});
