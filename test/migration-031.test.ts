import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL('../migrations/031_memory_reflection.sql', import.meta.url), 'utf8');

test('reflection migration is origin-aware, restrictive, and provenance preserving', () => {
  assert.match(sql, /legacy insights rows require reviewed origin_namespace classification/);
  assert.match(sql, /origin_namespace TEXT/);
  assert.match(sql, /'insight'/);
  assert.match(sql, /memory_reflection_runs/);
  assert.match(sql, /UNIQUE \(origin_namespace, window_start, window_end, config_hash, generation\)/);
  assert.match(sql, /memory_insight_evidence/);
  assert.match(sql, /evidence_id UUID NOT NULL REFERENCES public\.memories\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /origin_namespace = ANY\(public\.app_allowed_namespaces\(\)\)/);
  assert.match(sql, /app_current_key_has_permission\('reflection'\)/);
  assert.match(sql, /NOT public\.app_current_key_has_permission\('write'\)/);
  assert.doesNotMatch(sql, /GRANT\s+DELETE/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/i);
  assert.doesNotMatch(sql, /https?:\/\//i);
});
