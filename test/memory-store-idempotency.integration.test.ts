import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type pg from 'pg';
import request from 'supertest';
import { setPoolForTesting } from '../src/db.js';
import type { AuthContext } from '../src/types.js';

const AUTH_A: AuthContext = { keyId: '11111111-1111-4111-8111-111111111111', name: 'a', namespaces: ['shared', 'private'], permissions: ['write'], maxAccessLevel: 'secret' };
const AUTH_B: AuthContext = { ...AUTH_A, keyId: '22222222-2222-4222-8222-222222222222', name: 'b' };
type Row = { id: string; source_key: string | null; content: string; namespace: string; access_level: string; created_at: number; updated_at: number; deleted_at: string | null };

class FakePool {
  rows: Row[] = [];
  sql: string[] = [];
  clientSql: string[][] = [];
  tick = 0;
  currentNamespaces: string[] = [];
  async connect() {
    const clientSql: string[] = [];
    this.clientSql.push(clientSql);
    return { query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      this.sql.push(sql);
      clientSql.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result([]);
      if (sql.startsWith("SELECT set_config('app.allowed_namespaces'")) {
        this.currentNamespaces = params[0] ? JSON.parse(String(params[0])) as string[] : [];
        return result([]);
      }
      if (sql.startsWith("SELECT set_config('app.")) return result([]);
      if (/SELECT pg_advisory_xact_lock/i.test(sql)) return result([{}]);
      if (/SELECT m\.id, m\.namespace,[\s\S]*m\.embedding <=>/i.test(sql)) return result([]);
      if (/INSERT INTO agents/i.test(sql)) return result([{ id: `agent-${params[0]}` }]);
      if (/INSERT INTO audit_log/i.test(sql)) return result([]);
      if (/INSERT INTO memories/i.test(sql)) {
        const keyed = /source_key/i.test(sql);
        const sourceKey = keyed ? String(params[14]) : null;
        let row = sourceKey ? this.rows.find(r => r.source_key === sourceKey) : undefined;
        if (row) {
          const allowedNamespaces = params[15] as string[] | undefined;
          if (allowedNamespaces && !allowedNamespaces.includes(row.namespace)) {
            const error = new Error('duplicate key value violates unique constraint "memories_source_key_key"') as Error & { code: string };
            error.code = '23505';
            throw error;
          }
          if (row.deleted_at !== null || (allowedNamespaces && !allowedNamespaces.includes(String(params[3])))) {
            return result([], 'INSERT');
          }
          row.content = String(params[0]); row.namespace = String(params[3]); row.access_level = String(params[6]); row.updated_at = ++this.tick;
        } else {
          row = { id: `m-${this.rows.length + 1}`, content: String(params[0]), namespace: String(params[3]), access_level: String(params[6]), source_key: sourceKey, created_at: ++this.tick, updated_at: this.tick, deleted_at: null };
          this.rows.push(row);
        }
        return result([{ id: row.id, namespace: row.namespace }], 'INSERT');
      }
      if (/SELECT 1 FROM memories WHERE source_key/i.test(sql)) {
        const row = this.rows.find(candidate =>
          candidate.source_key === params[0] &&
          candidate.deleted_at !== null &&
          this.currentNamespaces.includes(candidate.namespace)
        );
        return result(row ? [{ '?column?': 1 }] : []);
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }, release() {} };
  }
  async query(): Promise<never> { throw new Error('must use scoped client'); }
}
function result(rows: any[], command = 'MOCK') { return { command, rowCount: rows.length, oid: 0, fields: [], rows }; }
function sourceKey(auth: AuthContext, key: string) { return `discord-safe:v1:${createHash('sha256').update(`${auth.keyId}\0${key}`).digest('hex')}`; }

test('memory_store keyed retries upsert per API key while dedupe opt-out calls append', async t => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ embedding: { values: Array(768).fill(0.1) } }), { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  process.env.EMBEDDING_PROVIDER = 'gemini';
  process.env.EMBEDDING_MODEL = 'gemini-embedding-2-preview';
  process.env.EMBEDDING_DIMENSIONS = '768';
  process.env.GEMINI_API_KEY = 'test-only-key';
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

  const plain = storeSchema.parse({ content: 'append', dedupe: false });
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

test('memory_store reports a visible tombstone as a typed conflict on the same scoped client', async t => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ embedding: { values: Array(768).fill(0.1) } }), { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  process.env.EMBEDDING_PROVIDER = 'gemini';
  process.env.EMBEDDING_MODEL = 'gemini-embedding-2-preview';
  process.env.EMBEDDING_DIMENSIONS = '768';
  process.env.GEMINI_API_KEY = 'test-only-key';
  const { memoryStore, storeSchema } = await import('../src/tools/store.js');
  const { TombstonedSourceKeyConflictError } = await import('../src/errors.js');

  const params = storeSchema.parse({ content: 'replacement', namespace: 'shared', idempotency_key: 'deleted' });
  pool.rows.push({
    id: 'deleted-memory',
    source_key: sourceKey(AUTH_A, 'deleted'),
    content: 'forgotten content',
    namespace: 'shared',
    access_level: 'normal',
    created_at: 1,
    updated_at: 1,
    deleted_at: '2026-07-14T00:00:00.000Z',
  });

  await assert.rejects(memoryStore(params, AUTH_A), (error: unknown) => {
    assert.ok(error instanceof TombstonedSourceKeyConflictError);
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'idempotency_key_tombstoned');
    return true;
  });
  assert.equal(pool.rows[0].content, 'forgotten content');
  const conflictClientSql = pool.clientSql.find(statements =>
    statements.some(sql => /INSERT INTO memories/i.test(sql)) &&
    statements.some(sql => /SELECT 1 FROM memories WHERE source_key/i.test(sql))
  );
  assert.ok(conflictClientSql, 'upsert and tombstone lookup must use one scoped client');
  const insertIndex = conflictClientSql.findIndex(sql => /INSERT INTO memories/i.test(sql));
  const lookupIndex = conflictClientSql.findIndex(sql => /SELECT 1 FROM memories WHERE source_key/i.test(sql));
  assert.ok(lookupIndex > insertIndex);
  assert.equal(conflictClientSql.at(-1), 'ROLLBACK');

  const { createApp, setServerTestOverrides } = await import('../src/server.js');
  setServerTestOverrides({ validateKey: async () => AUTH_A });
  t.after(() => setServerTestOverrides({}));
  const response = await request(createApp())
    .post('/api/store')
    .set('Authorization', 'Bearer tr_test')
    .send(params);
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, {
    error: 'Idempotency key refers to a deleted memory',
    code: 'idempotency_key_tombstoned',
  });
});

