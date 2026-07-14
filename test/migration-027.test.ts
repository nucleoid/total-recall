import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('consolidation migration is additive, restrictive, deferred, and namespace/key scoped', () => {
  const sql = readFileSync(new URL('../migrations/027_memory_consolidation.sql', import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS consolidated_into_id UUID/);
  assert.match(sql, /REFERENCES public\.memories\(id\)\s+ON DELETE RESTRICT/);
  assert.match(sql, /memory_consolidation_memberships/);
  assert.match(sql, /WHERE deconsolidated_at IS NULL/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /owner_key_id = (?:public\.)?app_current_key_id\(\)::uuid/);
  assert.match(sql, /consolidation_memberships_read[\s\S]*namespace = ANY\((?:public\.)?app_allowed_namespaces\(\)\)/);
  assert.doesNotMatch(sql, /GRANT\s+DELETE/i);
  assert.doesNotMatch(sql, /UPDATE public\.memories\s+SET/i);
  assert.doesNotMatch(sql, /DELETE FROM public\.memories/i);
});
