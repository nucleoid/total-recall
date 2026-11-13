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
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
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
    VALUES ($1,$2,$3,$4,$5,$6)`, [key.keyId,hashKey(`tr_${key.name}`),key.name,key.namespaces,key.permissions,key.maxAccessLevel]);
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
    try { await assert.rejects(acceptMemory(input('rollback boundary'),auth,agent),/Durable memory acceptance unavailable/); }
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
  await t.test('belief revision finalizes the existing accepted row atomically', async () => {
    const { commitAutomaticRevision } = await import('../src/contradictions.js');
    const predecessor = await acceptMemory(input('previous belief',{ namespace:'private' }),auth,agent);
    await finalizeIngestionJob(await claim(predecessor.id),embedding);
    const successor = await acceptMemory(input('replacement belief',{ namespace:'private' }),auth,agent);
    const before = Number((await owner!.query('SELECT count(*) FROM memories')).rows[0].count);
    await withScopedClient(dbScopeFromAuth(auth), async client => {
      const result = await commitAutomaticRevision({ content:'replacement belief',vector:JSON.stringify(vector),source:'owner',
        namespace:'private',tags:[],metadata:{},accessLevel:'normal',clientId:ownerId,agentId:agent,sessionId:null },
        predecessor.id,auth,{ id:successor.id,client });
      assert.equal(result?.id,successor.id);
    });
    const revised = (await owner!.query('SELECT supersedes_id,embedding IS NOT NULL AS embedded FROM memories WHERE id=$1',[successor.id])).rows[0];
    assert.equal(revised.supersedes_id,predecessor.id); assert.equal(revised.embedded,true);
    assert.equal(Number((await owner!.query('SELECT count(*) FROM memories')).rows[0].count),before);
    assert.ok((await owner!.query('SELECT superseded_at FROM memories WHERE id=$1',[predecessor.id])).rows[0].superseded_at);
  });
  await t.test('subscription creation event fires exactly once on ready; #161 excludes episode chunks', async () => {
    const subscription = (await owner!.query(`INSERT INTO memory_subscriptions
      (api_key_id,query_text,query_embedding,embedding_provider,embedding_model,embedding_dimensions,threshold,exclude_self,
       webhook_url_ciphertext,webhook_url_iv,webhook_url_tag,signing_secret_ciphertext,signing_secret_iv,signing_secret_tag,
       encryption_key_id,idempotency_key,request_hash)
      VALUES ($1,'fixture',$2::vector,$3,$4,768,0.5,false,'x',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),
        'x',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'test','once',repeat('a',64)) RETURNING id`,
      [otherId,JSON.stringify(vector),embedding.provider,embedding.model])).rows[0].id;
    await owner!.query('INSERT INTO subscription_namespaces(subscription_id,api_key_id,namespace) VALUES ($1,$2,$3)',[subscription,otherId,'shared']);
    await owner!.query('ALTER TABLE memories ENABLE TRIGGER memories_subscription_enqueue; ALTER TABLE memories ENABLE TRIGGER memories_subscription_ready_enqueue');
    const a = await acceptMemory(input('notify once'),auth,agent); const job = await claim(a.id);
    assert.equal((await owner!.query('SELECT * FROM webhook_deliveries WHERE memory_id=$1',[a.id])).rows.length,0);
    await finalizeIngestionJob(job,embedding); await finalizeIngestionJob(job,embedding);
    assert.equal((await owner!.query('SELECT * FROM webhook_deliveries WHERE memory_id=$1',[a.id])).rows.length,1);
    const b = await acceptMemory(input('episode never notifies'),auth,agent);
    await owner!.query("UPDATE memories SET memory_kind='episode_chunk' WHERE id=$1",[b.id]);
    await finalizeIngestionJob(await claim(b.id),embedding);
    assert.equal((await owner!.query('SELECT * FROM webhook_deliveries WHERE memory_id=$1',[b.id])).rows.length,0);
    const c = await acceptMemory(input('secret never notifies',{ access_level:'secret' }),auth,agent);
    await finalizeIngestionJob(await claim(c.id),embedding);
    assert.equal((await owner!.query('SELECT * FROM webhook_deliveries WHERE memory_id=$1',[c.id])).rows.length,0);
  });
  await t.test('#161 permits admin owner-attributed jobs; revoking accepting key does not orphan durable content', async () => {
    const a = await acceptMemory(input('owner accepted before revocation'),auth,agent);
    const job = await claim(a.id);
    await owner!.query('UPDATE api_keys SET enabled=false WHERE id=$1',[ownerId]);
    try { assert.equal((await finalizeIngestionJob(job,embedding))?.state,'ready'); }
    finally { await owner!.query('UPDATE api_keys SET enabled=true WHERE id=$1',[ownerId]); }
    const b = (await owner!.query(`INSERT INTO memories(content,source,namespace,client_id,memory_kind,valid_from)
      VALUES ('future session fact','test','shared',$1,'semantic',now()) RETURNING id`,[ownerId])).rows[0].id;
    await withScopedClient(dbScopeFromAuth(admin),client => client.query(`INSERT INTO memory_ingestion_jobs
      (memory_id,namespace,client_id,access_level,allowed_namespaces,dedupe,contradiction_eligible,embedding_provider,embedding_model,embedding_dimensions)
      VALUES ($1,'shared',$2,'normal',ARRAY['shared'],false,false,$3,$4,768)`,[b,ownerId,embedding.provider,embedding.model]));
    await assert.rejects(withScopedClient(dbScopeFromAuth(other),client => client.query(`INSERT INTO memory_ingestion_jobs
      (memory_id,namespace,client_id,access_level,allowed_namespaces,dedupe,contradiction_eligible,embedding_provider,embedding_model,embedding_dimensions)
      VALUES (gen_random_uuid(),'shared',$1,'normal',ARRAY['shared'],false,false,$2,$3,768)`,[ownerId,embedding.provider,embedding.model])),/row-level security/);
  });
  await t.test('a failure after vector/outbox work rolls back the whole finalization transaction', async () => {
    const a = await acceptMemory(input('finalize atomic boundary'),auth,agent); const job = await claim(a.id);
    await owner!.query(`CREATE FUNCTION reject_ready_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='memory.ingest.ready' THEN RAISE EXCEPTION 'injected finalization crash'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_ready_audit_test BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_ready_audit_test()`);
    try { await assert.rejects(finalizeIngestionJob(job,embedding),/injected finalization crash/); }
    finally { await owner!.query('DROP TRIGGER reject_ready_audit_test ON audit_log; DROP FUNCTION reject_ready_audit_test()'); }
    const state = (await owner!.query(`SELECT m.embedding,j.status FROM memories m JOIN memory_ingestion_jobs j ON j.memory_id=m.id WHERE m.id=$1`,[a.id])).rows[0];
    assert.equal(state.embedding,null); assert.equal(state.status,'processing');
    assert.equal((await owner!.query('SELECT * FROM webhook_deliveries WHERE memory_id=$1',[a.id])).rows.length,0);
    assert.equal((await finalizeIngestionJob(job,embedding))?.state,'ready');
    assert.equal((await owner!.query('SELECT * FROM webhook_deliveries WHERE memory_id=$1',[a.id])).rows.length,1);
  });
  await t.test('real worker bounds concurrent providers and recovers scripted 429/500 failures', async () => {
    const { runIngestionWorker } = await import('../scripts/ingestion-worker.js');
    process.env.INGESTION_WORKER_API_KEY='tr_worker'; process.env.MEMORY_INGESTION_MAX_ATTEMPTS='12';
    await owner!.query("UPDATE memory_ingestion_jobs SET next_attempt_at=now()+interval '1 day' WHERE status IN ('pending','retry_wait')");
    const jobs = await Promise.all([acceptMemory(input('worker one'),auth,agent),acceptMemory(input('worker two'),auth,agent)]);
    let active=0,maxActive=0,calls=0;
    t.mock.method(globalThis,'fetch',async () => {
      active++; maxActive=Math.max(maxActive,active); const call=calls++;
      await new Promise(resolve => setTimeout(resolve,100)); active--;
      return new Response('provider body stays private',{ status:call===0 ? 429 : 500, headers:{'Retry-After':'123'} });
    });
    try {
      const first = await runIngestionWorker({ once:true,maxJobs:2,pollMs:100,concurrency:2 },new AbortController().signal);
      assert.equal(first.processed,2); assert.equal(calls,2); assert.equal(maxActive,2);
      const failures = (await owner!.query('SELECT status,attempts,next_attempt_at,last_error_code FROM memory_ingestion_jobs WHERE memory_id=ANY($1::uuid[])',[jobs.map(j=>j.id)])).rows;
      assert.ok(failures.every(j=>j.status==='retry_wait' && j.attempts===1 && new Date(j.next_attempt_at).getTime()>Date.now()+59000));
      await owner!.query('UPDATE memory_ingestion_jobs SET next_attempt_at=now() WHERE memory_id=ANY($1::uuid[])',[jobs.map(j=>j.id)]);
      t.mock.restoreAll();
      t.mock.method(globalThis,'fetch',async () => new Response(JSON.stringify({ embedding:{ values:vector } })));
      const second = await runIngestionWorker({ once:true,maxJobs:2,pollMs:100,concurrency:2 },new AbortController().signal);
      assert.equal(second.processed,2);
      const ready = (await owner!.query('SELECT status,attempts FROM memory_ingestion_jobs WHERE memory_id=ANY($1::uuid[])',[jobs.map(j=>j.id)])).rows;
      assert.ok(ready.every(j=>j.status==='ready' && j.attempts===2));
    } finally { t.mock.restoreAll(); delete process.env.INGESTION_WORKER_API_KEY; }
  });
  await t.test('HTTP inline budget is independent of provider timeout and happy path remains ready', async () => {
    const { app } = await import('../src/server.js');
    process.env.MEMORY_STORE_INLINE_EMBED_MS='40';
    t.mock.method(globalThis,'fetch',async () => { await new Promise(resolve => setTimeout(resolve,1500)); return new Response(JSON.stringify({ embedding:{ values:vector } })); });
    const start = Date.now(); const queued = await request(app).post('/api/store').set('Authorization','Bearer tr_owner').send({ content:'http durable latency',agent_name:'http',dedupe:false });
    assert.equal(queued.status,200,JSON.stringify(queued.body)); assert.equal(queued.body.state,'queued'); assert.ok(Date.now()-start<1000); assert.ok(queued.body.accepted_at);
    t.mock.restoreAll();
    t.mock.method(globalThis,'fetch',async () => new Response(JSON.stringify({ embedding:{ values:vector } })));
    process.env.MEMORY_STORE_INLINE_EMBED_MS='1000';
    const ready = await request(app).post('/api/store').set('Authorization','Bearer tr_owner').send({ content:'http healthy',agent_name:'http',dedupe:false }); assert.equal(ready.body.state,'ready',JSON.stringify(ready.body));
    await owner!.query(`CREATE FUNCTION reject_http_acceptance_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private database failure'; END $$;
      CREATE TRIGGER reject_http_acceptance_test BEFORE INSERT ON memory_ingestion_jobs FOR EACH ROW EXECUTE FUNCTION reject_http_acceptance_test()`);
    try {
      const unavailable = await request(app).post('/api/store').set('Authorization','Bearer tr_owner').send({ content:'must not acknowledge',agent_name:'http',dedupe:false });
      assert.equal(unavailable.status,503); assert.equal(unavailable.body.code,'ingestion_persistence_unavailable');
      assert.doesNotMatch(JSON.stringify(unavailable.body),/private database failure|must not acknowledge/);
    } finally { await owner!.query('DROP TRIGGER reject_http_acceptance_test ON memory_ingestion_jobs; DROP FUNCTION reject_http_acceptance_test()'); }
    const forbidden = await request(app).get('/api/ingestion/stats').set('Authorization','Bearer tr_owner'); assert.equal(forbidden.status,403);
    const stats = await request(app).get('/api/ingestion/stats').set('Authorization','Bearer tr_worker'); assert.equal(stats.status,200);
  });
});

