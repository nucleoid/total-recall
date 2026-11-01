import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EmbeddingProviderError,
  embedBatchWithProfile,
  embedWithProfile,
  type EmbeddingProfile,
} from '../src/embedding.js';

const gemini: EmbeddingProfile = {
  name: 'production', provider: 'gemini', model: 'gemini-embedding-2-preview', dimensions: 768, apiKey: 'test-only-key',
};
const ollama: EmbeddingProfile = {
  name: 'legacy', provider: 'ollama', model: 'nomic-embed-text', dimensions: 768, baseUrl: 'http://embed.invalid',
};

function stubFetch(t: { after(fn: () => void): void }, respond: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  const original = globalThis.fetch;
  globalThis.fetch = respond as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
}

async function failure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail('expected the embedding call to reject');
}

test('rate-limited provider responses carry status, Retry-After and provider with the original message', async t => {
  stubFetch(t, async () => new Response('{"error":"slow down"}', {
    status: 429, headers: { 'Retry-After': '30', 'Content-Type': 'application/json' },
  }));
  const error = await failure(() => embedWithProfile('text', gemini));
  assert.ok(error instanceof EmbeddingProviderError);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'EmbeddingProviderError');
  assert.equal(error.status, 429);
  assert.equal(error.retryAfter, '30');
  assert.equal(error.provider, 'gemini');
  assert.equal(error.message, 'Gemini embedContent failed (429): {"error":"slow down"}');
});

test('server errors without Retry-After leave retryAfter undefined', async t => {
  stubFetch(t, async () => new Response('upstream unavailable', { status: 500 }));
  const error = await failure(() => embedWithProfile('text', gemini));
  assert.ok(error instanceof EmbeddingProviderError);
  assert.equal(error.status, 500);
  assert.equal(error.retryAfter, undefined);
  assert.equal(error.provider, 'gemini');
  assert.equal(error.message, 'Gemini embedContent failed (500): upstream unavailable');
});

test('input rejections are typed with the rejecting status and the unchanged message text', async t => {
  stubFetch(t, async () => new Response('bad request body', { status: 400 }));
  const error = await failure(() => embedWithProfile('text', gemini));
  assert.ok(error instanceof EmbeddingProviderError);
  assert.equal(error.status, 400);
  assert.equal(error.retryAfter, undefined);
  assert.equal(error.message, 'Gemini embedContent failed (400): bad request body');
  // Existing message-based classifiers in the archive sync path still match.
  assert.match(error.message, /^(?:Gemini (?:batchEmbedContents|embedContent)|Ollama embed) failed \((400|413|422)\):/);
});

test('batch and Ollama requests produce the same typed error with their own message prefixes', async t => {
  let call = 0;
  stubFetch(t, async () => {
    call += 1;
    return call === 1
      ? new Response('quota', { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } })
      : new Response('model loading', { status: 503 });
  });
  const batch = await failure(() => embedBatchWithProfile(['one', 'two'], gemini));
  assert.ok(batch instanceof EmbeddingProviderError);
  assert.equal(batch.status, 429);
  assert.equal(batch.retryAfter, 'Wed, 21 Oct 2026 07:28:00 GMT');
  assert.equal(batch.provider, 'gemini');
  assert.equal(batch.message, 'Gemini batchEmbedContents failed (429): quota');

  const local = await failure(() => embedWithProfile('text', ollama));
  assert.ok(local instanceof EmbeddingProviderError);
  assert.equal(local.status, 503);
  assert.equal(local.retryAfter, undefined);
  assert.equal(local.provider, 'ollama');
  assert.equal(local.message, 'Ollama embed failed (503): model loading');
});

test('aborts and timeouts propagate untouched instead of being wrapped as provider errors', async t => {
  stubFetch(t, async (_input, init) => {
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason;
    throw new DOMException('The operation was aborted', 'AbortError');
  });
  const aborted = await failure(() => embedWithProfile('text', gemini, AbortSignal.abort()));
  assert.equal(aborted instanceof EmbeddingProviderError, false);
  assert.ok(aborted instanceof DOMException);
  assert.equal(aborted.name, 'AbortError');

  const timedOut = await failure(() => embedWithProfile('text', ollama, AbortSignal.timeout(1)));
  assert.equal(timedOut instanceof EmbeddingProviderError, false);
  assert.ok(timedOut instanceof DOMException);
  assert.ok(timedOut.name === 'TimeoutError' || timedOut.name === 'AbortError');
});

test('successful responses are unaffected by the typed error path', async t => {
  stubFetch(t, async () => new Response(JSON.stringify({ embedding: { values: Array(768).fill(0.5) } }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));
  assert.deepEqual(await embedWithProfile('text', gemini), {
    vector: Array(768).fill(0.5), provider: 'gemini', model: 'gemini-embedding-2-preview', dimensions: 768,
  });
});
