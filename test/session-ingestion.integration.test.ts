import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { loadMigrationInventory, runMigrations } from '../scripts/migrate.js';
import { provisionDatabase } from '../scripts/provision-db.js';
import { finalizeMemoryValidity } from '../scripts/finalize-memory-validity.js';
import { hashKey } from '../src/auth.js';
import { dbScopeFromAuth, setPoolForTesting, withScopedClient } from '../src/db.js';
import { memoryStoreSession, memorySessionStatus, storeSessionSchema } from '../src/session-distillation.js';
import type { AuthContext } from '../src/types.js';

test('queued sessions retain physical transcripts independently of embedding and generation', { timeout:240000 }, async t => {
  const env={ ...process.env }, originalFetch=globalThis.fetch;
  const port=await new Promise<number>((resolve,reject) => {
    const server=createServer(); server.once('error',reject); server.listen(0,'127.0.0.1',() => {
      const port=(server.address() as { port:number }).port; server.close(error => error ? reject(error) : resolve(port));
    });
  });
  const container=execFileSync('docker',['run','--rm','-d','-e','POSTGRES_PASSWORD=test-only','-p',`127.0.0.1:${port}:5432`,process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16'],{ encoding:'utf8' }).trim();
  let owner:pg.Client | undefined, app:pg.Pool | undefined;
  t.after(async () => {
    setPoolForTesting(null); process.env=env; globalThis.fetch=originalFetch;
    await app?.end(); await owner?.end(); execFileSync('docker',['rm','-f',container],{ stdio:'ignore' });
  });
  for (let index=0; index<150; index++) {
    const candidate=new pg.Client({ connectionString:`postgresql://postgres:test-only@127.0.0.1:${port}/postgres`,connectionTimeoutMillis:2000 });
    try { await candidate.connect(); owner=candidate; break; }
    catch { await candidate.end(); await new Promise(resolve => setTimeout(resolve,200)); }
  }
  assert.ok(owner);
  await owner.query('CREATE EXTENSION vector');
  await provisionDatabase(owner,{ appPassword:'app-test-only',rotateAppPassword:false });
  await runMigrations(owner,loadMigrationInventory(fileURLToPath(new URL('../migrations',import.meta.url))),{ lockTimeoutMs:5000 });
  await finalizeMemoryValidity(owner);
  app=new pg.Pool({ connectionString:`postgresql://total_recall_app:app-test-only@127.0.0.1:${port}/postgres` }); setPoolForTesting(app);
  const auth:AuthContext={ keyId:randomUUID(),name:'session-owner',namespaces:['shared'],permissions:['read','write','delete'],maxAccessLevel:'secret' };
  const admin:AuthContext={ ...auth,keyId:randomUUID(),name:'session-worker',permissions:['read','write','admin'],maxAccessLevel:'normal' };
  const other:AuthContext={ ...auth,keyId:randomUUID(),name:'session-other' };
  for (const actor of [auth,admin,other]) await owner.query('INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level) VALUES($1,$2,$3,$4,$5,$6)',[actor.keyId,hashKey(`tr_${actor.name}`),actor.name,actor.namespaces,actor.permissions,actor.maxAccessLevel]);
  process.env.MEMORY_INGESTION_QUEUE_ENABLED='true'; process.env.MEMORY_INGESTION_SESSION_ENABLED='true';
  process.env.MEMORY_STORE_INLINE_EMBED_MS='100';
  globalThis.fetch=async () => { throw new Error('synthetic embedding offline'); };
  const params=(session_id=randomUUID(), transcript='User prefers PostgreSQL.') => storeSessionSchema.parse({ session_id,transcript });

  await t.test('offline provider still commits episode, every chunk, run, document jobs and audit', async () => {
    const input=params();
    const accepted=await memoryStoreSession(input,auth);
    assert.equal(accepted.state,'queued'); assert.equal(accepted.status,'pending');
    const physical=(await owner!.query(`SELECT d.chunk_count,count(m.id)::int AS physical,
      count(j.memory_id)::int AS jobs,bool_and(m.embedding IS NULL) AS pending,
      bool_and(j.kind='document' AND j.document_id=d.id AND NOT j.dedupe AND NOT j.contradiction_eligible) AS document_jobs
      FROM documents d JOIN memories m ON m.document_id=d.id LEFT JOIN memory_ingestion_jobs j ON j.memory_id=m.id
      WHERE d.id=$1 GROUP BY d.id`,[accepted.episode_id])).rows[0];
    assert.deepEqual(physical,{ chunk_count:accepted.chunks_stored,physical:accepted.chunks_stored,jobs:accepted.chunks_stored,pending:true,document_jobs:true });
    assert.equal((await owner!.query("SELECT count(*)::int AS n FROM audit_log WHERE action='session.store' AND memory_id=$1",[accepted.episode_id])).rows[0].n,1);
    const replay=await memoryStoreSession(input,auth);
    assert.deepEqual(replay,{ ...accepted,idempotent_replay:true });
    await assert.rejects(memoryStoreSession({ ...input,transcript:'changed' },auth),/different request/);
  });
});
