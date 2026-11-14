import test from 'node:test';
import assert from 'node:assert/strict';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID, QWEN_QUERY_PREFIX } from '../src/local-embedding-contract.js';
import { LocalEmbeddingClient } from '../src/local-embedding-client.js';
import { setLocalServingClientForTesting } from '../src/local-embedding-runtime.js';
import { resolveActiveEmbeddingDescriptor } from '../src/embedding-descriptor.js';
import { embedWithProfile, resolveEmbeddingProfiles, setEmbeddingServingVerifierForTesting } from '../src/embedding.js';

const localEnv = { SHADOW_EMBEDDING_CURRENT_CONTRACT: QWEN_CONTRACT_ID };

test('active local writer bootstraps without Gemini credentials and has pinned physical identity', () => {
  assert.deepEqual(resolveActiveEmbeddingDescriptor(localEnv), { provider: 'llama.cpp', model: QWEN_CONTRACT_ID, dimensions: 768 });
  assert.deepEqual(resolveEmbeddingProfiles(localEnv).current, {
    name: 'current', provider: 'llama.cpp', model: QWEN_CONTRACT_ID, dimensions: 768,
  });
  assert.deepEqual(resolveActiveEmbeddingDescriptor({ ...localEnv, SHADOW_EMBEDDING_ROLLBACK_WRITES: 'true' }), {
    provider: 'gemini', model: 'gemini-embedding-2-preview', dimensions: 768,
  });
});

test('named local profile accepts only exact Qwen identity and no profile endpoint fields', () => {
  const exact = { current: { provider: 'llama.cpp', model: QWEN_CONTRACT_ID, dimensions: 768 } };
  assert.equal(resolveEmbeddingProfiles({ ...localEnv, EMBEDDING_CURRENT_PROFILE: 'current', EMBEDDING_PROFILES_JSON: JSON.stringify(exact) }).current.model, QWEN_CONTRACT_ID);
  for (const profile of [
    { ...exact.current, model: 'qwen:latest' },
    { ...exact.current, dimensions: 1024 },
    { ...exact.current, baseUrlEnv: 'LOCAL_URL' },
    { ...exact.current, extra: true },
  ]) assert.throws(() => resolveEmbeddingProfiles({ ...localEnv, EMBEDDING_CURRENT_PROFILE: 'current',
    EMBEDDING_PROFILES_JSON: JSON.stringify({ current: profile }), LOCAL_URL: 'http://localhost:1' }), /pinned|768|unsupported/);
});

test('local document compatibility returns first lossless chunk while queries receive exact prefix and never call Gemini', async () => {
  const original = { ...process.env };
  process.env.NODE_ENV = 'test'; process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = QWEN_CONTRACT_ID;
  delete process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
  const requests: Array<{ url: string; body: any }> = [];
  const client = new LocalEmbeddingClient({ baseUrl: 'http://localhost:1234', bearerToken: 'synthetic',
    runtime: { contractId: QWEN_CONTRACT_ID, artifactSha256: QWEN_CHUNK_CONTRACT.artifactSha256,
      runtimeContract: QWEN_CHUNK_CONTRACT.runtimeContract, acceptanceReceiptSha256: 'd'.repeat(64) },
    beforeInference: async () => {}, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); requests.push({ url: String(url), body });
      if (String(url).endsWith('/tokenize')) return Response.json({ tokens: Array(Math.max(1, Math.ceil(body.content.length / 2))).fill(1) });
      return Response.json({ data: body.input.map((_: string, index: number) => ({ index,
        embedding: Array.from({ length: QWEN_CHUNK_CONTRACT.nativeDimensions }, (_v, i) => i === index ? 2 : 1) })),
        usage: { prompt_tokens: body.input.reduce((sum: number, input: string) => sum + Math.max(1, Math.ceil(input.length / 2)), 0) } });
    }) as typeof fetch });
  setLocalServingClientForTesting(client); setEmbeddingServingVerifierForTesting(async () => {});
  try {
    const profile = resolveEmbeddingProfiles(process.env).current;
    const source = `${'a'.repeat(400)}\n\n${'b'.repeat(400)}`;
    const document = await embedWithProfile(source, profile, undefined, 'document');
    assert.equal(document.vector.length, 768);
    const embedRequests = requests.filter(request => request.url.endsWith('/v1/embeddings'));
    assert.ok(embedRequests.flatMap(request => request.body.input).length > 1, 'all planned chunks were embedded');
    assert.equal(embedRequests[0].body.input[0].startsWith('a'), true, 'document chunk remains raw source');
    requests.length = 0;
    await embedWithProfile('needle', profile, undefined, 'query');
    const query = requests.find(request => request.url.endsWith('/v1/embeddings'))!;
    assert.equal(query.body.input[0], QWEN_QUERY_PREFIX + 'needle');
    assert.ok(requests.every(request => request.url.startsWith('http://localhost:1234/')));
  } finally {
    setLocalServingClientForTesting(undefined); setEmbeddingServingVerifierForTesting(undefined); process.env = original;
  }
});
