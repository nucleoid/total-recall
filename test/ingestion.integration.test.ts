import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import request from 'supertest';
import { loadMigrationInventory, runMigrations } from '../scripts/migrate.js';
import { provisionDatabase } from '../scripts/provision-db.js';
import { setPoolForTesting, withScopedClient, dbScopeFromAuth } from '../src/db.js';
import { hashKey } from '../src/auth.js';
import { acceptMemory, claimIngestionJob, finalizeIngestionJob, failIngestionJob,
  requeueIngestionJob, setIngestionPaused, ingestionStats, type IngestionJob } from '../src/ingestion.js';
import { memoryStore, storeSchema } from '../src/tools/store.js';
import { memoryRecall } from '../src/tools/recall.js';
import { memoryList } from '../src/tools/list.js';
import { hybridSearch } from '../src/search.js';
import { exportMemoryPage, exportPageSchema } from '../src/transfer/export.js';
import { ACTIVE_EMBEDDING_PROFILE } from '../src/embedding.js';
import type { AuthContext } from '../src/types.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const adminId = '33333333-3333-4333-8333-333333333333';
const auth: AuthContext = { keyId: ownerId, name: 'owner', namespaces: ['shared','private'], permissions: ['read','write','export'], maxAccessLevel: 'secret' };
const other: AuthContext = { ...auth, keyId: otherId, name: 'other' };
const admin: AuthContext = { ...auth, keyId: adminId, name: 'worker', permissions: ['admin','read','write','export'] };
const vector = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0);
const embedding = { vector, provider: ACTIVE_EMBEDDING_PROFILE.provider, model: ACTIVE_EMBEDDING_PROFILE.model, dimensions: 768 };
const input = (content: string, extra = {}) => ({ content, namespace: 'shared', tags: [], metadata: {}, access_level: 'normal' as const, dedupe: false, ...extra });

