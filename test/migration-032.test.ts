import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL('../migrations/032_memory_ttl.sql', import.meta.url), 'utf8');

test('memory TTL migration is additive, indexed, and purge-safe', () => {
  assert.match(sql, /ADD COLUMN expires_at TIMESTAMPTZ/);
  assert.match(sql, /CREATE INDEX memories_expires_at_idx[\s\S]*WHERE expires_at IS NOT NULL/);
  assert.match(sql, /memory_consolidation_memberships[\s\S]*ON DELETE CASCADE/);
  assert.match(sql, /memory_session_derivations[\s\S]*ON DELETE CASCADE/);
  assert.match(sql, /memory_insight_evidence[\s\S]*ON DELETE CASCADE/);
  assert.doesNotMatch(sql, /ALTER TABLE public\.documents[\s\S]*expires_at/);
});
