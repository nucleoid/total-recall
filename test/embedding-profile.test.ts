import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  CANONICAL_EMBEDDING_DESCRIPTOR,
  validateEmbeddingProfile,
} from '../src/embedding.js';

test('canonical embedding profile requires explicit Gemini gemini-embedding-2-preview 768d configuration', () => {
  const valid = {
    EMBEDDING_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'configured-key',
    EMBEDDING_MODEL: 'gemini-embedding-2-preview',
    EMBEDDING_DIMENSIONS: '768',
  };

  assert.deepEqual(validateEmbeddingProfile(valid), {
    ...CANONICAL_EMBEDDING_DESCRIPTOR,
    apiKey: 'configured-key',
  });
  assert.ok(Object.isFrozen(CANONICAL_EMBEDDING_DESCRIPTOR));

  for (const invalid of [
    { ...valid, EMBEDDING_PROVIDER: undefined },
    { ...valid, GEMINI_API_KEY: undefined },
    { ...valid, EMBEDDING_MODEL: 'text-embedding-004' },
    { ...valid, EMBEDDING_DIMENSIONS: '1536' },
    { ...valid, EMBEDDING_PROVIDER: 'ollama' },
  ]) {
    assert.throws(() => validateEmbeddingProfile(invalid), /gemini|GEMINI_API_KEY|gemini-embedding-2-preview|768/i);
  }
});

test('empty embedding batches do not call the provider', async () => {
  const module = await import('../src/embedding.js');
  assert.deepEqual(await module.embedBatch([]), []);
});

test('missing Gemini configuration fails closed without an implicit Ollama request', () => {
  const embeddingModule = new URL('../src/embedding.ts', import.meta.url).href;
  const script = `
    globalThis.fetch = async () => { throw new Error('provider must not be called'); };
    await import(${JSON.stringify(embeddingModule)});
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    env: {
      ...process.env,
      EMBEDDING_PROVIDER: '',
      EMBEDDING_MODEL: '',
      EMBEDDING_DIMENSIONS: '',
      GEMINI_API_KEY: '',
      OLLAMA_URL: 'http://embedding.invalid',
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EMBEDDING_PROVIDER=gemini/);
  assert.doesNotMatch(result.stderr, /provider must not be called|Ollama embed/);
});
