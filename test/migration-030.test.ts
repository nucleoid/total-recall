import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('session migration enforces tenant/scope lineage, durable queueing, and provider isolation', () => {
  const sql = readFileSync(new URL('../migrations/030_session_distillation.sql', import.meta.url), 'utf8');
  assert.match(sql, /document_kind TEXT NOT NULL DEFAULT 'document'/);
  assert.match(sql, /session_request_hash ~ '\^sha256:session-v1:/);
  assert.match(sql, /ON public\.documents \(client_id, namespace, session_id\)/);
  assert.match(sql, /'episode_chunk'/);
  assert.match(sql, /memory_session_distillation_runs/);
  assert.match(sql, /memory_session_derivations/);
  assert.match(sql, /FOREIGN KEY \(owner_key_id, namespace, access_level, episode_id, run_id\)/);
  assert.match(sql, /FOREIGN KEY \(namespace, access_level, memory_id\)/);
  assert.match(sql, /owner_client_id = owner_key_id::text/);
  assert.match(sql, /app_current_key_is_admin\(\)/);
  assert.match(sql, /WHEN \(NEW\.memory_kind <> 'episode_chunk'\)/g);
  assert.match(sql, /DISABLE TRIGGER memories_subscription_enqueue/);
  assert.doesNotMatch(sql, /https?:\/\//i);
  assert.doesNotMatch(sql, /GRANT\s+DELETE/i);
  assert.doesNotMatch(sql, /ADD COLUMN\s+transcript\s+TEXT/i);
});
