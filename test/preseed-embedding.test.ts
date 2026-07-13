import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  prepareCanonicalEmbeddingBatch,
  requireEmbeddingIdentityWriter,
} from '../scripts/lib/preseed-embedding.js';
import { CANONICAL_EMBEDDING_DESCRIPTOR } from '../src/embedding.js';

const scripts = ['chatgpt', 'claude', 'gemini', 'openclaw'];

test('all preseed scripts use the shared canonical embedder and identity writer', async () => {
  for (const name of scripts) {
    const source = await readFile(new URL(`../scripts/preseed-${name}.ts`, import.meta.url), 'utf8');
    assert.match(source, /from ['"]\.\.\/src\/embedding\.js['"]/);
    assert.match(source, /requireEmbeddingIdentityWriter\(\)/);
    assert.doesNotMatch(source, /\/api\/embed|nomic-embed-text|function getEmbedding|text\.slice\(0, 8000\)/);
    assert.match(source, /pathToFileURL/);
  }
  assert.doesNotThrow(() => requireEmbeddingIdentityWriter());
});

test('canonical preseed batches embed exact persisted content and validate all vectors before writes', async () => {
  const contents = ['exact persisted content', 'second full string'];
  const seen: string[][] = [];
  const batch = await prepareCanonicalEmbeddingBatch(contents, async texts => {
    seen.push(texts);
    return texts.map((_, index) => Array(768).fill(index + 0.25));
  });
  assert.deepEqual(seen, [contents]);
  assert.deepEqual(batch.descriptor, CANONICAL_EMBEDDING_DESCRIPTOR);
  assert.equal(batch.embeddings.length, 2);

  for (const invalid of [
    [[0]],
    [Array(768).fill(0)],
    [Array(768).fill(Number.NaN), Array(768).fill(0)],
  ]) {
    await assert.rejects(
      prepareCanonicalEmbeddingBatch(contents, async () => invalid),
      /count|finite|768/i,
    );
  }
  assert.deepEqual(await prepareCanonicalEmbeddingBatch([], async () => { throw new Error('called'); }), {
    descriptor: CANONICAL_EMBEDDING_DESCRIPTOR,
    embeddings: [],
  });
});
