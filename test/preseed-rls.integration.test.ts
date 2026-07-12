import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertSafeImportRole,
  commitImportBatch,
  type ImportMemoryRow,
} from '../scripts/lib/preseed-db.js';

const row = (namespace: string, sourceKey = namespace): ImportMemoryRow => ({
  content: `content-${namespace}`,
  source: 'test-source',
  namespace,
  tags: ['tag'],
  metadata: '{}',
  sourceKey,
  createdAt: '2024-01-01T00:00:00.000Z',
});

test('startup role check rejects table owner, superuser, and BYPASSRLS identities', async () => {
  for (const unsafe of [
    { current_user: 'owner', rolsuper: false, rolbypassrls: false, owns_memories: true },
    { current_user: 'root', rolsuper: true, rolbypassrls: false, owns_memories: false },
    { current_user: 'bypass', rolsuper: false, rolbypassrls: true, owns_memories: false },
  ]) {
    await assert.rejects(
      assertSafeImportRole({ async query() { return { rows: [unsafe], rowCount: 1 }; } }),
      new RegExp(`${unsafe.current_user}.*(owner|superuser|BYPASSRLS)`, 'i'),
    );
  }
  await assert.doesNotReject(assertSafeImportRole({ async query() {
    return { rows: [{ current_user: 'total_recall_app', rolsuper: false, rolbypassrls: false, owns_memories: false }], rowCount: 1 };
  } }));
});

test('batch embeds before BEGIN, sets exact transaction-local namespaces, writes, and commits', async () => {
  const events: string[] = [];
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const count = await commitImportBatch(
    [row('projects'), row('personal'), row('projects', 'other')],
    async texts => {
      events.push(`embed:${texts.join('|')}`);
      return texts.map(() => Array(768).fill(0.5));
    },
    {
      async query(text: string, values?: unknown[]) {
        events.push(text.startsWith('INSERT') ? 'INSERT' : text);
        calls.push({ text, values });
        return {};
      },
    },
    'preseed',
  );
  assert.equal(count, 3);
  assert.deepEqual(events, [
    'embed:content-projects|content-personal|content-projects',
    'BEGIN',
    "SELECT set_config('app.allowed_namespaces', $1, true)",
    'INSERT',
    'COMMIT',
  ]);
  assert.equal(calls[1].values?.[0], JSON.stringify(['personal', 'projects']));
  assert.match(calls[2].text, /client_id[\s\S]*ON CONFLICT/);
  assert.ok(calls[2].values?.includes('preseed'));
});

test('batch validates provider output before SQL, rolls back DB failures, and never uses a session GUC', async () => {
  let calls = 0;
  await assert.rejects(commitImportBatch([row('work')], async () => [], {
    async query() { calls++; return {}; },
  }, 'preseed-claude'), /count mismatch/i);
  assert.equal(calls, 0);

  const events: string[] = [];
  await assert.rejects(commitImportBatch([row('work')], async () => [Array(768).fill(0)], {
    async query(text: string) {
      const event = text.startsWith('INSERT') ? 'INSERT' : text;
      events.push(event);
      if (event === 'INSERT') throw new Error('RLS denied');
      return {};
    },
  }, 'preseed-claude'), /RLS denied/);
  assert.deepEqual(events, ['BEGIN', "SELECT set_config('app.allowed_namespaces', $1, true)", 'INSERT', 'ROLLBACK']);

  const claude = await readFile(new URL('../scripts/preseed-claude.ts', import.meta.url), 'utf8');
  const openclaw = await readFile(new URL('../scripts/preseed-openclaw.ts', import.meta.url), 'utf8');
  for (const source of [claude, openclaw]) {
    assert.doesNotMatch(source, /postgresql:\/\/total_recall:total_recall_dev/);
    assert.doesNotMatch(source, /SET\s+app\.allowed_namespaces/i);
  }
});