// This suite deliberately fails rather than skips when PostgreSQL evidence is unavailable.
test('durable ingestion on isolated PostgreSQL: leases, RLS, recovery and visibility', { timeout: 180000 }, async t => {
  execFileSync('docker', ['version'], { stdio: 'ignore' });
  const container = execFileSync('docker', ['run','--rm','-d','-e','POSTGRES_PASSWORD=test-only','-p','127.0.0.1::5432', process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16'], { encoding: 'utf8' }).trim();
  let owner: pg.Client | undefined;
  let pool: pg.Pool | undefined;
  t.after(async () => {
    setPoolForTesting(null); await pool?.end(); await owner?.end();
    execFileSync('docker',['rm','-f',container], { stdio: 'ignore' });
    delete process.env.MEMORY_INGESTION_QUEUE_ENABLED; delete process.env.MEMORY_STORE_INLINE_EMBED_MS;
    delete process.env.MEMORY_INGESTION_MAX_ATTEMPTS;
  });
  const port = execFileSync('docker',['port',container,'5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)!;
  const url = `postgresql://postgres:test-only@127.0.0.1:${port}/postgres`;
  for (let i = 0; i < 100; i++) {
    const client = new pg.Client({ connectionString: url });
    try { await client.connect(); owner = client; break; }
    catch { await client.end(); await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(owner, 'isolated PostgreSQL must start');
  await owner.query('CREATE EXTENSION vector');
  await provisionDatabase(owner, { appPassword: 'app-test-only', rotateAppPassword: false });
  await runMigrations(owner, loadMigrationInventory(fileURLToPath(new URL('../migrations', import.meta.url))), { lockTimeoutMs: 5000 });
  pool = new pg.Pool({ connectionString: `postgresql://total_recall_app:app-test-only@127.0.0.1:${port}/postgres` });
  setPoolForTesting(pool);
  process.env.MEMORY_INGESTION_QUEUE_ENABLED = 'true'; process.env.MEMORY_STORE_INLINE_EMBED_MS = '0';
  for (const key of [auth,other,admin]) await owner.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
    VALUES ($1,$2,$3,$4,$5,$6)`, [key.keyId,hashKey(key.name),key.name,key.namespaces,key.permissions,key.maxAccessLevel]);
  const agent = (await owner.query(`INSERT INTO agents (name,type,api_key_id) VALUES ('test','system',$1) RETURNING id`,[ownerId])).rows[0].id;
  const claim = async (id: string) => {
    const job = await claimIngestionJob(dbScopeFromAuth(auth), { memoryId: id, inline: true });
    assert.ok(job); return job;
  };
  await t.test('accept commits memory, job and audit; pending rows are recall/list/FTS/export visible', async () => {
    const accepted = await acceptMemory(input('quasar durable text'), auth, agent);
    assert.equal(accepted.state, 'queued'); assert.ok(accepted.accepted_at);
    const memory = (await owner!.query('SELECT embedding,embedding_provider FROM memories WHERE id=$1',[accepted.id])).rows[0];
    assert.deepEqual(memory,{ embedding: null, embedding_provider: null });
    const recalled = await memoryRecall({ id: accepted.id },auth);
    assert.equal(recalled.ingestion.state,'pending'); assert.equal(recalled.content,'quasar durable text');
    const foreign = await memoryRecall({ id: accepted.id },other);
    assert.deepEqual(foreign.ingestion,{ state: 'pending' });
    const listed = await memoryList({ limit: 100, offset: 0 },auth);
    assert.ok(listed.memories.some(m => m.id === accepted.id && m.ingestion?.state === 'pending'));
    const exported = await exportMemoryPage(exportPageSchema.parse({}),auth);
    assert.equal(exported.records.find(m => m.provenance.memory_id === accepted.id)?.ingestion_state,'pending');
    const results = await hybridSearch({ query: 'quasar', limit: 10, threshold: 0.3 },auth.namespaces,dbScopeFromAuth(auth),auth.maxAccessLevel,
      { trackAccess: false, queryVectors: [{ profile: ACTIVE_EMBEDDING_PROFILE, vector }] });
    const hit = results.find(m => m.id === accepted.id); assert.ok(hit); assert.equal(hit.vec_score,null); assert.equal(hit.ingestion?.state,'pending');
    const visible = await withScopedClient(dbScopeFromAuth(other), c => c.query('SELECT * FROM memory_ingestion_jobs WHERE memory_id=$1',[accepted.id]));
    assert.equal(visible.rows.length,0);
    const outOfScope = await withScopedClient({ keyId: ownerId, namespaces: ['private'] },c => c.query('SELECT app_memory_ingestion_state($1) AS state',[accepted.id]));
    assert.equal(outOfScope.rows[0].state,null);
  });
  await t.test('acceptance failure rolls back every row and emits no acknowledgement', async () => {
    const before = Number((await owner!.query('SELECT count(*) FROM memories')).rows[0].count);
    await owner!.query(`CREATE FUNCTION reject_ingestion_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected acceptance crash'; END $$;
      CREATE TRIGGER reject_ingestion_test BEFORE INSERT ON memory_ingestion_jobs FOR EACH ROW EXECUTE FUNCTION reject_ingestion_test()`);
    try { await assert.rejects(acceptMemory(input('rollback boundary'),auth,agent),/injected acceptance crash/); }
    finally { await owner!.query('DROP TRIGGER reject_ingestion_test ON memory_ingestion_jobs; DROP FUNCTION reject_ingestion_test()'); }
    assert.equal(Number((await owner!.query('SELECT count(*) FROM memories')).rows[0].count),before);
  });
  await t.test('duplicate finalize, crash after embedding and stale token cannot repeat side effects', async () => {
    const accepted = await acceptMemory(input('fenced payload'),auth,agent); const first = await claim(accepted.id);
    await owner!.query("UPDATE memory_ingestion_jobs SET lease_expires_at = now() - interval '1 second' WHERE memory_id=$1",[accepted.id]);
    const second = await claim(accepted.id);
    assert.notEqual(second.lease_token,first.lease_token);
    assert.equal(await finalizeIngestionJob(first,embedding),null);
    const ready = await finalizeIngestionJob(second,embedding); assert.equal(ready?.state,'ready');
    assert.equal(await finalizeIngestionJob(second,embedding),null);
    const audits = await owner!.query("SELECT count(*)::int AS n FROM audit_log WHERE memory_id=$1 AND action='memory.ingest.ready'",[accepted.id]);
    assert.equal(audits.rows[0].n,1);
  });
  await t.test('key reuse preserves identity, fences processing changes and keeps ready identical content', async () => {
    const first = await acceptMemory(input('key initial',{ idempotency_key: 'stable' }),auth,agent);
    const same = await acceptMemory(input('key initial',{ idempotency_key: 'stable' }),auth,agent); assert.equal(same.id,first.id);
    const old = await claim(first.id);
    const replaced = await acceptMemory(input('key replacement',{ idempotency_key: 'stable', namespace: 'private' }),auth,agent); assert.equal(replaced.id,first.id);
    assert.equal(await finalizeIngestionJob(old,embedding),null);
    const job = await claim(first.id); assert.equal(job.namespace,'private'); assert.equal(job.attempts,0);
    assert.ok(await finalizeIngestionJob(job,embedding));
    const ready = await acceptMemory(input('key replacement',{ idempotency_key: 'stable', namespace: 'private', tags: ['refresh'] }),auth,agent);
    assert.equal(ready.state,'ready'); assert.equal(ready.id,first.id); assert.equal(await claimIngestionJob(dbScopeFromAuth(auth),{ memoryId:first.id,inline:true }),null);
    const changed = await acceptMemory(input('ready replacement',{ idempotency_key: 'stable', namespace: 'private' }),auth,agent); assert.equal(changed.state,'queued');
    await failIngestionJob(await claim(first.id),new Error('private detail')); const retry = await acceptMemory(input('ready replacement',{ idempotency_key: 'stable', namespace: 'private' }),auth,agent); assert.equal(retry.id,first.id);
  });
  await t.test('TTL begins at acceptance and expiry cancels claim/finalize without vector writes', async () => {
    const a = await acceptMemory(input('ttl claim',{ ttl: 20 }),auth,agent);
    const ttl = (await owner!.query('SELECT EXTRACT(EPOCH FROM expires_at-created_at)::int AS ttl FROM memories WHERE id=$1',[a.id])).rows[0].ttl; assert.equal(ttl,20);
    await owner!.query("UPDATE memories SET expires_at=now()-interval '1 second' WHERE id=$1",[a.id]);
    assert.equal(await claimIngestionJob(dbScopeFromAuth(auth),{ memoryId:a.id,inline:true }),null);
    assert.equal((await owner!.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1',[a.id])).rows[0].status,'cancelled');
    const b = await acceptMemory(input('ttl finalize',{ ttl: 20 }),auth,agent); const job = await claim(b.id);
    await owner!.query("UPDATE memories SET expires_at=now()-interval '1 second' WHERE id=$1",[b.id]);
    assert.equal(await finalizeIngestionJob(job,embedding),null);
  });
  await t.test('semantic dedupe boosts exactly once and accepted id recalls canonical content', async () => {
    const a = await acceptMemory(input('canonical candidate',{ namespace:'private' }),auth,agent); await finalizeIngestionJob(await claim(a.id),embedding);
    const b = await acceptMemory(input('duplicate candidate',{ namespace:'private',dedupe:true }),auth,agent); const job = await claim(b.id);
    const result = await finalizeIngestionJob(job,embedding); assert.equal(result?.deduplicated,true); assert.equal(result?.id,a.id);
    assert.equal(await finalizeIngestionJob(job,embedding),null);
    const recalled = await memoryRecall({ id:b.id },auth); assert.equal(recalled.id,a.id); assert.equal(recalled.ingestion.canonical_memory_id,a.id);
    assert.equal((await owner!.query('SELECT access_count FROM memories WHERE id=$1',[a.id])).rows[0].access_count,1);
  });
  await t.test('profile mismatch is terminal and forget cascade makes late finalize a no-op', async () => {
    const a = await acceptMemory(input('wrong space'),auth,agent); const job = await claim(a.id);
    assert.equal(await finalizeIngestionJob(job,{ ...embedding,model:'wrong' }),null);
    assert.equal((await owner!.query('SELECT failure_category FROM memory_ingestion_jobs WHERE memory_id=$1',[a.id])).rows[0].failure_category,'space_mismatch');
    const b = await acceptMemory(input('forgotten boundary'),auth,agent); const deleted = await claim(b.id);
    await owner!.query('DELETE FROM memories WHERE id=$1',[b.id]); assert.equal(await finalizeIngestionJob(deleted,embedding),null);
    assert.equal((await owner!.query('SELECT * FROM memory_ingestion_jobs WHERE memory_id=$1',[b.id])).rows.length,0);
  });
  await t.test('max attempts leaves content intact; admin requeue and pause/heartbeat are scoped and audited', async () => {
    process.env.MEMORY_INGESTION_MAX_ATTEMPTS='1';
    const a = await acceptMemory(input('retry retained'),auth,agent); const inline = await claim(a.id);
    await failIngestionJob({ ...inline, inline:false,attempts:1 },new Error('private content in exception'));
    assert.equal((await owner!.query('SELECT status,last_error_code FROM memory_ingestion_jobs WHERE memory_id=$1',[a.id])).rows[0].status,'embedding_failed');
    await assert.rejects(requeueIngestionJob(a.id,auth),/Permission denied/); await requeueIngestionJob(a.id,admin);
    await setIngestionPaused(true,admin); assert.equal(await claimIngestionJob(dbScopeFromAuth(admin)),null);
    const stats = await ingestionStats(admin); assert.equal(stats.paused,true); assert.ok(stats.last_worker_heartbeat); assert.doesNotMatch(JSON.stringify(stats),/retry retained|private content/);
    await setIngestionPaused(false,admin);
    const narrow = await claimIngestionJob({ keyId:adminId,namespaces:['absent'],isAdmin:true }); assert.equal(narrow,null);
    const b = await acceptMemory(input('worker attempt',{ namespace:'private' }),auth,agent);
    // Explicitly advance only this job so claim order is deterministic.
    await owner!.query("UPDATE memory_ingestion_jobs SET next_attempt_at=now()+interval '1 day' WHERE memory_id<>$1 AND status IN ('pending','retry_wait')",[b.id]);
    const worker = await claimIngestionJob(dbScopeFromAuth(admin)); assert.ok(worker); assert.equal(worker.memory_id,b.id); assert.equal(worker.attempts,1);
    await failIngestionJob(worker,new Error('connection')); assert.equal((await owner!.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1',[b.id])).rows[0].status,'embedding_failed');
  });
  await t.test('HTTP inline budget is independent of provider timeout and happy path remains ready', async () => {
    const { app } = await import('../src/server.js');
    process.env.MEMORY_STORE_INLINE_EMBED_MS='40';
    t.mock.method(globalThis,'fetch',async () => { await new Promise(resolve => setTimeout(resolve,500)); return new Response(JSON.stringify({ embedding:{ values:vector } })); });
    const start = Date.now(); const queued = await request(app).post('/api/store').set('Authorization','Bearer owner').send({ content:'http durable latency',agent_name:'http',dedupe:false });
    assert.equal(queued.status,200,JSON.stringify(queued.body)); assert.equal(queued.body.state,'queued'); assert.ok(Date.now()-start<400); assert.ok(queued.body.accepted_at);
    t.mock.restoreAll();
    t.mock.method(globalThis,'fetch',async () => new Response(JSON.stringify({ embedding:{ values:vector } })));
    process.env.MEMORY_STORE_INLINE_EMBED_MS='1000';
    const ready = await request(app).post('/api/store').set('Authorization','Bearer owner').send({ content:'http healthy',agent_name:'http',dedupe:false }); assert.equal(ready.body.state,'ready',JSON.stringify(ready.body));
    const forbidden = await request(app).get('/api/ingestion/stats').set('Authorization','Bearer owner'); assert.equal(forbidden.status,403);
    const stats = await request(app).get('/api/ingestion/stats').set('Authorization','Bearer worker'); assert.equal(stats.status,200);
  });
});
