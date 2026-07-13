import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

async function importEmbedding(env: NodeJS.ProcessEnv) {
  const original = { ...process.env };
  process.env = {
    ...original,
    EMBEDDING_PROVIDER: '',
    EMBEDDING_MODEL: '',
    EMBEDDING_DIMENSIONS: '',
    GEMINI_API_KEY: '',
    OLLAMA_URL: '',
    ...env,
  };
  try {
    return await import(`../src/embedding.ts?case=${Date.now()}-${Math.random()}`);
  } finally {
    process.env = original;
  }
}

test('config accepts only the explicit Gemini 768 production descriptor', async () => {
  const valid = {
    EMBEDDING_PROVIDER: 'gemini',
    EMBEDDING_MODEL: 'gemini-embedding-2-preview',
    EMBEDDING_DIMENSIONS: '768',
    GEMINI_API_KEY: 'test-key',
  };
  const mod = await importEmbedding(valid);
  assert.deepEqual(mod.ACTIVE_EMBEDDING_DESCRIPTOR, {
    provider: 'gemini',
    model: 'gemini-embedding-2-preview',
    dimensions: 768,
  });

  const badCases: Array<[string, NodeJS.ProcessEnv, RegExp]> = [
    ['missing provider', { ...valid, EMBEDDING_PROVIDER: '' }, /EMBEDDING_PROVIDER/],
    ['unknown provider', { ...valid, EMBEDDING_PROVIDER: 'ollama' }, /gemini/],
    ['wrong model', { ...valid, EMBEDDING_MODEL: 'text-embedding-004' }, /gemini-embedding-2-preview/],
    ['missing key', { ...valid, GEMINI_API_KEY: '' }, /GEMINI_API_KEY/],
    ['nan dimension', { ...valid, EMBEDDING_DIMENSIONS: 'NaN' }, /EMBEDDING_DIMENSIONS/],
    ['fractional dimension', { ...valid, EMBEDDING_DIMENSIONS: '768.5' }, /EMBEDDING_DIMENSIONS/],
    ['nonpositive dimension', { ...valid, EMBEDDING_DIMENSIONS: '0' }, /768/],
    ['wrong dimension', { ...valid, EMBEDDING_DIMENSIONS: '1536' }, /768/],
  ];
  for (const [name, env, pattern] of badCases) {
    await assert.rejects(() => importEmbedding(env), pattern, name);
  }
});

test('provider response validation rejects wrong count, length, and non-finite values', async () => {
  const mod = await importEmbedding({
    EMBEDDING_PROVIDER: 'gemini',
    EMBEDDING_MODEL: 'gemini-embedding-2-preview',
    EMBEDDING_DIMENSIONS: '768',
    GEMINI_API_KEY: 'test-key',
  });
  const valid = Array.from({ length: 768 }, (_, i) => i / 768);
  assert.equal(mod.validateEmbeddingVector(valid, 'scalar').length, 768);
  assert.throws(() => mod.validateEmbeddingVector(valid.slice(1), 'scalar'), /768/);
  assert.throws(() => mod.validateEmbeddingVector([...valid.slice(0, 767), Number.NaN], 'scalar'), /finite/);
  assert.throws(() => mod.validateEmbeddingVector([...valid.slice(0, 767), Number.POSITIVE_INFINITY], 'scalar'), /finite/);
  assert.throws(() => mod.validateEmbeddingBatch([valid], 2), /count/);
});

test('every memory vector writer stamps vector and canonical identity atomically', () => {
  const writerFiles = [
    'src/tools/store.ts',
    'src/tools/store-document.ts',
    'src/rollup.ts',
    'src/watcher/sync.ts',
    'scripts/lib/preseed-db.ts',
    'scripts/preseed-chatgpt.ts',
    'scripts/preseed-gemini.ts',
  ];
  for (const file of writerFiles) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /embedding_provider/u, `${file} writes provider`);
    assert.match(source, /embedding_model/u, `${file} writes model`);
    assert.match(source, /embedding_dimensions/u, `${file} writes dimensions`);
    assert.match(source, /ACTIVE_EMBEDDING_DESCRIPTOR|CANONICAL_EMBEDDING_DESCRIPTOR|embeddingDescriptorParams|prepareCanonicalEmbeddingBatch/u, `${file} uses canonical descriptor`);
  }
});

test('search scopes vectors to active identity and keeps incompatible rows text-only', () => {
  const source = readFileSync('src/search.ts', 'utf8');
  assert.match(source, /embedding_provider\s*=\s*\$/u);
  assert.match(source, /embedding_model\s*=\s*\$/u);
  assert.match(source, /embedding_dimensions\s*=\s*\$/u);
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM vector_results/u);
  assert.match(source, /NULL::double precision AS vec_score/u);
});

test('search degrades to text-only results when query embedding fails', () => {
  const source = readFileSync('src/search.ts', 'utf8');
  assert.match(source, /catch \(error\)/u);
  assert.match(source, /text-only search fallback/u);
  assert.match(source, /vectorAvailable/u);
});
