import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL('../migrations/062_contradiction_shadow_auditor.sql', import.meta.url), 'utf8');

test('auditor authority is separate, exact-level, and does not restrict the manual resolver', () => {
  assert.match(sql, /app_contradiction_audit_scope_allowed[\s\S]*key\.max_access_level = p_access_level/);
  assert.match(sql, /ARRAY\['contradiction_audit', 'read'\]/);
  assert.match(sql, /access_level IN \('normal', 'sensitive', 'secret'\)/);
  assert.match(sql, /contradiction_audit_raw_deny[\s\S]*app_current_key_has_permission\('contradiction_audit'\)/);
  assert.doesNotMatch(sql, /contradiction_audit_raw_deny[\s\S]*app_current_key_has_permission\('contradiction_resolve'\)/);
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION public\.app_contradiction_resolve_scope_allowed/);
});
