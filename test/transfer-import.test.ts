import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setPoolForTesting } from '../src/db.js';
import { importMemoryBatch } from '../src/transfer/import.js';
import { parseTransferManifest, parseTransferMemory } from '../src/transfer/format.js';
import type { AuthContext } from '../src/types.js';

const AUTH: AuthContext = {
  keyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'transfer',
  namespaces: ['shared'], permissions: ['import'], maxAccessLevel: 'normal',
};
const MANIFEST = parseTransferManifest({
  type: 'manifest', format: { major: 1, minor: 0 },
  source_instance_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  exported_at: '2026-01-01T00:00:00Z',
});
const RECORD = parseTransferMemory({
  type: 'memory', source_key: 'remote:key', content: 'portable', source: 'manual',
  namespace: 'shared', tags: [], metadata: {}, access_level: 'normal',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  event_at: null, memory_kind: 'semantic', valid_from: '2026-01-01T00:00:00Z',
  valid_to: null, expires_at: null,
});

type Existing = Record<string, unknown>;
class FakePool {
  readonly statements: Array<{ text: string; values: unknown[] }> = [];
  inserted: { text: string; values: unknown[] } | undefined;
  constructor(readonly existing: Existing[] = [], readonly hidden = false) {}
  async connect() {
    const pool = this;
    return {
      async query(text: string, values: unknown[] = []) {
        const normalized = text.replace(/\s+/g, ' ').trim();
        pool.statements.push({ text: normalized, values });
        if (normalized.includes('app_transfer_has_hidden_identity')) return { rows: [{ hidden: pool.hidden }] };
        if (normalized.includes('AS transfer_identity')) return { rows: pool.existing };
        if (normalized.startsWith('INSERT INTO memories')) {
          pool.inserted = { text: normalized, values };
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
  }
}

afterEach(() => setPoolForTesting(null));

test('new imported rows are destination-attributed and re-embedded without accepting source vectors', async () => {
  const pool = new FakePool();
  setPoolForTesting(pool as any);
  let calls = 0;
  const result = await importMemoryBatch(AUTH, MANIFEST, [RECORD], {
    embedder: async texts => {
      calls += 1;
      assert.deepEqual(texts, ['portable']);
      return [{ vector: Array(768).fill(0.25), provider: 'gemini', model: 'destination-model', dimensions: 768 }];
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.inserted, 1);
  assert.equal(result.committed, true);
  assert.ok(pool.inserted);
  assert.equal(pool.inserted.values[7], AUTH.keyId);
  assert.equal(pool.inserted.values[8], RECORD.source_key);
  assert.equal(pool.inserted.values[12], 'gemini');
  assert.equal(pool.inserted.values[13], 'destination-model');
  assert.match(String(pool.inserted.values[1]), /^\[0\.25,/);
  assert.doesNotMatch(pool.inserted.text, /document_id|agent_id/);
});

test('equal replay skips without embedding and divergent content conflicts without overwrite', async () => {
  const base: Existing = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', source_key: RECORD.source_key,
    transfer_identity: RECORD.source_key, content: RECORD.content, source: RECORD.source,
    namespace: RECORD.namespace, tags: RECORD.tags, metadata: RECORD.metadata,
    access_level: RECORD.access_level, created_at: RECORD.created_at, updated_at: RECORD.updated_at,
    event_at: null, memory_kind: RECORD.memory_kind, valid_from: RECORD.valid_from,
    valid_to: null, expires_at: null, deleted_at: null, superseded_at: null,
    consolidated_into_id: null,
  };
  const pool = new FakePool([base]);
  setPoolForTesting(pool as any);
  const embedder = async () => { throw new Error('must not embed'); };
  const replay = await importMemoryBatch(AUTH, MANIFEST, [RECORD], { embedder });
  assert.equal(replay.skipped, 1);
  assert.equal(pool.inserted, undefined);

  const divergent = parseTransferMemory({ ...RECORD, content: 'divergent' });
  const conflict = await importMemoryBatch(AUTH, MANIFEST, [divergent], { embedder });
  assert.equal(conflict.conflicted, 1);
  assert.equal(pool.inserted, undefined);
});

test('hidden tenant identity and denied namespace fail before embedding', async () => {
  let embedded = false;
  const embedder = async () => { embedded = true; return []; };
  setPoolForTesting(new FakePool([], true) as any);
  await assert.rejects(importMemoryBatch(AUTH, MANIFEST, [RECORD], { embedder }), /Access denied/);
  assert.equal(embedded, false);

  setPoolForTesting(new FakePool() as any);
  await assert.rejects(importMemoryBatch(AUTH, MANIFEST, [parseTransferMemory({ ...RECORD, namespace: 'private' })], { embedder }), /Access denied/);
  assert.equal(embedded, false);
});
