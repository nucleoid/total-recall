import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import { setPoolForTesting } from '../src/db.js';
import { MAX_FORGET_ROWS, forgetSchema, forgetMemories } from '../src/memory-lifecycle.js';
import type { AuthContext } from '../src/types.js';

const ID = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const auth: AuthContext = {
  keyId: KEY,
  name: 'deleter',
  namespaces: ['shared'],
  permissions: ['read', 'write', 'delete'],
  maxAccessLevel: 'secret',
};

function rows<T>(value: T[]) {
  return { command: 'MOCK', rowCount: value.length, oid: 0, fields: [], rows: value };
}

class ForgetPool {
  sql: string[] = [];
  selected = [{ id: ID, namespace: 'shared' }];
  failAudit = false;
  commits = 0;
  rollbacks = 0;

  async connect() {
    return {
      query: async (text: string) => {
        this.sql.push(text.replace(/\s+/g, ' ').trim());
        if (text === 'COMMIT') { this.commits++; return rows([]); }
        if (text === 'ROLLBACK') { this.rollbacks++; return rows([]); }
        if (text === 'BEGIN' || text.includes("set_config('app.")) return rows([]);
        if (text.includes('SELECT m.id, m.namespace')) return rows(this.selected);
        if (text.includes('UPDATE memories')) return rows(this.selected);
        if (text.includes('INSERT INTO audit_log')) {
          if (this.failAudit) throw new Error('audit failed');
          return rows([]);
        }
        throw new Error(`Unexpected query: ${text}`);
      },
      release() {},
    };
  }
}

test.afterEach(() => setPoolForTesting(null));

test('forget schema rejects unsafe selectors and normalizes UUIDs', () => {
  assert.throws(() => forgetSchema.parse({}), /selector/i);
  assert.throws(() => forgetSchema.parse({ namespace: 'shared' }), /confirm/i);
  assert.throws(() => forgetSchema.parse({ ids: [] }));
  assert.throws(() => forgetSchema.parse({ tags: [], confirm: true }));
  assert.throws(() => forgetSchema.parse({ ids: [ID, ID.toUpperCase()] }), /duplicate/i);
  assert.throws(() => forgetSchema.parse({ before: new Date(Date.now() + 60_000).toISOString(), confirm: true }), /future/i);
  assert.throws(() => forgetSchema.parse({ ids: [ID], reason: 'x'.repeat(513) }));
  assert.equal(forgetSchema.parse({ ids: [ID.toUpperCase()] }).ids?.[0], ID);
  assert.equal(forgetSchema.parse({ namespace: 'shared', confirm: true }).confirm, true);
});

test('forget uses strict active selectors and writes one audit row in its transaction', async () => {
  const pool = new ForgetPool();
  setPoolForTesting(pool as unknown as pg.Pool);
  const result = await forgetMemories({ ids: [ID], namespace: 'shared', before: '2024-01-01T00:00:00Z', tags: ['x'] }, auth);
  assert.deepEqual(result, { forgotten: [ID], count: 1 });
  const select = pool.sql.find(sql => sql.includes('SELECT m.id, m.namespace'))!;
  assert.match(select, /deleted_at IS NULL/);
  assert.match(select, /created_at </);
  assert.match(select, /tags @>/);
  assert.match(select, new RegExp(`LIMIT ${MAX_FORGET_ROWS + 1}`));
  assert.equal(pool.sql.filter(sql => sql.includes('INSERT INTO audit_log')).length, 1);
  assert.equal(pool.commits, 1);
});

test('over-cap and audit failure roll back without a committed tombstone', async () => {
  const over = new ForgetPool();
  over.selected = Array.from({ length: MAX_FORGET_ROWS + 1 }, (_, index) => ({
    id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
    namespace: 'shared',
  }));
  setPoolForTesting(over as unknown as pg.Pool);
  await assert.rejects(forgetMemories({ namespace: 'shared', confirm: true }, auth), /narrow/i);
  assert.equal(over.sql.some(sql => sql.includes('UPDATE memories')), false);
  assert.equal(over.rollbacks, 1);

  const auditFailure = new ForgetPool();
  auditFailure.failAudit = true;
  setPoolForTesting(auditFailure as unknown as pg.Pool);
  await assert.rejects(forgetMemories({ ids: [ID] }, auth), /audit failed/);
  assert.equal(auditFailure.commits, 0);
  assert.equal(auditFailure.rollbacks, 1);
});

test('delete permission is independent from write and namespace access is explicit', async () => {
  await assert.rejects(forgetMemories({ ids: [ID] }, { ...auth, permissions: ['write'] }), /requires 'delete'/);
  await assert.rejects(forgetMemories({ namespace: 'private', confirm: true }, auth), /Access denied/);
});
