import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyGeminiKeyRepair,
  buildGeminiRepairPreview,
  repairRowFingerprint,
  type ApprovalManifest,
  type RepairRow,
  type RepairQueryClient,
} from '../scripts/repair-gemini-source-keys.js';

const row = (id: string, sourceKey: string, overrides: Partial<RepairRow> = {}): RepairRow => ({
  id,
  source_key: sourceKey,
  content: 'Q: prompt\n\nA: response long enough to represent persisted data',
  created_at: '2024-01-01T00:00:00.000Z',
  source: 'gemini-conversation',
  client_id: 'preseed-gemini',
  namespace: 'personal',
  tags: [],
  metadata: {},
  updated_at: '2024-01-02T00:00:00.000Z',
  ...overrides,
});

class MemoryClient implements RepairQueryClient {
  calls: Array<{ sql: string; values?: unknown[] }> = [];
  constructor(public rows: RepairRow[]) {}
  async query(sql: string, values?: unknown[]): Promise<{ rows: RepairRow[]; rowCount: number }> {
    this.calls.push({ sql, values });
    if (/^SELECT pg_advisory/.test(sql) || /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT[\s\S]+FROM memories/.test(sql)) return { rows: this.rows.map(x => ({ ...x })), rowCount: this.rows.length };
    if (/^UPDATE memories/.test(sql)) {
      const conflicting = this.rows.find(x => x.id !== values?.[1] && x.source_key === values?.[0]);
      if (conflicting) throw new Error('duplicate key value violates unique constraint');
      const target = this.rows.find(x => x.id === values?.[1]);
      if (target) target.source_key = String(values?.[0]);
      return { rows: [], rowCount: target ? 1 : 0 };
    }
    if (/^DELETE FROM memories/.test(sql)) {
      const index = this.rows.findIndex(x => x.id === values?.[0]);
      if (index >= 0) this.rows.splice(index, 1);
      return { rows: [], rowCount: index >= 0 ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }
}

const manifestFor = (rows: RepairRow[], backupVerified = true): ApprovalManifest => {
  const preview = buildGeminiRepairPreview(rows);
  return {
    version: 1,
    backupVerified,
    approvals: preview.candidates.map(candidate => ({
      id: candidate.id,
      expectedFingerprint: candidate.fingerprint,
      targetKey: candidate.targetKey,
      action: 'rekey' as const,
    })),
  };
};

test('preview reports bounded IDs, fingerprints and equivalence without memory content and writes nothing', () => {
  const rows = [row('1', 'gemini-conv:0:2024-01-01'), row('2', 'gemini-conv:1:2024-01-01')];
  const preview = buildGeminiRepairPreview(rows, 1);
  assert.equal(preview.totalCandidates, 2);
  assert.equal(preview.candidates.length, 1);
  assert.match(preview.candidates[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.match(preview.candidates[0].targetKey, /^gemini-conv:v2:/);
  assert.equal(JSON.stringify(preview).includes(rows[0].content), false);
});

test('non-legacy and other client/source rows are outside repair scope', () => {
  const rows = [
    row('legacy', 'gemini-conv:4:old'),
    row('v2', 'gemini-conv:v2:abc'),
    row('client', 'gemini-conv:5:old', { client_id: 'other' }),
    row('source', 'gemini-conv:6:old', { source: 'other' }),
  ];
  assert.deepEqual(buildGeminiRepairPreview(rows).candidates.map(x => x.id), ['legacy']);
});

test('apply refuses missing backup acknowledgement, broad/incomplete approval and drift', async () => {
  const rows = [row('1', 'gemini-conv:0:old'), row('2', 'gemini-conv:1:old', { content: 'different' })];
  await assert.rejects(applyGeminiKeyRepair(new MemoryClient(rows), manifestFor(rows, false)), /backup/i);
  const incomplete = manifestFor(rows); incomplete.approvals.pop();
  await assert.rejects(applyGeminiKeyRepair(new MemoryClient(rows), incomplete), /unapproved|incomplete/i);
  const drift = manifestFor(rows); rows[0].updated_at = '2025-01-01T00:00:00.000Z';
  await assert.rejects(applyGeminiKeyRepair(new MemoryClient(rows), drift), /drift|fingerprint/i);
});

test('approved ordinary rekeys preserve IDs/content/metadata and rerun is idempotent', async () => {
  const rows = [row('1', 'gemini-conv:0:old', { metadata: { keep: true }, tags: ['keep'] })];
  const original = structuredClone(rows[0]);
  const client = new MemoryClient(rows);
  const result = await applyGeminiKeyRepair(client, manifestFor(rows));
  assert.deepEqual(result, { rekeyed: ['1'], deleted: [], retained: [] });
  assert.equal(rows[0].id, original.id);
  assert.equal(rows[0].content, original.content);
  assert.deepEqual(rows[0].metadata, original.metadata);
  assert.match(rows[0].source_key, /^gemini-conv:v2:/);
  const rerun = await applyGeminiKeyRepair(client, { version: 1, backupVerified: true, approvals: [] });
  assert.deepEqual(rerun, { rekeyed: [], deleted: [], retained: [] });
});

test('collision apply requires oldest retention and explicit byte-equivalent duplicate deletion', async () => {
  const rows = [
    row('old', 'gemini-conv:0:old', { created_at: '2024-01-01T00:00:00.000Z' }),
    row('new', 'gemini-conv:1:old', { created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-02-01T00:00:00.000Z' }),
  ];
  const preview = buildGeminiRepairPreview(rows);
  assert.equal(preview.collisions[0].byteEquivalent, true);
  const approvals: ApprovalManifest['approvals'] = preview.candidates.map(candidate => ({
    id: candidate.id,
    expectedFingerprint: candidate.fingerprint,
    targetKey: candidate.targetKey,
    action: candidate.id === 'old' ? 'retain' : 'delete',
    retainId: 'old',
  }));
  const client = new MemoryClient(rows);
  const result = await applyGeminiKeyRepair(client, { version: 1, backupVerified: true, approvals });
  assert.deepEqual(result, { rekeyed: ['old'], deleted: ['new'], retained: ['old'] });
  assert.deepEqual(rows.map(x => x.id), ['old']);
});

test('a pre-existing v2 duplicate is deleted before the retained legacy row is rekeyed', async () => {
  const legacy = row('a', 'gemini-conv:0:old', { updated_at: '2024-01-01T00:00:00.000Z' });
  const target = buildGeminiRepairPreview([legacy]).candidates[0].targetKey;
  const existing = row('b', target, { updated_at: '2024-02-01T00:00:00.000Z' });
  const rows = [legacy, existing];
  const preview = buildGeminiRepairPreview(rows);
  const approvals: ApprovalManifest['approvals'] = rows.map(current => ({
    id: current.id,
    expectedFingerprint: preview.candidates.find(candidate => candidate.id === current.id)?.fingerprint ?? repairRowFingerprint(current),
    targetKey: target,
    action: current.id === legacy.id ? 'retain' : 'delete',
    retainId: legacy.id,
  }));
  const client = new MemoryClient(rows);
  await applyGeminiKeyRepair(client, { version: 1, backupVerified: true, approvals });
  const writes = client.calls.map(call => call.sql).filter(sql => /^UPDATE|^DELETE/.test(sql));
  assert.deepEqual(writes, ['DELETE FROM memories WHERE id = $1', 'UPDATE memories SET source_key = $1 WHERE id = $2']);
  assert.deepEqual(rows.map(current => current.id), ['a']);
  assert.equal(rows[0].source_key, target);
});

test('non-equivalent collisions require exact leave approvals and remain wholly unchanged', async () => {
  const legacy = row('a', 'gemini-conv:0:old');
  const target = buildGeminiRepairPreview([legacy]).candidates[0].targetKey;
  const existing = row('b', target, { content: 'different persisted payload' });
  const rows = [legacy, existing];
  const preview = buildGeminiRepairPreview(rows);
  assert.equal(preview.collisions[0].byteEquivalent, false);
  const approvals: ApprovalManifest['approvals'] = rows.map(current => ({
    id: current.id,
    expectedFingerprint: preview.candidates.find(candidate => candidate.id === current.id)?.fingerprint
      ?? repairRowFingerprint(current),
    targetKey: target,
    action: 'leave' as const,
  }));
  const client = new MemoryClient(rows);
  const result = await applyGeminiKeyRepair(client, { version: 1, backupVerified: true, approvals });
  assert.deepEqual(result, { rekeyed: [], deleted: [], retained: [] });
  assert.deepEqual(rows, [legacy, existing]);
  assert.equal(client.calls.some(call => /^UPDATE|^DELETE/.test(call.sql)), false);
});

test('collision apply rejects non-oldest retention, non-equivalent deletion, and rolls back atomically', async () => {
  const equivalent = [row('a', 'gemini-conv:0:old'), row('b', 'gemini-conv:1:old')];
  const preview = buildGeminiRepairPreview(equivalent);
  const badOldest: ApprovalManifest = { version: 1, backupVerified: true, approvals: preview.candidates.map(c => ({ id: c.id, expectedFingerprint: c.fingerprint, targetKey: c.targetKey, action: c.id === 'b' ? 'retain' : 'delete', retainId: 'b' })) };
  await assert.rejects(applyGeminiKeyRepair(new MemoryClient(equivalent), badOldest), /oldest/i);

  const forged = structuredClone(equivalent); forged[1].content = 'not equivalent';
  const forgedPreview = buildGeminiRepairPreview(forged);
  const sameTarget = forgedPreview.candidates[0].targetKey;
  const unsafe: ApprovalManifest = { version: 1, backupVerified: true, approvals: forgedPreview.candidates.map((c, i) => ({ id: c.id, expectedFingerprint: c.fingerprint, targetKey: sameTarget, action: i ? 'delete' : 'retain', retainId: 'a' })) };
  await assert.rejects(applyGeminiKeyRepair(new MemoryClient(forged), unsafe), /target|equivalent/i);

  const failing = new MemoryClient(equivalent);
  const validPreview = buildGeminiRepairPreview(equivalent);
  const valid: ApprovalManifest = {
    version: 1,
    backupVerified: true,
    approvals: validPreview.candidates.map(candidate => ({
      id: candidate.id,
      expectedFingerprint: candidate.fingerprint,
      targetKey: candidate.targetKey,
      action: candidate.id === validPreview.collisions[0].oldestId ? 'retain' : 'delete',
      retainId: validPreview.collisions[0].oldestId,
    })),
  };
  failing.query = async function(sql, values) {
    const result = await MemoryClient.prototype.query.call(this, sql, values);
    if (/^UPDATE memories/.test(sql)) throw new Error('write failure');
    return result;
  };
  await assert.rejects(applyGeminiKeyRepair(failing, valid), /write failure/);
  assert.equal(failing.calls.at(-1)?.sql, 'ROLLBACK');
});
