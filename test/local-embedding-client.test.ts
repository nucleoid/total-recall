import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalEmbeddingClient, LocalEmbeddingError } from '../src/local-embedding-client.js';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID, QWEN_QUERY_PREFIX } from '../src/local-embedding-contract.js';

const runtime = { contractId: QWEN_CONTRACT_ID, artifactSha256: QWEN_CHUNK_CONTRACT.artifactSha256,
  runtimeContract: QWEN_CHUNK_CONTRACT.runtimeContract, acceptanceReceiptSha256: 'a'.repeat(64) };
function fixture(mutator?: (body: Record<string, any>) => void, tokenize = (s: string) => s.length + 2) {
  const calls: Array<{ url: string; body: any; init: RequestInit }> = [];
  let guards = 0;
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    calls.push({ url: String(url), body, init: init! });
    if (String(url).endsWith('/tokenize')) return Response.json({ tokens: Array(tokenize(body.content)).fill(1) });
    const response = { data: body.input.map((_: string, i: number) => ({ index: i, embedding: Array(QWEN_CHUNK_CONTRACT.nativeDimensions).fill(i + 1) })),
      usage: { prompt_tokens: body.input.reduce((n: number, s: string) => n + tokenize(s), 0) } };
    mutator?.(response);
    return Response.json(response);
  };
  const client = new LocalEmbeddingClient({ baseUrl: 'http://127.0.0.1:18089', bearerToken: 'fixture', runtime,
    fetch: fetcher as typeof fetch, beforeInference: async () => { guards++; } });
  return { client, calls, guards: () => guards };
}

test('exact role formatting, special tokens, no truncation and guarded native projection', async () => {
  const f = fixture();
  const result = await f.client.embed(['query'], 'query');
  assert.equal(f.calls[0].body.content, QWEN_QUERY_PREFIX + 'query');
  assert.equal(f.calls[0].body.add_special, true);
  assert.equal(f.calls[1].body.truncate, false);
  assert.equal(f.calls[1].init.redirect, 'error');
  assert.equal(result.vectors[0].length, 768);
  assert.equal(f.guards(), 1);
  const docs = fixture(); await docs.client.embed(['raw', 'also raw'], 'document');
  assert.deepEqual(docs.calls[2].body.input, ['raw', 'also raw']);
});

test('input and aggregate budgets reject before inference without truncation', async () => {
  const f = fixture();
  await assert.rejects(f.client.embed(['x'.repeat(255)], 'document'), /request_token_limit/);
  await assert.rejects(f.client.embed(['x'.repeat(2001)], 'query'), /request_token_limit/);
  await assert.rejects(f.client.embed(Array(5).fill('x'), 'document'), /batch_input_limit/);
  await assert.rejects(f.client.embed(['x'.repeat(1000), 'x'.repeat(1000)], 'query'), /request_token_limit/);
  assert.equal(f.calls.filter(c => c.url.endsWith('/v1/embeddings')).length, 0);
  assert.equal(f.guards(), 0);
});

test('NFC tokenization is identical for raw chunk planning and document/query inference', async () => {
  const text = 'cafe\u0301\r\n'; const normalized = text.normalize('NFC');
  const f = fixture(); await f.client.countFormattedTokens(text);
  assert.equal(f.calls[0].body.content, normalized);
  const doc = fixture(); const result = await doc.client.embed([text], 'document');
  assert.equal(doc.calls[0].body.content, normalized);
  assert.deepEqual(doc.calls[1].body.input, [normalized]);
  assert.deepEqual(result.tokens, [normalized.length + 2]);
  const query = fixture(); await query.client.embed([text], 'query');
  assert.equal(query.calls[0].body.content, QWEN_QUERY_PREFIX + normalized);
  assert.deepEqual(query.calls[1].body.input, [QWEN_QUERY_PREFIX + normalized]);
});

test('wrong count, ordering, shape, dimensions and token usage are systemic failures', async () => {
  for (const mutate of [
    (b: any) => { b.data = []; }, (b: any) => { b.data[0].index = 1; },
    (b: any) => { b.data[0].embedding = Array(768).fill(1); },
    (b: any) => { b.data[0].embedding = Array(QWEN_CHUNK_CONTRACT.nativeDimensions).fill(0); },
    (b: any) => { b.usage.prompt_tokens++; }, (b: any) => { delete b.usage; },
  ]) {
    await assert.rejects(fixture(mutate).client.embed(['x'], 'document'),
      (err: unknown) => err instanceof LocalEmbeddingError && err.classification === 'systemic');
  }
});

test('runtime drift and insecure transport are rejected at construction', () => {
  const opts = { baseUrl: 'http://localhost:1234', bearerToken: 'fixture', runtime, beforeInference: async () => {} };
  for (const change of [{ contractId: 'wrong' }, { artifactSha256: 'wrong' }, { runtimeContract: 'ollama/unknown' },
    { acceptanceReceiptSha256: '' }]) assert.throws(() => new LocalEmbeddingClient({ ...opts, runtime: { ...runtime, ...change } }), /runtime_identity/);
  for (const baseUrl of ['http://10.23.45.67:11434', 'https://user:password@example.com', 'https://example.com/?secret=1']) {
    assert.throws(() => new LocalEmbeddingClient({ ...opts, baseUrl }));
  }
  assert.throws(()=>new LocalEmbeddingClient({...opts,baseUrl:'https://runtime.internal'}),/tls_identity/);
  assert.throws(()=>new LocalEmbeddingClient({...opts,runtime:{...runtime,tls:{caPath:'/x',caSha256:'b'.repeat(64),spkiSha256:'c'.repeat(64)}}}),/tls_unexpected/);
});

test('provider errors are classified, Retry-After bounded and secret response bodies omitted', async () => {
  for (const [status, classification] of [[400, 'input'], [401, 'systemic'], [429, 'retryable'], [502, 'systemic'], [503, 'retryable']] as const) {
    const f = new LocalEmbeddingClient({ baseUrl: 'http://localhost:1234', bearerToken: 'fixture', runtime,
      beforeInference: async () => {}, fetch: (async () => new Response('private corpus and token', { status,
        headers: { 'Retry-After': '600' } })) as typeof fetch });
    await assert.rejects(f.embed(['x'], 'document'), (err: unknown) => err instanceof LocalEmbeddingError
      && err.classification === classification && !err.message.includes('private') && err.retryAfterMs === 300_000);
  }
});

test('only exact 429 busy has the no-attempt-charge gateway code',async()=>{
  for(const [body,code] of [[{error:'busy'},'embedding.gateway_busy'],[{error:'busy',extra:true},'embedding.http_429'],[{error:'other'},'embedding.http_429']] as const){
    const client=new LocalEmbeddingClient({baseUrl:'http://localhost:1234',bearerToken:'fixture',runtime,beforeInference:async()=>{},
      fetch:(async()=>Response.json(body,{status:429})) as typeof fetch});
    await assert.rejects(client.countFormattedTokens('x'),error=>error instanceof LocalEmbeddingError&&error.code===code);
  }
});

test('failed guard prevents any inference request', async () => {
  let calls = 0;
  const client = new LocalEmbeddingClient({ baseUrl: 'http://localhost:1234', bearerToken: 'fixture', runtime,
    beforeInference: async () => { throw new Error('thermal guard'); },
    fetch: (async () => { calls++; return Response.json({ tokens: [1, 2] }); }) as typeof fetch });
  await assert.rejects(client.embed(['x'], 'document'), /thermal guard/);
  assert.equal(calls, 1);
});
