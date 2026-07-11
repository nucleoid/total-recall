import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../migrations/013_rls_context.sql', import.meta.url), 'utf8');

test('migration 013 installs a dual-format namespace parser for RLS policies', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION\s+app_allowed_namespaces\(\)/i);
  assert.match(migration, /jsonb_array_elements_text/i);
  assert.match(migration, /string_to_array/i);
  assert.match(migration, /current_setting\('app\.allowed_namespaces',\s*true\)/i);
  assert.match(migration, /DROP POLICY IF EXISTS namespace_read ON memories/i);
  assert.match(migration, /DROP POLICY IF EXISTS namespace_update ON documents/i);
  assert.match(migration, /namespace = ANY\(app_allowed_namespaces\(\)\)/i);
});
