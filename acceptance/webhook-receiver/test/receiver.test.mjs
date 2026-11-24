import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import worker, { AcceptanceState } from '../src/index.mjs';

const subscriptionId = randomUUID(), memoryId = randomUUID(), eventId = randomUUID();
const secrets = {
  WEBHOOK_SIGNING_SECRET: 'webhook-signing-secret-at-least-32-bytes',
  RECEIPT_BEARER: 'receipt-bearer-secret-at-least-32-bytes',
  RECEIPT_SIGNING_SECRET: 'receipt-signing-secret-at-least-32-bytes',
};

function payload(overrides = {}) {
  return { event_id: eventId, memory: { created_at: '2026-11-24T01:02:03.000Z', id: memoryId, namespace: 'acceptance' },
    subscription_id: subscriptionId, type: 'memory.stored', version: 1, ...overrides };
}
function signedRequest(value = payload(), options = {}) {
  const body = options.body ?? JSON.stringify(value);
  const signature = options.signature ?? `sha256=${createHmac('sha256', secrets.WEBHOOK_SIGNING_SECRET).update(body).digest('hex')}`;
  return new Request('https://worker.example/webhook', { method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json', 'x-total-recall-event-id': value.event_id ?? eventId,
      'x-total-recall-signature': signature, ...(options.headers ?? {}) }, body: options.method === 'GET' ? undefined : body });
}
function environment() {
  const objects = new Map();
  const env = { ...secrets, EXPECTED_SUBSCRIPTION_ID: subscriptionId, EXPECTED_MEMORY_ID: memoryId, EXPECTED_NAMESPACE: 'acceptance' };
  env.ACCEPTANCE_STATE = {
    idFromName: name => name,
    get(id) {
      if (!objects.has(id)) objects.set(id, new AcceptanceState({ storage: new MemoryStorage() }));
      return { fetch: (...args) => objects.get(id).fetch(new Request(...args)) };
    },
  };
  return env;
}
class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async transaction(callback) { return callback(this); }
}

test('valid exact-body signature deliberately retries once, then accepts and idempotently replays', async () => {
  const env = environment();
  const first = await worker.fetch(signedRequest(), env);
  assert.equal(first.status, 503);
  assert.equal(first.headers.get('retry-after'), '1');
  assert.equal((await worker.fetch(signedRequest(), env)).status, 204);
  assert.equal((await worker.fetch(signedRequest(), env)).status, 204);
  assert.equal((await worker.fetch(new Request(`https://worker.example/receipts/${eventId}`), env)).status, 401);
  const receiptResponse = await worker.fetch(new Request(`https://worker.example/receipts/${eventId}`, {
    headers: { authorization: `Bearer ${secrets.RECEIPT_BEARER}` },
  }), env);
  assert.equal(receiptResponse.status, 200);
  assert.equal(receiptResponse.headers.get('cache-control'), 'no-store');
  const receiptBody = await receiptResponse.text();
  const expected = `sha256=${createHmac('sha256', secrets.RECEIPT_SIGNING_SECRET).update(receiptBody).digest('hex')}`;
  assert.equal(receiptResponse.headers.get('x-total-recall-receipt-signature'), expected);
  const receipt = JSON.parse(receiptBody);
  assert.deepEqual({ status: receipt.status, event_id: receipt.event_id, subscription_id: receipt.subscription_id,
    memory_id: receipt.memory_id, attempt_count: receipt.attempt_count },
  { status: 'accepted', event_id: eventId, subscription_id: subscriptionId, memory_id: memoryId, attempt_count: 2 });
  assert.equal(JSON.stringify(receipt).includes('content'), false);
});

test('rejects invalid signatures, body mutation, wrong identifiers, methods and oversize input', async () => {
  const env = environment();
  assert.equal((await worker.fetch(signedRequest(payload(), { signature: `sha256=${'0'.repeat(64)}` }), env)).status, 401);
  const original = JSON.stringify(payload());
  assert.equal((await worker.fetch(signedRequest(payload(), { body: `${original}\n`, signature: `sha256=${createHmac('sha256', secrets.WEBHOOK_SIGNING_SECRET).update(original).digest('hex')}` }), env)).status, 401);
  assert.equal((await worker.fetch(signedRequest(payload({ subscription_id: randomUUID() })), env)).status, 403);
  assert.equal((await worker.fetch(signedRequest(payload({ memory: { ...payload().memory, id: randomUUID() } })), env)).status, 403);
  assert.equal((await worker.fetch(signedRequest(payload(), { method: 'GET' }), env)).status, 405);
  assert.equal((await worker.fetch(signedRequest(payload(), { headers: { 'content-length': '4097' } }), env)).status, 413);
  const chunkedOversize = new Request('https://worker.example/webhook', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-total-recall-event-id': eventId,
      'x-total-recall-signature': `sha256=${'0'.repeat(64)}` }, body: 'x'.repeat(5000) });
  assert.equal(chunkedOversize.headers.get('content-length'), null);
  assert.equal((await worker.fetch(chunkedOversize, env)).status, 413);
});

test('same event id with different exact body cannot overwrite durable receipt', async () => {
  const env = environment();
  assert.equal((await worker.fetch(signedRequest(), env)).status, 503);
  const changed = payload({ memory: { ...payload().memory, created_at: '2026-11-24T01:02:04.000Z' } });
  assert.equal((await worker.fetch(signedRequest(changed), env)).status, 409);
});
