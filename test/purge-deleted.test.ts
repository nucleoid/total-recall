import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDeletedWithClient,
  parsePurgeNamespaces,
  previewDeletedWithClient,
  PURGE_RETENTION_DAYS,
} from '../scripts/purge-deleted.js';

const ID = '11111111-1111-4111-8111-111111111111';
const DELETED_AT = '2024-01-01T00:00:00.000Z';

class PurgeClient {
  queries: string[] = [];
  deleted = false;
  referenced = false;
  async query<T = any>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
    this.queries.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] as T[], rowCount: 1 };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] as T[], rowCount: 1 };
    if (sql.includes('NOT (namespace = ANY')) return { rows: [{ count: '0' }] as T[], rowCount: 1 };
    if (sql.includes('FROM public.memories m') && sql.includes('ORDER BY m.deleted_at')) {
      if (this.deleted) return { rows: [], rowCount: 0 };
      return { rows: [{ id: ID, namespace: 'shared', deleted_at: DELETED_AT, media_references: this.referenced ? 1 : 0 }] as T[], rowCount: 1 };
    }
    if (sql.includes('FROM public.memories m') && sql.includes('FOR UPDATE')) {
      return { rows: [{ id: ID, namespace: 'shared', deleted_at: DELETED_AT, media_references: this.referenced ? 1 : 0 }] as T[], rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM public.memories')) { this.deleted = true; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }
}

test('purge namespace inventory is explicit, normalized, and nonempty', () => {
  assert.deepEqual(parsePurgeNamespaces('["work", "shared", "work"]'), ['shared', 'work']);
  assert.deepEqual(parsePurgeNamespaces('work, shared'), ['shared', 'work']);
  assert.throws(() => parsePurgeNamespaces(undefined), /explicitly list/i);
  assert.throws(() => parsePurgeNamespaces('[]'), /invalid|empty/i);
});

test('preview-first apply verifies fingerprints, audits, then deletes in one batch', async () => {
  const client = new PurgeClient();
  const preview = await previewDeletedWithClient(client, ['shared']);
  assert.equal(preview.retentionDays, PURGE_RETENTION_DAYS);
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.blocked.length, 0);

  const result = await applyDeletedWithClient(client, ['shared'], preview);
  assert.deepEqual(result, { purged: 1, blocked: 0 });
  const audit = client.queries.findIndex(sql => sql.includes("'memory.purge'"));
  const deletion = client.queries.findIndex(sql => sql.startsWith('DELETE FROM public.memories'));
  assert.ok(audit >= 0 && deletion > audit);
  assert.match(client.queries.find(sql => sql.includes('ORDER BY m.deleted_at'))!, /INTERVAL '30 days'/);
});

test('referenced media tombstones are blocked and never become purge candidates', async () => {
  const client = new PurgeClient();
  client.referenced = true;
  const preview = await previewDeletedWithClient(client, ['shared']);
  assert.deepEqual(preview.candidates, []);
  assert.deepEqual(preview.blocked, [{ id: ID, namespace: 'shared', reason: 'media_events' }]);
});

test('apply rejects malformed or mismatched previews before deleting', async () => {
  const client = new PurgeClient();
  const preview = await previewDeletedWithClient(client, ['shared']);
  preview.candidates[0].fingerprint = 'forged';
  await assert.rejects(applyDeletedWithClient(client, ['shared'], preview), /malformed/i);
  assert.equal(client.deleted, false);
});
