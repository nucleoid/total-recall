import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type pg from 'pg';
import { setPoolForTesting } from '../src/db.js';
import type { AuthContext } from '../src/types.js';

const AUTH_A: AuthContext = { keyId: '11111111-1111-4111-8111-111111111111', name: 'a', namespaces: ['shared', 'private'], permissions: ['write'], maxAccessLevel: 'secret' };
const AUTH_B: AuthContext = { ...AUTH_A, keyId: '22222222-2222-4222-8222-222222222222', name: 'b' };
type Row = { id: string; source_key: string | null; content: string; namespace: string; access_level: string; created_at: number; updated_at: number };

class FakePool {
  rows: Row[] = [];
  sql: string[] = [];
  tick = 0;
  async connect() {
    return { query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      this.sql.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith("SELECT set_config('app.")) return result([]);
      if (/INSERT INTO agents/i.test(sql)) return result([{ id: `agent-${params[0]}` }]);
      if (/INSERT INTO memories/i.test(sql)) {
        const keyed = /source_key/i.test(sql);
        const sourceKey = keyed ? String(params[10]) : null;
        let row = sourceKey ? this.rows.find(r => r.source_key === sourceKey) : undefined;
        if (row) {
          const allowedNamespaces = params[11] as string[] | undefined;
          if (allowedNamespaces && !allowedNamespaces.includes(row.namespace)) {
            const error = new Error('duplicate key value violates unique constraint "memories_source_key_key"') as Error & { code: string };
            error.code = '23505';
            throw error;
          }
          if (allowedNamespaces && !allowedNamespaces.includes(String(params[3]))) return result([]);
          row.content = String(params[0]); row.namespace = String(params[3]); row.access_level = String(params[6]); row.updated_at = ++this.tick;
        } else {
          row = { id: `m-${this.rows.length + 1}`, content: String(params[0]), namespace: String(params[3]), access_level: String(params[6]), source_key: sourceKey, created_at: ++this.tick, updated_at: this.tick };
          this.rows.push(row);
        }
        return result([{ id: row.id, namespace: row.namespace }]);
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }, release() {} };
  }
  async query(): Promise<never> { throw new Error('must use scoped client'); }
}
function result(rows: any[]) { return { command: 'MOCK', rowCount: rows.length, oid: 0, fields: [], rows }; }
function sourceKey(auth: AuthContext, key: string) { return `discord-safe:v1:${createHash('sha256').update(`${auth.keyId}\0${key}`).digest('hex')}`; }

test('memory_store keyed retries upsert per API key while unkeyed calls append', async t => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  process.env.GEMINI_API_KEY = '';
  const { memoryStore, storeSchema } = await import('../src/tools/store.js');

  assert.equal(storeSchema.parse({ content: 'x', idempotency_key: 'k' }).idempotency_key, 'k');
  assert.throws(() => storeSchema.parse({ content: 'x', idempotency_key: '' }));
  assert.throws(() => storeSchema.parse({ content: 'x', idempotency_key: 'x'.repeat(513) }));

  const first = await memoryStore(storeSchema.parse({ content: 'before', idempotency_key: 'same' }), AUTH_A);
  const created = pool.rows[0].created_at;
  const retry = await memoryStore(storeSchema.parse({ content: 'after', namespace: 'private', idempotency_key: 'same' }), AUTH_A);
  assert.equal(first.idempotency_key_honored, true);
  assert.equal(retry.id, first.id);
  assert.equal(retry.idempotency_key_honored, true);
  assert.equal(pool.rows.length, 1);
  assert.equal(pool.rows[0].created_at, created);
  assert.equal(pool.rows[0].content, 'after');
  assert.equal(pool.rows[0].namespace, 'private');
  assert.equal(pool.rows[0].access_level, 'normal');
  assert.equal(pool.rows[0].source_key, sourceKey(AUTH_A, 'same'));

  await memoryStore(storeSchema.parse({ content: 'tenant b', idempotency_key: 'same' }), AUTH_B);
  assert.equal(pool.rows.length, 2);
  assert.equal(pool.rows[1].source_key, sourceKey(AUTH_B, 'same'));

  const plain = storeSchema.parse({ content: 'append' });
  const unkeyed = await memoryStore(plain, AUTH_A); await memoryStore(plain, AUTH_A);
  assert.equal('idempotency_key_honored' in unkeyed, false);
  assert.equal(pool.rows.length, 4);
  const memorySql = pool.sql.filter(sql => /INSERT INTO memories/i.test(sql));
  assert.doesNotMatch(memorySql.at(-1)!, /source_key|ON CONFLICT/i);
  const keyedSql = memorySql.find(sql => /ON CONFLICT/i)!;
  assert.match(keyedSql, /ON CONFLICT \(source_key\) DO UPDATE/i);
  assert.match(keyedSql, /memories\.namespace = ANY/i);
  assert.match(keyedSql, /EXCLUDED\.namespace = ANY/i);
  assert.doesNotMatch(keyedSql, /created_at\s*=/i);
});

test('memory_store normalizes inaccessible keyed conflicts without leaking row existence', async t => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  process.env.GEMINI_API_KEY = '';
  const { memoryStore, storeSchema } = await import('../src/tools/store.js');

  await memoryStore(storeSchema.parse({ content: 'original', namespace: 'private', idempotency_key: 'hidden' }), AUTH_A);
  const sharedOnly = { ...AUTH_A, namespaces: ['shared'] };
  await assert.rejects(
    memoryStore(storeSchema.parse({ content: 'replacement', namespace: 'shared', idempotency_key: 'hidden' }), sharedOnly),
    { message: 'Access denied to existing idempotent memory' },
  );
  assert.equal(pool.rows[0].content, 'original');
  assert.equal(pool.rows[0].namespace, 'private');
});
