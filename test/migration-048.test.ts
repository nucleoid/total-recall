import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
test('048 installs a content-free fenced queue, namespace RLS, cascades and disabled ready trigger', async () => {
  const sql = await readFile(new URL('../migrations/048_memory_ingestion_queue.sql',import.meta.url),'utf8');
  const table = sql.slice(0,sql.indexOf('CREATE INDEX'));
  assert.match(table,/memory_id UUID PRIMARY KEY/);
  assert.match(table,/lease_token UUID/);
  assert.doesNotMatch(table,/\bcontent\s+TEXT|\bembedding\s+VECTOR/i);
  assert.match(sql,/FOREIGN KEY \(namespace, memory_id\)[\s\S]*ON UPDATE CASCADE ON DELETE CASCADE/);
  assert.match(sql,/ENABLE ROW LEVEL SECURITY/);
  assert.match(sql,/CREATE POLICY ingestion_insert[\s\S]*client_id = app_current_key_id\(\) OR app_current_key_is_admin\(\)/);
  assert.match(sql,/NEW.memory_kind <> 'episode_chunk'/);
  assert.match(sql,/DISABLE TRIGGER memories_subscription_ready_enqueue/);
  assert.match(sql,/GRANT SELECT, INSERT, UPDATE ON public.memory_ingestion_jobs/);
  assert.doesNotMatch(sql,/GRANT[^;]*DELETE[^;]*memory_ingestion_jobs/);
});
