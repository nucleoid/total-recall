import assert from 'node:assert/strict';
import test from 'node:test';
import {
  embedBatchWithProfile,
  embedWithProfile,
  parseEmbeddingProfiles,
  type EmbeddingProfile,
} from '../src/embedding.js';

const namedEnvironment = {
  EMBEDDING_CURRENT_PROFILE: 'production',
  EMBEDDING_PROFILES_JSON: JSON.stringify({
    production: {
      provider: 'gemini', model: 'gemini-embedding-2-preview', dimensions: 768, apiKeyEnv: 'PRODUCTION_KEY',
    },
    legacy: {
      provider: 'ollama', model: 'nomic-embed-text', dimensions: 768, baseUrlEnv: 'LEGACY_URL',
    },
  }),
  PRODUCTION_KEY: 'secret',
  LEGACY_URL: 'http://127.0.0.1:11434',
};

test('named embedding profiles resolve explicit credential references and exact current target', () => {
  const config = parseEmbeddingProfiles(namedEnvironment);
  assert.equal(config.current.name, 'production');
  assert.deepEqual(config.profiles.map(profile => [profile.name, profile.provider, profile.model, profile.dimensions]), [
    ['production', 'gemini', 'gemini-embedding-2-preview', 768],
    ['legacy', 'ollama', 'nomic-embed-text', 768],
  ]);
  assert.equal(config.profiles[0].apiKey, 'secret');
  assert.equal(config.profiles[1].baseUrl, 'http://127.0.0.1:11434');
});

test('named embedding profiles fail closed for missing selection, partial, wrong-dimension, and wrong-current configuration', () => {
  assert.throws(() => parseEmbeddingProfiles({
    EMBEDDING_PROVIDER: 'gemini', EMBEDDING_MODEL: 'gemini-embedding-2-preview', EMBEDDING_DIMENSIONS: '768', GEMINI_API_KEY: 'key',
  }), /EMBEDDING_CURRENT_PROFILE/);
  assert.throws(() => parseEmbeddingProfiles({ EMBEDDING_CURRENT_PROFILE: 'production' }), /configured together/);
  assert.throws(() => parseEmbeddingProfiles({ ...namedEnvironment, PRODUCTION_KEY: '' }), /PRODUCTION_KEY/);
  assert.throws(() => parseEmbeddingProfiles({
    ...namedEnvironment,
    EMBEDDING_PROFILES_JSON: JSON.stringify({ production: {
      provider: 'gemini', model: 'gemini-embedding-2-preview', dimensions: 1536, apiKeyEnv: 'PRODUCTION_KEY',
    } }),
  }), /768/);
  assert.throws(() => parseEmbeddingProfiles({
    ...namedEnvironment,
    EMBEDDING_PROFILES_JSON: JSON.stringify({ production: {
      provider: 'ollama', model: 'nomic-embed-text', dimensions: 768, baseUrlEnv: 'LEGACY_URL',
    } }),
  }), /Current embedding profile/);
});

test('profile embedding returns vector and complete descriptor and validates batch cardinality', async () => {
  const originalFetch = globalThis.fetch;
  const profile: EmbeddingProfile = {
    name: 'legacy', provider: 'ollama', model: 'nomic-embed-text', dimensions: 768, baseUrl: 'http://embed.invalid',
  };
  try {
    globalThis.fetch = async (_input, init) => {
      const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
      return new Response(JSON.stringify({ embeddings: input.map(() => Array(768).fill(0.25)) }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    assert.deepEqual(await embedWithProfile('one', profile), {
      vector: Array(768).fill(0.25), provider: 'ollama', model: 'nomic-embed-text', dimensions: 768,
    });
    assert.equal((await embedBatchWithProfile(['one', 'two'], profile)).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
