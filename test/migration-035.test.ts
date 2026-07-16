import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('activity connector migration separates domains and enforces owner plus namespace RLS', async () => {
  const sql = await readFile('migrations/035_activity_connector_foundation.sql', 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.activity_events/);
  assert.match(sql, /UNIQUE \(client_id, connector, source_id, event_key\)/);
  assert.match(sql, /client_id = app_current_key_id\(\)::uuid AND namespace = ANY\(app_allowed_namespaces\(\)\)/);
  assert.match(sql, /ALTER TABLE public\.connector_credentials[\s\S]*source_id text NOT NULL DEFAULT 'default'/);
  assert.match(sql, /connector_sync_state_owner_source_uidx/);
  assert.match(sql, /media_events_source_event_key_uidx/);
  assert.doesNotMatch(sql, /DELETE FROM public\.media_events/);
  assert.doesNotMatch(sql, /DELETE FROM public\.connector_/);
});
