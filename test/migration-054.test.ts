import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL('../migrations/054_all_access_synthesis_scope.sql', import.meta.url), 'utf8');

test('all-access synthesis migration preserves explicit key and sensitivity gates', () => {
  assert.match(sql, /CHECK \(access_level IN \('normal', 'sensitive', 'secret'\)\)/);
  assert.match(sql, /app_current_key_has_permission\('reflection'\)/);
  assert.match(sql, /NOT public\.app_current_key_has_permission\('write'\)/);
  assert.match(sql, /origin_namespace = ANY\(public\.app_allowed_namespaces\(\)\)/);
  assert.match(sql, /key\.max_access_level/);
  assert.match(sql, /client_id = public\.app_current_key_id\(\)/);
  assert.doesNotMatch(sql, /GRANT\s+.*(?:admin|delete)/i);
  assert.doesNotMatch(sql, /UPDATE\s+public\.memories/i);
});
