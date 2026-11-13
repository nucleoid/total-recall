import assert from 'node:assert/strict';
import test from 'node:test';
import { embedWithProfile } from '../src/embedding.js';

test('provider failures retain typed HTTP status and Retry-After without response content', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('private-provider-payload', {
    status: 429, headers: { 'Retry-After': '123' },
  }));
  await assert.rejects(embedWithProfile('accepted content'), error => {
    const failure = error as Error & { status: number; retryAfter: string };
    assert.equal(failure.status, 429);
    assert.equal(failure.retryAfter, '123');
    assert.doesNotMatch(failure.message, /private-provider-payload/);
    return true;
  });
});
