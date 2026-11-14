import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterEmbeddingClient } from '../src/openrouter-embedding-client.js';
import { LocalEmbeddingError } from '../src/local-embedding-client.js';
import { QWEN_CHUNK_CONTRACT, QWEN_QUERY_PREFIX } from '../src/local-embedding-contract.js';

function fixture(mutate?: (body: Record<string, any>) => void) {
  const calls: Array<{ url: string; body: any; init: RequestInit }> = [];
  let guarded = 0;
  const count = async (value: string) => Math.max(1, Math.ceil(value.length / 4));
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(init?.body as string);
    calls.push({ url: String(url), body: request, init: init! });
    const response: Record<string, any> = {
      model: QWEN_CHUNK_CONTRACT.model, provider: QWEN_CHUNK_CONTRACT.hostedProvider,
      data: request.input.map((_: string, index: number) => ({
        index,
        embedding: Array(QWEN_CHUNK_CONTRACT.nativeDimensions).fill(index + 1),
      })),
      usage: { prompt_tokens: request.input.reduce((sum: number, value: string) => sum + Math.max(1, Math.ceil(value.length / 4)), 0) },
    };
    mutate?.(response);
    return Response.json(response);
  };
  const client = new OpenRouterEmbeddingClient({
    apiKey: 'fixture-secret',
    countFormattedTokens: count,
    beforeInference: async () => { guarded++; },
    fetch: fetcher as typeof fetch,
  });
  return { client, calls, guarded: () => guarded };
}

test('pins OpenRouter model and provider while preserving exact query formatting', async () => {
  const f = fixture();
  const result = await f.client.embed(['public query'], 'query');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://openrouter.ai/api/v1/embeddings');
  assert.equal(f.calls[0].body.model, QWEN_CHUNK_CONTRACT.hostedModel);
  assert.deepEqual(f.calls[0].body.provider, { order: ['DeepInfra'], allow_fallbacks: false });
  assert.equal(f.calls[0].body.input[0], QWEN_QUERY_PREFIX + 'public query');
  assert.equal(f.calls[0].body.encoding_format, 'float');
  assert.equal(f.calls[0].init.redirect, 'error');
  assert.equal(result.vectors[0].length, QWEN_CHUNK_CONTRACT.storedDimensions);
  assert.ok(Math.abs(Math.hypot(...result.vectors[0]) - 1) < 1e-12);
  assert.equal(f.guarded(), 1);
});

test('rejects alternate endpoints, credentials and oversized batches before inference', async () => {
  const base = { apiKey: 'x', countFormattedTokens: async () => 1, beforeInference: async () => {} };
  for (const baseUrl of ['http://openrouter.ai/api/v1/', 'https://example.com/api/v1/', 'https://openrouter.ai:444/api/v1/', 'https://openrouter.ai/api/v1/?key=x']) {
    assert.throws(() => new OpenRouterEmbeddingClient({ ...base, baseUrl }), /openrouter_endpoint/);
  }
  assert.throws(() => new OpenRouterEmbeddingClient({ ...base, apiKey: 'x\ny' }), /credential/);
  const f = fixture();
  await assert.rejects(f.client.embed(Array(5).fill('x'), 'document'), /batch_input_limit/);
  assert.equal(f.calls.length, 0);
});

test('hosted planning and inference use the same upstream NFC representation', async () => {
  const raw = 'cafe\u0301\r\n'; const normalized = raw.normalize('NFC');
  const observed: string[] = [];
  const client = new OpenRouterEmbeddingClient({apiKey: 'fixture', beforeInference: async () => {},
    countFormattedTokens: async text => { observed.push(text); return 2; },
    fetch: (async (_url, init) => {
      assert.deepEqual(JSON.parse(init!.body as string).input, [normalized]);
      return Response.json({model: QWEN_CHUNK_CONTRACT.model, provider: 'DeepInfra',
        data: [{index: 0, embedding: Array(QWEN_CHUNK_CONTRACT.nativeDimensions).fill(1)}], usage: {prompt_tokens: 2}});
    }) as typeof fetch});
  assert.equal(await client.countFormattedTokens(raw), 2);
  await client.embed([raw], 'document');
  assert.deepEqual(observed, [normalized, normalized]);
});

test('response identity, vector shape and tokenizer accounting fail closed', async () => {
  for (const mutate of [
    (body: any) => { body.model = "qwen/qwen3-embedding-8b"; },
    (body: any) => { body.provider = "other"; },
    (body: any) => { delete body.model; },
    (body: any) => { delete body.provider; },
    (body: any) => { body.data = []; },
    (body: any) => { body.data[0].index = 4; },
    (body: any) => { body.data[0].embedding = Array(768).fill(1); },
    (body: any) => { body.usage.prompt_tokens++; },
    (body: any) => { delete body.usage; },
  ]) {
    await assert.rejects(fixture(mutate).client.embed(['x'], 'document'),
      error => error instanceof LocalEmbeddingError && error.classification === 'systemic');
  }
});

test('provider failures are bounded and response bodies are never propagated', async () => {
  for (const [status, classification] of [[400, 'input'], [401, 'systemic'], [429, 'retryable'], [502, 'retryable']] as const) {
    const client = new OpenRouterEmbeddingClient({
      apiKey: 'fixture',
      countFormattedTokens: async () => 1,
      beforeInference: async () => {},
      fetch: (async () => new Response('private corpus and credential material', {
        status, headers: { 'Retry-After': '600' },
      })) as typeof fetch,
    });
    await assert.rejects(client.embed(['x'], 'document'), error => error instanceof LocalEmbeddingError
      && error.classification === classification && error.retryAfterMs === 300_000 && !error.message.includes('private'));
  }
});

test('hosted response bodies are byte bounded before parsing', async () => {
  const client = new OpenRouterEmbeddingClient({
    apiKey: 'test-key',
    countFormattedTokens: async () => 1,
    beforeInference: async () => {},
    fetch: (async () => new Response('{}', {
      headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) },
    })) as typeof fetch,
  });
  await assert.rejects(client.embed(['x'], 'document'), error => error instanceof LocalEmbeddingError
    && error.message === 'embedding.openrouter_response_limit' && error.classification === 'systemic');
});
test('failed guard prevents the hosted inference request', async () => {
  let calls = 0;
  const client = new OpenRouterEmbeddingClient({
    apiKey: 'fixture',
    countFormattedTokens: async () => 1,
    beforeInference: async () => { throw new Error('resource guard'); },
    fetch: (async () => { calls++; return Response.json({}); }) as typeof fetch,
  });
  await assert.rejects(client.embed(['x'], 'document'), /resource guard/);
  assert.equal(calls, 0);
});
