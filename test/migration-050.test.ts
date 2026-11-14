import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('050 adds update generations without rewriting history or exposing private jobs', async () => {
  const sql = await readFile(new URL('../migrations/050_memory_ingestion_update_kind.sql', import.meta.url), 'utf8');
  assert.match(sql, /kind TEXT NOT NULL DEFAULT 'store' CHECK \(kind IN \('store','update','document'\)\)/);
  assert.match(sql, /source_revision INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /j\.kind <> 'store'/);
  assert.match(sql, /creation_pending = false/);
  assert.match(sql, /lease_token = EXCLUDED.lease_token/);
  assert.match(sql, /namespace = ANY\(public.app_allowed_namespaces\(\)\)/);
  assert.match(sql, /'write' = ANY\(k.permissions\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public.app_enqueue_memory_reembed/);
  assert.doesNotMatch(sql, /CREATE POLICY|DISABLE TRIGGER|ENABLE TRIGGER/);
});
