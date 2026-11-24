import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL('../migrations/059_webhook_worker_least_privilege.sql', import.meta.url), 'utf8');

test('webhook worker migration exposes only fixed-shape definer APIs and restrictive raw-table denials', () => {
  assert.match(sql, /key\.permissions = ARRAY\['webhook_worker'\]::text\[\]/);
  assert.match(sql, /key\.revoked_at IS NULL/);
  assert.match(sql, /key\.expires_at IS NULL OR key\.expires_at > statement_timestamp\(\)/);
  assert.match(sql, /p_namespace = ANY\(key\.namespaces\)/);
  for (const table of ['memories', 'documents', 'memory_subscriptions', 'subscription_namespaces', 'webhook_deliveries']) {
    assert.match(sql, new RegExp(`webhook_worker_raw_deny ON public\\.${table} AS RESTRICTIVE FOR ALL`));
  }
  for (const fn of ['claim_delivery', 'load_delivery', 'recheck_delivery', 'cancel_unauthorized', 'mark_delivered', 'mark_retry', 'mark_dead']) {
    assert.match(sql, new RegExp(`webhook_worker_${fn}[\\s\\S]*SECURITY DEFINER`));
  }
  assert.match(sql, /owner_key\.revoked_at IS NULL/);
  assert.match(sql, /owner_key\.expires_at IS NULL OR owner_key\.expires_at > statement_timestamp\(\)/);
  assert.doesNotMatch(sql, /DROP POLICY IF EXISTS entity_/);
  assert.doesNotMatch(sql, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)\s+ON/i);
});
