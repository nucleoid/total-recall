import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyApprovedOrphans,
  previewWatcherOrphans,
  type OrphanApprovalManifest,
  type RepairClient,
} from '../scripts/repair-watcher-orphans.js';

type Result = { rows: any[]; rowCount?: number };

class FakeClient implements RepairClient {
  calls: Array<{ sql: string; values?: unknown[] }> = [];
  constructor(private readonly responses: Result[]) {}
  async query(sql: string, values?: unknown[]): Promise<Result> {
    this.calls.push({ sql, values });
    return this.responses.shift() ?? { rows: [], rowCount: 0 };
  }
}

const candidateRows = [{
  id: '11111111-1111-4111-8111-111111111111',
  namespace: 'projects',
  file_path: 'notes/gone.md',
  source_key: 'file-sync:notes/gone.md:(root)',
  updated_at: '2026-01-01T00:00:00.000Z',
  content_hash: 'watcher:v2:abc',
}];

const manifest = (): OrphanApprovalManifest => ({
  version: 1,
  backupVerified: true,
  workspaceVerified: true,
  workspaceRoot: '/workspace',
  approvals: [{
    filePath: 'notes/gone.md',
    memoryIds: ['11111111-1111-4111-8111-111111111111'],
    rowFingerprint: '0'.repeat(64),
    syncStateHash: 'watcher:v2:abc',
  }],
});

test('historical preview is bounded, content-free, and performs no writes', async () => {
  const client = new FakeClient([{ rows: candidateRows }]);
  const preview = await previewWatcherOrphans(client, '/workspace', {
    exists: async filePath => !filePath.replaceAll('\\', '/').endsWith('/notes/gone.md'),
    limit: 25,
  });

  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0].filePath, 'notes/gone.md');
  assert.deepEqual(preview.candidates[0].memoryIds, [candidateRows[0].id]);
  assert.equal('content' in preview.candidates[0], false);
  assert.match(preview.candidates[0].rowFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(client.calls.every(call => /^\s*SELECT/i.test(call.sql)));
  assert.deepEqual(client.calls[0].values, [26, 0]);
  assert.equal(preview.nextOffset, null);
});

test('preview reports malformed legacy paths without blocking valid candidates', async () => {
  const client = new FakeClient([{ rows: [
    { ...candidateRows[0], file_path: '/legacy/absolute.md' },
    candidateRows[0],
  ] }]);
  const preview = await previewWatcherOrphans(client, '/workspace', { exists: async () => false, limit: 25 });
  assert.equal(preview.candidates.length, 1);
  assert.deepEqual(preview.skipped, [{ filePath: '/legacy/absolute.md', reason: 'non-canonical-path' }]);
});

test('preview supports stable pagination beyond the safety cap', async () => {
  const rows = Array.from({ length: 3 }, (_, index) => ({
    ...candidateRows[0],
    id: `11111111-1111-4111-8111-11111111111${index}`,
    file_path: `notes/${index}.md`,
  }));
  const client = new FakeClient([{ rows }]);
  const preview = await previewWatcherOrphans(client, '/workspace', { exists: async () => false, limit: 2, offset: 10 });
  assert.equal(preview.candidates.length, 2);
  assert.equal(preview.truncated, true);
  assert.equal(preview.nextOffset, 12);
  assert.deepEqual(client.calls[0].values, [3, 10]);
});

test('apply refuses missing safety acknowledgements and path-only approvals before SQL', async () => {
  for (const patch of [
    { backupVerified: false },
    { workspaceVerified: false },
    { approvals: [{ ...manifest().approvals[0], memoryIds: [] }] },
  ]) {
    const client = new FakeClient([]);
    await assert.rejects(
      () => applyApprovedOrphans(client, { ...manifest(), ...patch }, { exists: async () => false }),
      /backup|workspace|memoryIds/i,
    );
    assert.equal(client.calls.length, 0);
  }
});

test('apply locks and rechecks exact approved rows, rejecting fingerprint drift atomically', async () => {
  const client = new FakeClient([
    { rows: [] }, // BEGIN
    { rows: candidateRows },
    { rows: [{ content_hash: 'watcher:v2:abc' }] },
    { rows: [] }, // rollback
  ]);
  await assert.rejects(
    () => applyApprovedOrphans(client, manifest(), { exists: async () => false }),
    /fingerprint drift/i,
  );
  assert.equal(client.calls[0].sql, 'BEGIN');
  assert.match(client.calls[1].sql, /FOR UPDATE/i);
  assert.equal(client.calls.at(-1)?.sql, 'ROLLBACK');
  assert.ok(client.calls.every(call => !/^DELETE/i.test(call.sql)));
});

test('approved apply deletes only exact IDs plus exact watcher-owned path and matching sync state', async () => {
  const approved = manifest();
  const previewClient = new FakeClient([{ rows: candidateRows }]);
  const preview = await previewWatcherOrphans(previewClient, '/workspace', { exists: async () => false, limit: 25 });
  approved.approvals[0].rowFingerprint = preview.candidates[0].rowFingerprint;

  const client = new FakeClient([
    { rows: [] },
    { rows: candidateRows },
    { rows: [{ content_hash: 'watcher:v2:abc' }] },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [] },
  ]);
  const result = await applyApprovedOrphans(client, approved, { exists: async () => false });

  assert.deepEqual(result, { pathsDeleted: 1, memoriesDeleted: 1 });
  const memoryDelete = client.calls.find(call => /^DELETE FROM memories/i.test(call.sql));
  assert.match(memoryDelete?.sql ?? '', /client_id\s*=\s*'file-sync'/i);
  assert.match(memoryDelete?.sql ?? '', /metadata->>'file'\s*=\s*\$1/i);
  assert.match(memoryDelete?.sql ?? '', /id\s*=\s*ANY\(\$2::uuid\[\]\)/i);
  assert.deepEqual(memoryDelete?.values, ['notes/gone.md', approved.approvals[0].memoryIds]);
  assert.ok(client.calls.some(call => /^DELETE FROM sync_state/i.test(call.sql)));
  assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
});

test('apply leaves present or uncertain candidates unchanged', async () => {
  const client = new FakeClient([]);
  await assert.rejects(
    () => applyApprovedOrphans(client, manifest(), { exists: async () => true }),
    /present|authoritative/i,
  );
  assert.equal(client.calls.length, 0);
});
