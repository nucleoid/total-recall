import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const sql = readFileSync(new URL('../migrations/055_reflection_evidence_row_lock.sql', import.meta.url), 'utf8');
test('reflection evidence row-lock policy is scoped and mutation-denying', () => {
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /app_current_key_has_permission\('reflection'\)/);
  assert.match(sql, /namespace = ANY\(public\.app_allowed_namespaces\(\)\)/);
  assert.match(sql, /key\.max_access_level/);
  assert.match(sql, /WITH CHECK \(false\)/);
  assert.doesNotMatch(sql, /GRANT/);
});
