import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production re-embedding is enabled only with identity storage and mixed-aware readers', async () => {
  const reembed = await readFile(new URL('../scripts/reembed-all.ts', import.meta.url), 'utf8');
  const search = await readFile(new URL('../src/search.ts', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../migrations/023_embedding_identity.sql', import.meta.url), 'utf8');

  assert.doesNotMatch(reembed, /requireMixedEmbeddingMigrationSupport\(\)/);
  assert.match(reembed, /embedding_provider/);
  assert.match(search, /NULL::double precision AS vec_score/);
  assert.match(migration, /embedding_identity_all_or_none/);
});