test('idempotent stores never classify and shadow classification starts only after commit', async t => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ embedding: { values: Array(768).fill(0.1) } }), { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  process.env.EMBEDDING_PROVIDER = 'gemini';
  process.env.EMBEDDING_MODEL = 'gemini-embedding-2-preview';
  process.env.EMBEDDING_DIMENSIONS = '768';
  process.env.GEMINI_API_KEY = 'test-only-key';
  const { memoryStore, storeSchema } = await import('../src/tools/store.js');

  let reviseCalls = 0;
  let queued: (() => Promise<void>) | undefined;
  let scheduledAfterCommit = false;
  const policy = {
    classificationEnabled: true,
    provider: 'approved',
    model: 'approved',
    endpoint: 'https://generation.example.test/v1',
    namespace: 'shared',
    timeoutMs: 1000,
    mutationConfidence: 0.95,
    mutationEnabled: false,
  };
  const runtime = {
    contradictionPolicy: policy,
    reviseBelief: async (_memory: unknown, _auth: unknown, options: { excludeCandidateId?: string }) => {
      reviseCalls += 1;
      assert.match(options.excludeCandidateId ?? '', /^m-/);
      return null;
    },
    scheduleShadow: (task: () => Promise<void>) => {
      const latestTransaction = pool.clientSql.at(-1) ?? [];
      scheduledAfterCommit = latestTransaction.some(sql => /INSERT INTO memories/i.test(sql)) &&
        latestTransaction.at(-1) === 'COMMIT';
      queued = task;
    },
  };

  await memoryStore(storeSchema.parse({ content: 'retry-safe', idempotency_key: 'same' }), AUTH_A, runtime);
  assert.equal(reviseCalls, 0);
  assert.equal(queued, undefined);

  const stored = await memoryStore(storeSchema.parse({ content: 'new observation' }), AUTH_A, runtime);
  assert.equal(scheduledAfterCommit, true);
  assert.equal(reviseCalls, 0);
  assert.ok(queued);
  await queued!();
  assert.equal(reviseCalls, 1);
  assert.match(stored.id, /^m-/);
});

test('OpenAPI documents the stable tombstoned idempotency conflict response', async () => {
  const openapi = await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8');
  assert.match(openapi, /\/api\/store:[\s\S]*?"409":\s*\n\s*\$ref: "#\/components\/responses\/TombstonedIdempotencyKey"/);
  assert.match(openapi, /TombstonedIdempotencyKey:[\s\S]*?enum: \[idempotency_key_tombstoned\]/);
  assert.match(openapi, /\/api\/store-document:[\s\S]*?"409":\s*\n\s*\$ref: "#\/components\/responses\/DocumentIdempotencyConflict"/);
  assert.match(openapi, /DocumentIdempotencyConflict:[\s\S]*?tombstoned chunks[\s\S]*?enum: \[idempotency_key_tombstoned\]/);
});

test('memory_store normalizes inaccessible keyed conflicts without leaking row existence', async t => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ embedding: { values: Array(768).fill(0.1) } }), { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  process.env.EMBEDDING_PROVIDER = 'gemini';
  process.env.EMBEDDING_MODEL = 'gemini-embedding-2-preview';
  process.env.EMBEDDING_DIMENSIONS = '768';
  process.env.GEMINI_API_KEY = 'test-only-key';
  const { memoryStore, storeSchema } = await import('../src/tools/store.js');

  await memoryStore(storeSchema.parse({ content: 'original', namespace: 'private', idempotency_key: 'hidden' }), AUTH_A);
  const sharedOnly = { ...AUTH_A, namespaces: ['shared'] };
  const replacement = storeSchema.parse({ content: 'replacement', namespace: 'shared', idempotency_key: 'hidden' });
  await assert.rejects(
    memoryStore(replacement, sharedOnly),
    { message: 'Access denied to existing idempotent memory' },
  );
  pool.rows[0].deleted_at = '2026-07-14T00:00:00.000Z';
  await assert.rejects(
    memoryStore(replacement, sharedOnly),
    (error: unknown) => error instanceof Error &&
      error.name !== 'TombstonedSourceKeyConflictError' &&
      error.message === 'Access denied to existing idempotent memory',
  );

  const { createApp, setServerTestOverrides } = await import('../src/server.js');
  setServerTestOverrides({ validateKey: async () => sharedOnly });
  t.after(() => setServerTestOverrides({}));
  const response = await request(createApp())
    .post('/api/store')
    .set('Authorization', 'Bearer tr_test')
    .send(replacement);
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: 'Access denied to existing idempotent memory' });
  assert.equal(pool.rows[0].content, 'original');
  assert.equal(pool.rows[0].namespace, 'private');
});
