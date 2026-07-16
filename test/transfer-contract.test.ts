import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function text(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

test('migration 034 persists instance identity and replaces global source-key uniqueness', async () => {
  const sql = await text('migrations/034_memory_transfer.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.instance_settings/);
  assert.match(sql, /instance_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid\(\)/);
  assert.match(sql, /CREATE UNIQUE INDEX memories_client_source_key_uidx[\s\S]*\(client_id, source_key\)[\s\S]*WHERE source_key IS NOT NULL/);
  assert.match(sql, /app_transfer_has_hidden_identity/);
});

test('all runtime and bundled import writers infer the tenant-local partial unique index', async () => {
  const writers = [
    'src/tools/store.ts', 'src/watcher/sync.ts', 'src/consolidation.ts',
    'src/session-distillation.ts', 'scripts/lib/preseed-db.ts',
    'scripts/preseed-chatgpt.ts', 'scripts/preseed-gemini.ts',
  ];
  for (const writer of writers) {
    const source = await text(writer);
    assert.doesNotMatch(source, /ON CONFLICT \(source_key\)/, writer);
    assert.match(source, /ON CONFLICT \(client_id, source_key\) WHERE source_key IS NOT NULL/, writer);
  }
});

test('transfer documentation does not present V1 as a faithful backup or sync protocol', async () => {
  const readme = await text('README.md');
  assert.match(readme, /not a faithful backup or bidirectional sync protocol/);
  assert.match(readme, /Every inserted memory is re-embedded/);
  assert.match(readme, /divergent payloads are reported as conflicts and are never overwritten/);
});
