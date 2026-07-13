import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import { setPoolForTesting } from '../src/db.js';
import { upsertMediaEvents } from '../src/media.js';

const SCOPE = {
  namespaces: ['media'],
  keyId: '11111111-1111-4111-8111-111111111111',
};

class FakeClient {
  inserts: string[] = [];
  private calls = 0;

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string): Promise<pg.QueryResult<T>> {
    if (/^\s*INSERT INTO media_events/i.test(text)) {
      this.inserts.push(text);
      this.calls += 1;
      const rows = this.calls === 1 ? [{ id: 'event-1' } as T] : [];
      return { rows, rowCount: rows.length, command: 'INSERT', oid: 0, fields: [] };
    }
    return { rows: [], rowCount: 0, command: 'MOCK', oid: 0, fields: [] };
  }

  release(): void {}
}

test('media upsert lets every database uniqueness rule arbitrate insertion outcome', async () => {
  const client = new FakeClient();
  setPoolForTesting({ connect: async () => client } as unknown as pg.Pool);
  try {
    const result = await upsertMediaEvents([
      { service: 'plex', event_type: 'watch', title: 'Arrival', played_at: '2026-07-01T20:00:00Z', client_id: SCOPE.keyId },
      { service: 'plex', event_type: 'watch', title: 'Arrival', played_at: '2026-07-01T20:00:00Z', client_id: SCOPE.keyId },
    ], SCOPE);

    assert.deepEqual(result, { inserted: 1, skipped: 1, ids: ['event-1'] });
    assert.equal(client.inserts.length, 2);
    for (const sql of client.inserts) {
      assert.match(sql, /ON CONFLICT DO NOTHING/i);
      assert.doesNotMatch(sql, /ON CONFLICT\s*\([^)]/i);
      assert.match(sql, /RETURNING id\b/i);
    }
  } finally {
    setPoolForTesting(null);
  }
});
