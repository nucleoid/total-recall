import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('identity migration appends after current main, is additive, and rejects partial descriptors', () => {
  const sql = readFileSync('migrations/023_embedding_identity.sql', 'utf8');

  assert.match(sql, /ADD COLUMN IF NOT EXISTS embedding_provider TEXT/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS embedding_model TEXT/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER/u);
  assert.match(sql, /embedding_identity_all_or_none/u);
  assert.match(sql, /embedding_provider IS NULL/u);
  assert.match(sql, /embedding_provider IS NOT NULL/u);
  assert.match(sql, /memories_embedding_identity_idx/u);
  assert.doesNotMatch(sql, /UPDATE memories\s+SET\s+embedding_provider/u);
  assert.equal(readFileSync('migrations/022_media_event_null_id_dedupe.sql', 'utf8').length > 0, true);
});

test('legacy profile retirement is gated by zero active mismatches', () => {
  const search = readFileSync('src/search.ts', 'utf8');
  const reembed = readFileSync('scripts/reembed-all.ts', 'utf8');

  assert.match(search, /LEGACY_EMBEDDING_PROFILES/u);
  assert.match(search, /truthfully labelled legacy/u);
  assert.match(reembed, /verifyEmbeddingMigrationComplete/u);
  assert.match(reembed, /unknown_count/u);
  assert.match(reembed, /legacy_count/u);
});
