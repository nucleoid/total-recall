import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import { setPoolForTesting } from '../src/db.js';
import { memoryStore, storeSchema } from '../src/tools/store.js';
const auth = { keyId: '11111111-1111-4111-8111-111111111111', name: 'test', namespaces: ['shared'], permissions: ['write'], maxAccessLevel: 'normal' as const };

test('queue acceptance persists before any provider attempt even when provider is unavailable', async t => {
  process.env.MEMORY_INGESTION_QUEUE_ENABLED = 'true';
  t.after(() => { delete process.env.MEMORY_INGESTION_QUEUE_ENABLED; delete process.env.MEMORY_STORE_INLINE_EMBED_MS; });
  process.env.MEMORY_STORE_INLINE_EMBED_MS = '0';
  let persisted = false;
  const result = (rows: unknown[]) => ({ rows, rowCount: rows.length });
  const pool = { connect: async () => ({ release() {}, query: async (sql: string) => {
    if (sql.includes('INSERT INTO agents')) return result([{ id: '22222222-2222-4222-8222-222222222222' }]);
    if (sql.includes('INSERT INTO memories')) { persisted = true; return result([{ id: '33333333-3333-4333-8333-333333333333', namespace: 'shared', expires_at: null, created: true, embedding: null }]); }
    if (sql.includes('INSERT INTO memory_ingestion_jobs')) return result([{ accepted_at: new Date(), status: 'pending' }]);
    return result([]);
  } }) };
  setPoolForTesting(pool as unknown as pg.Pool);
  t.after(() => setPoolForTesting(null));
  t.mock.method(globalThis, 'fetch', async () => { assert.ok(persisted, 'provider must not run before commit'); throw new Error('offline'); });
  const stored = await memoryStore(storeSchema.parse({ content: 'retain this', dedupe: false, agent_name: 'test' }), auth);
  assert.equal(stored.state, 'queued');
  assert.equal(persisted, true);
});


test('durable acknowledgement survives a claim failure after acceptance', async t => {
  const { tryInlineIngestion } = await import('../src/ingestion.js');
  process.env.MEMORY_STORE_INLINE_EMBED_MS='100';
  t.after(() => { delete process.env.MEMORY_STORE_INLINE_EMBED_MS; setPoolForTesting(null); });
  setPoolForTesting({ connect:async () => { throw new Error('private connection detail'); } } as unknown as pg.Pool);
  const accepted = { id:'33333333-3333-4333-8333-333333333333', namespace:'shared', created:true,
    deduplicated:false,expires_at:null,state:'queued' as const,accepted_at:new Date() };
  assert.deepEqual(await tryInlineIngestion(accepted,auth),accepted);
});

test('durable acknowledgement survives a failure to record an inline provider failure', async t => {
  const { tryInlineIngestion } = await import('../src/ingestion.js');
  process.env.MEMORY_STORE_INLINE_EMBED_MS='1000';
  t.after(() => { delete process.env.MEMORY_STORE_INLINE_EMBED_MS; setPoolForTesting(null); });
  let connects=0;
  const job = { memory_id:'33333333-3333-4333-8333-333333333333', namespace:'shared', client_id:auth.keyId,
    lease_token:'44444444-4444-4444-8444-444444444444', attempts:0, accepted_at:new Date(),allowed_namespaces:['shared'] };
  setPoolForTesting({ connect:async () => {
    if (++connects===3) throw new Error('private failure-update detail');
    return { release() {},query:async (sql:string) => {
      const rows = sql.includes('WITH candidate AS') ? [job] : sql.includes('SELECT 1 FROM memory_ingestion_jobs') ? [{}] :
        sql.includes('FROM memories WHERE') ? [{ content:'retained',embedding:null,expires_at:null,expired:false }] : [];
      return { rows,rowCount:rows.length };
    } };
  } } as unknown as pg.Pool);
  t.mock.method(globalThis,'fetch',async () => { throw new Error('provider offline'); });
  const accepted = { id:job.memory_id,namespace:'shared',created:true,deduplicated:false,expires_at:null,state:'queued' as const,accepted_at:job.accepted_at };
  assert.deepEqual(await tryInlineIngestion(accepted,auth),accepted); assert.ok(connects>=3,'the failure-recording connection was attempted');
});
