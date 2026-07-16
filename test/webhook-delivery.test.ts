import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWebhookPayload, type AuthorizedDelivery } from '../src/subscriptions.js';
import { isRetryableStatus, parseWebhookWorkerCli, retryAtForAttempt } from '../scripts/webhook-delivery.js';

const delivery: AuthorizedDelivery = {
  deliveryId: '10000000-0000-4000-8000-000000000001',
  eventId: '10000000-0000-4000-8000-000000000002',
  subscriptionId: '10000000-0000-4000-8000-000000000003',
  ownerKeyId: '10000000-0000-4000-8000-000000000004',
  memoryId: '10000000-0000-4000-8000-000000000005',
  namespace: 'shared', memoryCreatedAt: new Date('2026-01-02T03:04:05.000Z'),
  similarity: 0.99, eventCreatedAt: new Date('2026-01-02T03:04:06.000Z'),
  encryptedUrl: { keyId: 'k', ciphertext: Buffer.alloc(0), iv: Buffer.alloc(12), tag: Buffer.alloc(16) },
  encryptedSecret: { keyId: 'k', ciphertext: Buffer.alloc(0), iv: Buffer.alloc(12), tag: Buffer.alloc(16) },
};

test('webhook payload is versioned ID-only metadata with no exportable memory fields', () => {
  assert.deepEqual(buildWebhookPayload(delivery), {
    event_id: delivery.eventId,
    memory: { created_at: '2026-01-02T03:04:05.000Z', id: delivery.memoryId, namespace: 'shared' },
    subscription_id: delivery.subscriptionId, type: 'memory.stored', version: 1,
  });
  const serialized = JSON.stringify(buildWebhookPayload(delivery));
  for (const forbidden of ['content', 'summary', 'source', 'tags', 'metadata', 'similarity', 'ownerKeyId']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('delivery retry classification and schedule are bounded', () => {
  for (const status of [408, 425, 429, 500, 503]) assert.equal(isRetryableStatus(status), true);
  for (const status of [200, 301, 400, 401, 404]) assert.equal(isRetryableStatus(status), false);
  const now = new Date('2026-01-01T00:00:00Z');
  const first = retryAtForAttempt(1, undefined, now).getTime() - now.getTime();
  assert.ok(first >= 60_000 && first <= 72_000);
  const capped = retryAtForAttempt(6, '999999', now).getTime() - now.getTime();
  assert.ok(capped <= 43_200_000 && capped >= 43_200_000);
});

test('worker CLI enforces bounded concurrency and polling', () => {
  assert.deepEqual(parseWebhookWorkerCli(['--once', '--max-jobs', '2', '--concurrency', '1'], {} as NodeJS.ProcessEnv),
    { once: true, maxJobs: 2, pollMs: 1000, concurrency: 1 });
  assert.throws(() => parseWebhookWorkerCli(['--concurrency', '33']));
  assert.throws(() => parseWebhookWorkerCli(['--poll-ms', '10']));
});
