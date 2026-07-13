import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('operator docs describe canonical profile and fail-closed mixed-vector rollout', async () => {
  const [readme, spec, env] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../SPEC.md', import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
  ]);
  for (const text of [readme, spec, env]) {
    assert.match(text, /EMBEDDING_PROVIDER=gemini/);
    assert.match(text, /gemini-embedding-2-preview/);
    assert.match(text, /768/);
  }
  assert.match(readme, /023_embedding_identity\.sql[\s\S]*identity-aware readers/i);
  assert.match(readme, /unknown[^.]*text-only|text-only[^.]*unknown/i);
  assert.match(readme, /unknown_count[^.]*legacy_count/i);
  assert.match(readme, /disable[^.]*legacy/i);
  assert.match(readme, /no implicit fallback|never falls back/i);
  assert.doesNotMatch(env, /Ollama fallback/);
  assert.match(env, /mandatory|required canonical profile/i);
  assert.match(spec, /no provider is inferred|no credential-driven fallback/i);
});
