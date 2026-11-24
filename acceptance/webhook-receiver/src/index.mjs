const MAX_BODY_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      assertConfiguration(env);
      if (url.pathname === '/webhook') return await receiveWebhook(request, env);
      if (url.pathname.startsWith('/receipts/')) return await readReceipt(request, env, url.pathname.slice('/receipts/'.length));
      return response(404);
    } catch (error) {
      // Deliberately content-free. Never log request bodies, signatures, or secrets.
      return response(error instanceof HttpError ? error.status : 500);
    }
  },
};

export class AcceptanceState {
  constructor(state) { this.storage = state.storage; }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/attempt') {
      const attempt = await request.json();
      let status = 500;
      await this.storage.transaction(async tx => {
        const existing = await tx.get('receipt');
        if (existing && (existing.event_id !== attempt.event_id || existing.body_sha256 !== attempt.body_sha256 ||
          existing.subscription_id !== attempt.subscription_id || existing.memory_id !== attempt.memory_id)) {
          status = 409;
          return;
        }
        if (!existing) {
          await tx.put('receipt', {
            version: 1, status: 'retry_issued', event_id: attempt.event_id,
            subscription_id: attempt.subscription_id, memory_id: attempt.memory_id,
            body_sha256: attempt.body_sha256, attempt_count: 1,
            retry_issued_at: new Date().toISOString(), accepted_at: null,
          });
          status = 503;
          return;
        }
        if (existing.status === 'accepted') { status = 204; return; }
        await tx.put('receipt', { ...existing, status: 'accepted', attempt_count: existing.attempt_count + 1,
          accepted_at: new Date().toISOString() });
        status = 204;
      });
      return response(status, status === 503 ? { 'retry-after': '1' } : undefined);
    }
    if (request.method === 'GET' && url.pathname === '/receipt') {
      const receipt = await this.storage.get('receipt');
      if (!receipt || receipt.status !== 'accepted') return response(404);
      return new Response(JSON.stringify(receipt), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return response(404);
  }
}

async function receiveWebhook(request, env) {
  if (request.method !== 'POST') throw new HttpError(405);
  if (!isJson(request.headers.get('content-type'))) throw new HttpError(415);
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new HttpError(413);
  const body = await readBoundedBody(request);
  if (body.byteLength === 0) throw new HttpError(400);
  if (body.byteLength > MAX_BODY_BYTES) throw new HttpError(413);
  if (!await verifyHmac(body, env.WEBHOOK_SIGNING_SECRET, request.headers.get('x-total-recall-signature') ?? '')) throw new HttpError(401);

  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new HttpError(400); }
  validatePayload(payload, env);
  if (request.headers.get('x-total-recall-event-id') !== payload.event_id) throw new HttpError(400);

  const id = env.ACCEPTANCE_STATE.idFromName(payload.event_id);
  return env.ACCEPTANCE_STATE.get(id).fetch('https://acceptance.invalid/attempt', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: payload.event_id, subscription_id: payload.subscription_id,
      memory_id: payload.memory.id, body_sha256: await sha256Hex(body) }),
  });
}

async function readReceipt(request, env, eventId) {
  if (request.method !== 'GET') throw new HttpError(405);
  if (!UUID.test(eventId)) throw new HttpError(404);
  if (!await constantTimeEqual(request.headers.get('authorization') ?? '', `Bearer ${env.RECEIPT_BEARER}`)) throw new HttpError(401);
  const id = env.ACCEPTANCE_STATE.idFromName(eventId);
  const stored = await env.ACCEPTANCE_STATE.get(id).fetch('https://acceptance.invalid/receipt');
  if (stored.status !== 200) return response(stored.status);
  const body = new Uint8Array(await stored.arrayBuffer());
  const signature = await hmac(body, env.RECEIPT_SIGNING_SECRET);
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-total-recall-receipt-signature': `sha256=${hex(signature)}` } });
}

function validatePayload(payload, env) {
  if (!plainObject(payload) || !exactKeys(payload, ['event_id', 'memory', 'subscription_id', 'type', 'version'])) throw new HttpError(400);
  if (payload.version !== 1 || payload.type !== 'memory.stored') throw new HttpError(400);
  if (!UUID.test(payload.event_id) || payload.subscription_id !== env.EXPECTED_SUBSCRIPTION_ID) throw new HttpError(403);
  if (!plainObject(payload.memory) || !exactKeys(payload.memory, ['created_at', 'id', 'namespace'])) throw new HttpError(400);
  if (payload.memory.id !== env.EXPECTED_MEMORY_ID || payload.memory.namespace !== env.EXPECTED_NAMESPACE) throw new HttpError(403);
  if (typeof payload.memory.created_at !== 'string' || !ISO_INSTANT.test(payload.memory.created_at) ||
    !Number.isFinite(Date.parse(payload.memory.created_at))) throw new HttpError(400);
}

function assertConfiguration(env) {
  for (const name of ['WEBHOOK_SIGNING_SECRET', 'RECEIPT_BEARER', 'RECEIPT_SIGNING_SECRET']) {
    if (typeof env[name] !== 'string' || env[name].length < 32) throw new Error(`missing ${name}`);
  }
  if (!UUID.test(env.EXPECTED_SUBSCRIPTION_ID ?? '') || !UUID.test(env.EXPECTED_MEMORY_ID ?? '')) throw new Error('invalid expected IDs');
  if (typeof env.EXPECTED_NAMESPACE !== 'string' || env.EXPECTED_NAMESPACE.length < 1 || env.EXPECTED_NAMESPACE.length > 255) throw new Error('invalid expected namespace');
  if (!env.ACCEPTANCE_STATE) throw new Error('missing durable object binding');
}

async function verifyHmac(body, secret, supplied) {
  if (!/^sha256=[0-9a-f]{64}$/.test(supplied)) return false;
  return constantTimeEqual(supplied, `sha256=${hex(await hmac(body, secret))}`);
}
async function hmac(body, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
}
async function sha256Hex(body) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', body))); }
async function readBoundedBody(request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
async function constantTimeEqual(left, right) {
  const leftBytes = new TextEncoder().encode(left), rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length, 1);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) difference |= (leftBytes[index % leftBytes.length] ?? 0) ^ (rightBytes[index % rightBytes.length] ?? 0);
  return difference === 0;
}
function exactKeys(value, expected) { const keys = Object.keys(value).sort(), sorted = [...expected].sort(); return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function isJson(value) { return typeof value === 'string' && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value); }
function hex(bytes) { return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
function response(status, headers) { return new Response(null, { status, headers }); }
class HttpError extends Error { constructor(status) { super(String(status)); this.status = status; } }
