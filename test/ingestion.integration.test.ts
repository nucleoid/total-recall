import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import request from 'supertest';
import { loadMigrationInventory, runMigrations } from '../scripts/migrate.js';
import { provisionDatabase } from '../scripts/provision-db.js';
import { setPoolForTesting, withScopedClient, dbScopeFromAuth } from '../src/db.js';
import { hashKey, validateKey } from '../src/auth.js';
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

function faultingPool(pool: pg.Pool, fail: (sql: string) => boolean): pg.Pool {
  return { query: pool.query.bind(pool), connect: async () => {
    const client = await pool.connect();
    return { release:(error?: Error) => client.release(error), query: async (sql: string, values?: unknown[]) => {
      if (fail(sql)) throw new Error('injected private database boundary');
      return client.query(sql,values);
    } };
  } } as unknown as pg.Pool;
}

// This suite deliberately fails rather than skips when PostgreSQL evidence is unavailable.
test('durable ingestion on isolated PostgreSQL: leases, RLS, recovery and visibility', { timeout: 180000 }, async t => {
  execFileSync('docker', ['version'], { stdio: 'ignore' });
  // Ask the Windows host for a bindable port before Docker publishes it.
  const hostPort = await new Promise<number>((resolve,reject)=>{
    const server=createServer(); server.once('error',reject); server.listen(0,'127.0.0.1',()=>{
      const port=(server.address() as {port:number}).port;
      server.close(error=>error ? reject(error) : resolve(port));
    });
  });
  const container = execFileSync('docker', ['run','--rm','-d','-e','POSTGRES_PASSWORD=test-only','-p',`127.0.0.1:${hostPort}:5432`, process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16'], { encoding: 'utf8' }).trim();
  let owner: pg.Client | undefined;
  let pool: pg.Pool | undefined;
  t.after(async () => {
    setPoolForTesting(null); await pool?.end(); await owner?.end();
    execFileSync('docker',['rm','-f',container], { stdio: 'ignore' });
    delete process.env.MEMORY_INGESTION_QUEUE_ENABLED; delete process.env.MEMORY_STORE_INLINE_EMBED_MS;
    delete process.env.MEMORY_INGESTION_MAX_ATTEMPTS;
  });
  const port = hostPort;
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
  await t.test('identical keyed retry preserves content/vector pairing against a synchronous writer', async () => {
    const a=await acceptMemory(input('key race original',{idempotency_key:'sync-writer-race'}),auth,agent);
    await finalizeIngestionJob(await claim(a.id),embedding);
    const replacement=Array.from({length:768},(_,i)=>i===40?1:0);
    let readReached!:()=>void;let resumeRead!:()=>void;
    const reached=new Promise<void>(resolve=>{readReached=resolve;});
    const resume=new Promise<void>(resolve=>{resumeRead=resolve;});
    setPoolForTesting({query:pool!.query.bind(pool!),connect:async()=>{
      const client=await pool!.connect();
      return {release:(error?:Error)=>client.release(error),query:async(sql:string,values?:unknown[])=>{
        const result=await client.query(sql,values);
        if(sql.startsWith('SELECT content, namespace, access_level FROM memories')) {readReached();await resume;}
        return result;
      }};
    }} as unknown as pg.Pool);
    const writer=new pg.Client({connectionString:url});await writer.connect();
    let retry:ReturnType<typeof acceptMemory>|undefined;let write:Promise<unknown>|undefined;
    try {
      retry=acceptMemory(input('key race original',{idempotency_key:'sync-writer-race'}),auth,agent);
      await reached;
      const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let finished=false;
      write=writer.query('UPDATE memories SET content=$2,embedding=$3::vector WHERE id=$1',
        [a.id,'key race replacement',JSON.stringify(replacement)]).then(()=>{finished=true;});
      // The old implementation lets this commit between its stale read and upsert.
      // A correct implementation either locks that read or resets the vector atomically.
      let waiting=false;
      for(let i=0;i<100;i++) {
        waiting=(await owner!.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting===true;
        if(finished||waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.ok(finished||waiting,'synchronous writer must commit or reach the row-lock barrier');
      resumeRead();await retry;await write;
      const row=(await owner!.query('SELECT content,embedding::text AS embedding FROM memories WHERE id=$1',[a.id])).rows[0];
      assert.deepEqual(JSON.parse(row.embedding),row.content==='key race original'?vector:replacement,
        'a ready vector must belong to the content committed with it');
      assert.equal((await owner!.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1',[a.id])).rows[0].status,'ready');
    } finally {resumeRead();await retry?.catch(()=>undefined);await write?.catch(()=>undefined);setPoolForTesting(pool!);await writer.end();}
  });
  await t.test('database contention rolls back and retries without spending provider attempts', async () => {
    process.env.MEMORY_INGESTION_MAX_ATTEMPTS='1';
    await owner!.query(`CREATE FUNCTION ingestion_contention_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE=TG_ARGV[0], MESSAGE='private SQL content'; END $$`);
    try {
      for(const inline of [true,false]) for(const code of ['55P03','57014','40P01','40001']) {
        const a=await acceptMemory(input(`database contention ${inline} ${code}`),auth,agent);
        const job=await claimIngestionJob(dbScopeFromAuth(inline?auth:admin),{memoryId:a.id,inline});assert.ok(job);
        await owner!.query(`CREATE TRIGGER ingestion_contention_test BEFORE UPDATE OF embedding ON memories
          FOR EACH ROW WHEN (NEW.id='${a.id}') EXECUTE FUNCTION ingestion_contention_test('${code}')`);
        let failure:unknown;
        try {await finalizeIngestionJob(job,embedding);}
        catch(error) {failure=error;}
        finally {await owner!.query('DROP TRIGGER ingestion_contention_test ON memories');}
        assert.equal((failure as {code:string})?.code,code);
        assert.equal((await owner!.query('SELECT embedding FROM memories WHERE id=$1',[a.id])).rows[0].embedding,null);
        await failIngestionJob(job,failure);
        const row=(await owner!.query(`SELECT status,attempts,last_error_code,
          EXTRACT(EPOCH FROM next_attempt_at-now())*1000 AS delay FROM memory_ingestion_jobs WHERE memory_id=$1`,[a.id])).rows[0];
        assert.equal(row.status,inline?'pending':'retry_wait');assert.equal(row.attempts,0);
        assert.equal(row.last_error_code,'db_contention');
        assert.ok(inline?Number(row.delay)<=0:Number(row.delay)>0&&Number(row.delay)<=1500);
        await owner!.query('UPDATE memory_ingestion_jobs SET next_attempt_at=now() WHERE memory_id=$1',[a.id]);
        const recovery=await claimIngestionJob(dbScopeFromAuth(admin),{memoryId:a.id});assert.ok(recovery);
        assert.equal((await finalizeIngestionJob(recovery,embedding))?.state,'ready');
        // Replayed failure from the old token must not change the recovered generation.
        await failIngestionJob(job,failure);
        assert.equal((await owner!.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1',[a.id])).rows[0].status,'ready');
      }
    } finally {await owner!.query('DROP FUNCTION ingestion_contention_test()');process.env.MEMORY_INGESTION_MAX_ATTEMPTS='12';}
  });
  await t.test('identical retries retain the accepted security/provenance and embedding-target snapshot', async () => {
    const a = await acceptMemory(input('immutable snapshot',{ idempotency_key:'snapshot' }),auth,agent);
    await owner!.query("UPDATE memory_ingestion_jobs SET embedding_model='original-accepted-model' WHERE memory_id=$1",[a.id]);
    await acceptMemory(input('immutable snapshot',{ idempotency_key:'snapshot' }),auth,agent);
    const snapshot = (await owner!.query('SELECT embedding_model,accepted_at FROM memory_ingestion_jobs WHERE memory_id=$1',[a.id])).rows[0];
    assert.equal(snapshot.embedding_model,'original-accepted-model'); assert.equal(snapshot.accepted_at.toISOString(),a.accepted_at!.toISOString());
    await acceptMemory(input('new generation',{ idempotency_key:'snapshot' }),auth,agent);
    assert.equal((await owner!.query('SELECT embedding_model FROM memory_ingestion_jobs WHERE memory_id=$1',[a.id])).rows[0].embedding_model,embedding.model);
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
  await t.test('classifier preparation holds no row or namespace locks and concurrent revisions revalidate one predecessor', async () => {
    const { contradictionPolicyFromEnv } = await import('../src/contradictions.js');
    const policy = { ...contradictionPolicyFromEnv(),classificationEnabled:true,namespace:'private',mutationEnabled:true };
    const concurrentEmbedding={...embedding,vector:Array.from({length:768},(_,i)=>i===15 ? 1 : 0)};
    const predecessor = await acceptMemory(input('concurrent predecessor',{ namespace:'private' }),auth,agent);
    await finalizeIngestionJob(await claim(predecessor.id),concurrentEmbedding);
    const accepted = await Promise.all([acceptMemory(input('revision a',{ namespace:'private',dedupe:true }),auth,agent),acceptMemory(input('revision b',{ namespace:'private',dedupe:true }),auth,agent)]);
    const jobs = await Promise.all(accepted.map(a=>claim(a.id)));
    let prepared=0; let release!:()=>void; const barrier=new Promise<void>(resolve=>{ release=resolve; });
    const prepare = async () => {
      prepared++; if (prepared===2) release(); await barrier; return predecessor.id;
    };
    const results = await Promise.all(jobs.map(job=>finalizeIngestionJob(job,concurrentEmbedding,{ contradictionPolicy:policy,
      prepareRevision:async () => {
        const lock = (await owner!.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
          ['memory-store-dedupe:'+JSON.stringify(['private','normal'])])).rows[0].acquired;
        assert.equal(lock,true); await owner!.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['memory-store-dedupe:'+JSON.stringify(['private','normal'])]);
        // Both preparations must enter before either completion can proceed.
        return prepare();
      } })));
    assert.equal(prepared,2); assert.ok(results.every(result=>result?.state==='ready'));
    assert.equal(results.filter(result=>result?.deduplicated).length,1);
    assert.equal(new Set(results.map(result=>result?.id)).size,1,'the losing revision deduplicates to the committed successor');
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM memories WHERE supersedes_id=$1',[predecessor.id])).rows[0].n,1);
  });
  await t.test('stale revision constraint rolls back only its savepoint and still finalizes', async () => {
    const { contradictionPolicyFromEnv } = await import('../src/contradictions.js');
    const a=await acceptMemory(input('savepoint predecessor',{ namespace:'private' }),auth,agent); await finalizeIngestionJob(await claim(a.id),embedding);
    const b=await acceptMemory(input('savepoint successor',{ namespace:'private' }),auth,agent); const job=await claim(b.id);
    await owner!.query(`CREATE FUNCTION stale_revision_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.supersedes_id IS NOT NULL THEN RAISE EXCEPTION 'stale revision' USING ERRCODE='23505'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER stale_revision_test BEFORE UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION stale_revision_test()`);
    try { assert.equal((await finalizeIngestionJob(job,embedding,{ contradictionPolicy:{ ...contradictionPolicyFromEnv(),classificationEnabled:true,namespace:'private',mutationEnabled:true }, prepareRevision:async()=>a.id }))?.state,'ready'); }
    finally { await owner!.query('DROP TRIGGER stale_revision_test ON memories; DROP FUNCTION stale_revision_test()'); }
    assert.equal((await owner!.query('SELECT superseded_at FROM memories WHERE id=$1',[a.id])).rows[0].superseded_at,null);
    assert.equal((await owner!.query('SELECT supersedes_id FROM memories WHERE id=$1',[b.id])).rows[0].supersedes_id,null);
  });
  await t.test('legacy embedding writers preserve their current row without queue dedupe or revision', async () => {
    const a=await acceptMemory(input('legacy accepted',{ dedupe:true }),auth,agent); const job=await claim(a.id);
    await owner!.query('UPDATE memories SET content=$2,embedding=$3::vector,embedding_provider=$4,embedding_model=$5,embedding_dimensions=768 WHERE id=$1',
      [a.id,'legacy edit wins',JSON.stringify(vector),embedding.provider,embedding.model]);
    assert.equal((await finalizeIngestionJob(job,embedding))?.state,'ready');
    const row=(await owner!.query('SELECT content,deleted_at,supersedes_id FROM memories WHERE id=$1',[a.id])).rows[0];
    assert.equal(row.content,'legacy edit wins'); assert.equal(row.deleted_at,null); assert.equal(row.supersedes_id,null);
    const b=await acceptMemory(input('already embedded before claim',{ dedupe:true }),auth,agent);
    await owner!.query('UPDATE memories SET embedding=$2::vector,embedding_provider=$3,embedding_model=$4,embedding_dimensions=768 WHERE id=$1',[b.id,JSON.stringify(vector),embedding.provider,embedding.model]);
    assert.equal(await claimIngestionJob(dbScopeFromAuth(auth),{ memoryId:b.id,inline:true }),null);
    assert.equal((await owner!.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1',[b.id])).rows[0].status,'ready');
  });
  await t.test('reembedding skips active jobs and historical null vectors produce no creation events', async () => {
    const { reembedWithClient } = await import('../scripts/reembed-all.js');
    const active=await acceptMemory(input('active job must stay queued'),auth,agent);
    const historical=(await owner!.query(`INSERT INTO memories(content,source,namespace,client_id,memory_kind,valid_from,created_at)
      VALUES ('historical null vector','test','shared',$1,'semantic',now()-interval '1 year',now()-interval '1 year') RETURNING id`,[ownerId])).rows[0].id;
    const embeddedTexts:string[]=[];
    await reembedWithClient(owner!,async texts=>{ embeddedTexts.push(...texts); return texts.map(()=>vector); },{ namespaces:['shared'],delayMs:0,provider:embedding.provider,model:embedding.model,dimensions:768 });
    assert.ok(embeddedTexts.includes('historical null vector')); assert.ok(!embeddedTexts.includes('active job must stay queued'));
    assert.equal((await owner!.query('SELECT embedding FROM memories WHERE id=$1',[active.id])).rows[0].embedding,null);
    assert.equal((await owner!.query('SELECT * FROM webhook_deliveries WHERE memory_id=$1',[historical])).rows.length,0);
  });
  await t.test('continuous worker backs off after one claim failure and resumes draining', async () => {
    const { runIngestionWorker }=await import('../scripts/ingestion-worker.js');
    await owner!.query("UPDATE memory_ingestion_jobs SET next_attempt_at=now()+interval '1 day' WHERE status IN ('pending','retry_wait')");
    const a=await acceptMemory(input('worker survives database blip'),auth,agent);
    let faults=0;
    setPoolForTesting(faultingPool(pool!,sql=>sql.includes('WITH candidate AS') && faults++===0));
    process.env.INGESTION_WORKER_API_KEY='tr_worker';
    t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({ embedding:{values:vector} })));
    try { assert.equal((await runIngestionWorker({ once:false,maxJobs:1,pollMs:100,concurrency:1 },new AbortController().signal)).processed,1); }
    finally { setPoolForTesting(pool!); delete process.env.INGESTION_WORKER_API_KEY; t.mock.restoreAll(); }
    assert.equal((await owner!.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1',[a.id])).rows[0].status,'ready');
  });
  await t.test('rollback acceptance gate preserves deduplicated aliases and pending visibility', async () => {
    const a=await acceptMemory(input('rollback canonical',{ namespace:'private' }),auth,agent); await finalizeIngestionJob(await claim(a.id),embedding);
    const b=await acceptMemory(input('rollback duplicate',{ namespace:'private',dedupe:true }),auth,agent);
    const result=await finalizeIngestionJob(await claim(b.id),embedding); assert.equal(result?.deduplicated,true);
    const pending=await acceptMemory(input('rollback still pending'),auth,agent);
    delete process.env.MEMORY_INGESTION_QUEUE_ENABLED;
    try {
      const recalled=await memoryRecall({id:b.id},auth); assert.equal(recalled.id,result!.id); assert.equal(recalled.ingestion.state,'deduplicated');
      assert.equal((await memoryRecall({id:pending.id},auth)).ingestion.state,'pending');
      const exported=await exportMemoryPage(exportPageSchema.parse({}),auth);
      assert.equal(exported.records.find(row=>row.provenance.memory_id===pending.id)?.ingestion_state,'pending');
    } finally { process.env.MEMORY_INGESTION_QUEUE_ENABLED='true'; }
  });
  await t.test('accepted scope survives removal of the owner write permission and namespaces', async () => {
    const a=await acceptMemory(input('accepted before ACL removal'),auth,agent); const job=await claim(a.id);
    await owner!.query("UPDATE api_keys SET permissions=ARRAY['read'],namespaces=ARRAY['private'] WHERE id=$1",[ownerId]);
    try { assert.equal((await finalizeIngestionJob(job,embedding))?.state,'ready'); }
    finally { await owner!.query('UPDATE api_keys SET permissions=$2,namespaces=$3 WHERE id=$1',[ownerId,auth.permissions,auth.namespaces]); }
  });
  await t.test('expired poison leases stop at the worker attempt cap without provider work', async () => {
    const a=await acceptMemory(input('poison lease'),auth,agent); await claim(a.id);
    process.env.MEMORY_INGESTION_MAX_ATTEMPTS='1';
    await owner!.query("UPDATE memory_ingestion_jobs SET attempts=1,lease_expires_at=now()-interval '1 second' WHERE memory_id=$1",[a.id]);
    try {
      assert.equal(await claimIngestionJob(dbScopeFromAuth(admin),{memoryId:a.id}),null);
      const row=(await owner!.query('SELECT status,failure_category,attempts FROM memory_ingestion_jobs WHERE memory_id=$1',[a.id])).rows[0];
      assert.equal(row.status,'embedding_failed'); assert.equal(row.failure_category,'transient'); assert.equal(row.attempts,1);
      assert.equal((await memoryRecall({id:a.id},auth)).content,'poison lease');
      const expired=await acceptMemory(input('expired poison lease',{ttl:20}),auth,agent); await claim(expired.id);
      await owner!.query("UPDATE memories SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);
      await owner!.query("UPDATE memory_ingestion_jobs SET attempts=1,lease_expires_at=now()-interval '1 second' WHERE memory_id=$1",[expired.id]);
      assert.equal(await claimIngestionJob(dbScopeFromAuth(admin),{memoryId:expired.id}),null);
      assert.equal((await owner!.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1',[expired.id])).rows[0].status,'cancelled');
    } finally { process.env.MEMORY_INGESTION_MAX_ATTEMPTS='12'; }
  });
  await t.test('inline budget exhaustion hands off immediately without consuming an attempt', async () => {
    const a=await acceptMemory(input('budget handoff'),auth,agent); const job=await claim(a.id);
    await failIngestionJob(job,new DOMException('budget exhausted','TimeoutError'));
    const row=(await owner!.query('SELECT status,attempts,next_attempt_at<=now() AS due FROM memory_ingestion_jobs WHERE memory_id=$1',[a.id])).rows[0];
    assert.equal(row.status,'pending'); assert.equal(row.attempts,0); assert.equal(row.due,true);
  });
  await t.test('approved near-duplicate corrections revise before dedupe for inline and worker claims', async () => {
    const { prepareBeliefRevision, resetContradictionRuntimeForTesting } = await import('../src/contradictions.js');
    await resetContradictionRuntimeForTesting();
    const policy = { classificationEnabled:true, mutationEnabled:true, provider:'test', model:'test', endpoint:'https://not-used.example', namespace:'private', timeoutMs:1000, mutationConfidence:0.95,
      budget:{limitMicroUsd:100n,requestMicroUsd:1n,inputMicroUsdPerMillionBytes:0n,outputMicroUsdPerMillionBytes:0n,fingerprint:'approved-priority'},shadowMaxInFlight:2,shadowMaxQueued:8 };
    try {
      for (const [mode, axis] of [['inline',6],['worker',7]] as const) {
        const exact = { ...embedding, vector:Array.from({length:768},(_,i)=>i===axis ? 1 : 0) };
        const predecessor = await acceptMemory(input(`${mode} previous belief`,{namespace:'private'}),auth,agent);
        await finalizeIngestionJob(await claim(predecessor.id),exact);
        const accepted = await acceptMemory(input(`${mode} approved correction`,{namespace:'private',dedupe:true}),auth,agent);
        const job = mode==='inline' ? await claim(accepted.id) : await claimIngestionJob(dbScopeFromAuth(admin),{memoryId:accepted.id});
        assert.ok(job);
        let calls=0;
        const prepare:typeof prepareBeliefRevision = (memory,context,options) => prepareBeliefRevision(memory,context,{...options,
          findCandidates:async()=>[{id:predecessor.id,content:`${mode} previous belief`,similarity:1}],
          provider:{name:'approved',generate:async()=>{
            calls++;
            assert.equal(pool!.idleCount,pool!.totalCount,'classification must release all pool sessions');
            assert.equal((await owner!.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='total_recall_app' AND xact_start IS NOT NULL")).rows[0].n,0);
            const key='memory-store-dedupe:'+JSON.stringify(['private','normal']);
            assert.equal((await owner!.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key])).rows[0].acquired,true);
            await owner!.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);
            await owner!.query('BEGIN');
            try {
              await owner!.query('SELECT id FROM memories WHERE id=ANY($1::uuid[]) FOR UPDATE NOWAIT',[[predecessor.id,accepted.id]]);
              await owner!.query('SELECT memory_id FROM memory_ingestion_jobs WHERE memory_id=$1 FOR UPDATE NOWAIT',[accepted.id]);
            } finally { await owner!.query('ROLLBACK'); }
            return JSON.stringify({classification:'contradiction',confidence:1,candidate_id:predecessor.id});
          }},
        });
        const options={contradictionPolicy:policy,prepareRevision:prepare};
        const result=await finalizeIngestionJob(job,exact,options);
        assert.equal(calls,1,'near-duplicate similarity must not suppress approved classification');
        assert.equal(result?.id,accepted.id); assert.equal(result?.deduplicated,false); assert.equal(result?.state,'ready');
        const successor=(await owner!.query('SELECT supersedes_id,deleted_at,embedding IS NOT NULL AS embedded FROM memories WHERE id=$1',[accepted.id])).rows[0];
        assert.deepEqual(successor,{supersedes_id:predecessor.id,deleted_at:null,embedded:true});
        assert.ok((await owner!.query('SELECT superseded_at FROM memories WHERE id=$1',[predecessor.id])).rows[0].superseded_at);
        assert.equal((await owner!.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1',[accepted.id])).rows[0].status,'ready');
        assert.equal(await finalizeIngestionJob(job,exact,options),null);
        assert.equal(calls,1,'repeated finalization must not classify or mutate again');
        assert.equal((await owner!.query("SELECT count(*)::int AS n FROM audit_log WHERE memory_id=$1 AND action='belief.supersede'",[accepted.id])).rows[0].n,1);
      }
    } finally { await resetContradictionRuntimeForTesting(); }
  });
  await t.test('no-match, low confidence, scope and budget gates fall back to normal dedupe', async () => {
    const { prepareBeliefRevision, resetContradictionRuntimeForTesting } = await import('../src/contradictions.js');
    const cases=['no_match','low_confidence','outside_scope','budget_exhausted'] as const;
    for (const [index,reason] of cases.entries()) {
      await resetContradictionRuntimeForTesting();
      const exact={...embedding,vector:Array.from({length:768},(_,i)=>i===index+8 ? 1 : 0)};
      const predecessor=await acceptMemory(input(`${reason} canonical`,{namespace:'private'}),auth,agent);
      await finalizeIngestionJob(await claim(predecessor.id),exact);
      const accepted=await acceptMemory(input(`${reason} duplicate`,{namespace:'private',dedupe:true}),auth,agent);
      const policy={classificationEnabled:true,mutationEnabled:true,provider:'test',model:'test',endpoint:'https://not-used.example',namespace:reason==='outside_scope'?'shared':'private',timeoutMs:1000,mutationConfidence:0.95,
        budget:{limitMicroUsd:100n,requestMicroUsd:reason==='budget_exhausted'?101n:1n,inputMicroUsdPerMillionBytes:0n,outputMicroUsdPerMillionBytes:0n,fingerprint:reason},shadowMaxInFlight:2,shadowMaxQueued:8};
      let calls=0;
      const result=await finalizeIngestionJob(await claim(accepted.id),exact,{contradictionPolicy:policy,
        prepareRevision:(memory,context,options)=>prepareBeliefRevision(memory,context,{...options,
          findCandidates:async()=>[{id:predecessor.id,content:'canonical',similarity:1}],
          provider:{name:'declined',generate:async()=>{calls++;return JSON.stringify({classification:reason==='no_match'?'no_match':'contradiction',confidence:reason==='low_confidence'?0.5:1,candidate_id:reason==='no_match'?null:predecessor.id});}},
        })});
      assert.equal(calls,reason==='outside_scope'||reason==='budget_exhausted'?0:1,reason);
      assert.equal(result?.id,predecessor.id); assert.equal(result?.deduplicated,true);
      assert.equal((await owner!.query('SELECT superseded_at,access_count FROM memories WHERE id=$1',[predecessor.id])).rows[0].superseded_at,null);
      assert.equal((await owner!.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1',[accepted.id])).rows[0].status,'deduplicated');
    }
    await resetContradictionRuntimeForTesting();
  });
  await t.test('a predecessor made stale during preparation falls back to the current dedupe candidate', async () => {
    const {contradictionPolicyFromEnv}=await import('../src/contradictions.js');
    const exactVector=Array(768).fill(0);exactVector[12]=1;
    const weakVector=Array(768).fill(0);weakVector[12]=0.9;weakVector[13]=Math.sqrt(0.19);
    const exact={...embedding,vector:exactVector};const weak={...embedding,vector:weakVector};
    const canonical=await acceptMemory(input('stale fallback canonical',{namespace:'private'}),auth,agent);
    await finalizeIngestionJob(await claim(canonical.id),exact);
    const predecessor=await acceptMemory(input('stale prepared predecessor',{namespace:'private'}),auth,agent);
    await finalizeIngestionJob(await claim(predecessor.id),weak);
    const accepted=await acceptMemory(input('stale predecessor correction',{namespace:'private',dedupe:true}),auth,agent);
    let calls=0;
    const result=await finalizeIngestionJob(await claim(accepted.id),exact,{contradictionPolicy:{...contradictionPolicyFromEnv(),classificationEnabled:true,namespace:'private',mutationEnabled:true},prepareRevision:async()=>{
      calls++;
      await owner!.query('UPDATE memories SET deleted_at=now() WHERE id=$1',[predecessor.id]);
      return predecessor.id;
    }});
    assert.equal(calls,1); assert.equal(result?.id,canonical.id); assert.equal(result?.deduplicated,true);
    assert.equal((await owner!.query('SELECT supersedes_id FROM memories WHERE id=$1',[accepted.id])).rows[0].supersedes_id,null);
    assert.equal((await owner!.query('SELECT access_count FROM memories WHERE id=$1',[canonical.id])).rows[0].access_count,1);
  });
  await t.test('a stale revision constraint rolls back predecessor effects before dedupe fallback', async () => {
    const {contradictionPolicyFromEnv}=await import('../src/contradictions.js');
    const exact={...embedding,vector:Array.from({length:768},(_,i)=>i===14 ? 1 : 0)};
    const predecessor=await acceptMemory(input('constraint fallback canonical',{namespace:'private'}),auth,agent);
    await finalizeIngestionJob(await claim(predecessor.id),exact);
    const accepted=await acceptMemory(input('constraint fallback correction',{namespace:'private',dedupe:true}),auth,agent);
    let calls=0;
    await owner!.query(`CREATE FUNCTION priority_constraint_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.supersedes_id IS NOT NULL THEN RAISE EXCEPTION 'stale revision' USING ERRCODE='23505'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER priority_constraint_test BEFORE UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION priority_constraint_test()`);
    try {
      const result=await finalizeIngestionJob(await claim(accepted.id),exact,{contradictionPolicy:{...contradictionPolicyFromEnv(),classificationEnabled:true,namespace:'private',mutationEnabled:true},prepareRevision:async()=>{calls++;return predecessor.id;}});
      assert.equal(calls,1); assert.equal(result?.deduplicated,true); assert.equal(result?.id,predecessor.id);
    } finally { await owner!.query('DROP TRIGGER priority_constraint_test ON memories; DROP FUNCTION priority_constraint_test()'); }
    assert.equal((await owner!.query('SELECT superseded_at FROM memories WHERE id=$1',[predecessor.id])).rows[0].superseded_at,null);
    assert.equal((await owner!.query("SELECT count(*)::int AS n FROM audit_log WHERE memory_id=$1 AND action='belief.supersede'",[accepted.id])).rows[0].n,0);
    assert.equal((await owner!.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1',[accepted.id])).rows[0].status,'deduplicated');
  });
  await t.test('inline classifier deadline hands off pending and the worker applies the revision with its full budget', async () => {
    const {prepareBeliefRevision,resetContradictionRuntimeForTesting}=await import('../src/contradictions.js');
    await resetContradictionRuntimeForTesting();
    const policy={classificationEnabled:true,mutationEnabled:true,provider:'test',model:'test',endpoint:'https://not-used.example',namespace:'private',timeoutMs:1000,mutationConfidence:0.95,
      budget:{limitMicroUsd:100n,requestMicroUsd:1n,inputMicroUsdPerMillionBytes:0n,outputMicroUsdPerMillionBytes:0n,fingerprint:'ingestion-deadline'},shadowMaxInFlight:2,shadowMaxQueued:8};
    const a=await acceptMemory(input('deadline predecessor',{namespace:'private'}),auth,agent);await finalizeIngestionJob(await claim(a.id),embedding);
    const b=await acceptMemory(input('deadline correction',{namespace:'private',dedupe:false}),auth,agent);const job=await claim(b.id);
    let calls=0;
    const prepare:typeof prepareBeliefRevision=(memory,context,options)=>prepareBeliefRevision(memory,context,{...options,
      findCandidates:async()=>[{id:a.id,content:'deadline predecessor',similarity:0.9}],
      provider:{name:'slow',generate:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,250));return JSON.stringify({classification:'contradiction',confidence:1,candidate_id:a.id});}},
    });
    try {
      let timeout:unknown;
      await assert.rejects(finalizeIngestionJob(job,embedding,{deadlineAt:Date.now()+100,contradictionPolicy:policy,prepareRevision:prepare}),error=>{timeout=error;return (error as Error).name==='TimeoutError';});
      assert.equal(calls,0,'an inline budget shorter than the full classifier timeout must not reserve or call the provider');await failIngestionJob(job,timeout);
      assert.equal((await owner!.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1',[b.id])).rows[0].status,'pending');
      const worker=await claimIngestionJob(dbScopeFromAuth(admin),{memoryId:b.id});assert.ok(worker);
      assert.equal((await finalizeIngestionJob(worker,embedding,{contradictionPolicy:policy,prepareRevision:prepare}))?.state,'ready');
      assert.equal((await owner!.query('SELECT supersedes_id FROM memories WHERE id=$1',[b.id])).rows[0].supersedes_id,a.id);
      assert.equal(calls,1,'only the worker should spend classifier budget');
    }finally{await resetContradictionRuntimeForTesting();}
  });
  await t.test('graceful worker stop drains claimed work without a failure or retry penalty', async () => {
    const {runIngestionWorker}=await import('../scripts/ingestion-worker.js');
    await owner!.query("UPDATE memory_ingestion_jobs SET next_attempt_at=now()+interval '1 day' WHERE status IN ('pending','retry_wait')");
    const a=await acceptMemory(input('finish on stop'),auth,agent);const controller=new AbortController();
    process.env.INGESTION_WORKER_API_KEY='tr_worker';
    t.mock.method(globalThis,'fetch',async()=>{controller.abort();await new Promise(resolve=>setTimeout(resolve,20));return new Response(JSON.stringify({embedding:{values:vector}}));});
    try {await runIngestionWorker({once:false,maxJobs:1,pollMs:100,concurrency:1},controller.signal);}
    finally {delete process.env.INGESTION_WORKER_API_KEY;t.mock.restoreAll();}
    const row=(await owner!.query('SELECT status,attempts,failure_category FROM memory_ingestion_jobs WHERE memory_id=$1',[a.id])).rows[0];
    assert.equal(row.status,'ready');assert.equal(row.attempts,1);assert.equal(row.failure_category,null);
  });
  await t.test('inline completion outside the mutation scope does not reserve or hand off classification', async () => {
    const {contradictionPolicyFromEnv}=await import('../src/contradictions.js');
    const policy={...contradictionPolicyFromEnv(),classificationEnabled:true,mutationEnabled:true,namespace:'private',timeoutMs:10000};
    for (const [index,entry] of [
      {namespace:'shared',access_level:'normal' as const},
      {namespace:'private',access_level:'sensitive' as const},
      {namespace:'private',access_level:'secret' as const},
    ].entries()) {
      const a=await acceptMemory(input(`outside mutation scope ${index}`,entry),auth,agent);
      const job=await claim(a.id);
      const result=await finalizeIngestionJob(job,embedding,{deadlineAt:Date.now()+3000,contradictionPolicy:policy,prepareRevision:async()=>{throw new Error('out-of-scope classifier must not run');}});
      assert.equal(result?.state,'ready');assert.equal(result?.id,a.id);
      assert.equal((await owner!.query('SELECT status,attempts FROM memory_ingestion_jobs WHERE memory_id=$1',[a.id])).rows[0].status,'ready');
    }
  });
  await t.test('HTTP out-of-scope stores stay inline with one embedding call under approved mutation', async () => {
    const {contradictionPolicyFromEnv,resetContradictionRuntimeForTesting}=await import('../src/contradictions.js');
    const settings={
      CONTRADICTION_CLASSIFICATION_ENABLED:'true',CONTRADICTION_PROCESSING_APPROVED:'true',CONTRADICTION_PROVIDER:'test',
      CONTRADICTION_MODEL:'test',CONTRADICTION_GENERATION_ENDPOINT:'https://classifier-not-used.test',CONTRADICTION_PROVIDER_MODEL_APPROVED:'true',
      CONTRADICTION_PRIVACY_APPROVED:'true',CONTRADICTION_RETENTION_APPROVED:'true',CONTRADICTION_TRAINING_APPROVED:'true',
      CONTRADICTION_APPROVED_NAMESPACE:'private',CONTRADICTION_SCOPE_APPROVED:'true',CONTRADICTION_COST_BUDGET_APPROVED:'true',
      CONTRADICTION_COST_BUDGET_USD:'1',CONTRADICTION_ESTIMATED_REQUEST_COST_USD:'0.001',
      CONTRADICTION_ESTIMATED_INPUT_COST_USD_PER_MILLION_BYTES:'0',CONTRADICTION_ESTIMATED_OUTPUT_COST_USD_PER_MILLION_BYTES:'0',
      CONTRADICTION_AUTO_MUTATION_ENABLED:'true',CONTRADICTION_MUTATION_APPROVED:'true',CONTRADICTION_SHADOW_METRICS_REVIEWED:'true',
      DEPLOYMENT_ENVIRONMENT:'ingestion-test',CONTRADICTION_MUTATION_ENVIRONMENT:'ingestion-test',CONTRADICTION_TIMEOUT_MS:'10000',
      MEMORY_STORE_INLINE_EMBED_MS:'3000',
    };
    const saved=new Map(Object.keys(settings).map(key=>[key,process.env[key]]));
    await resetContradictionRuntimeForTesting();Object.assign(process.env,settings);
    let embeddings=0;
    t.mock.method(globalThis,'fetch',async url=>{assert.ok(!String(url).includes('classifier-not-used.test'));embeddings++;return new Response(JSON.stringify({embedding:{values:vector}}));});
    try {
      assert.equal(contradictionPolicyFromEnv().mutationEnabled,true);
      const {app}=await import('../src/server.js');
      for (const [index,entry] of [
        {namespace:'shared',access_level:'normal'},
        {namespace:'private',access_level:'sensitive'},
        {namespace:'private',access_level:'secret'},
      ].entries()) {
        const result=await request(app).post('/api/store').set('Authorization','Bearer tr_owner').send({content:`scope HTTP ${index}`,agent_name:'scope-http',dedupe:false,...entry});
        assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.state,'ready');
        assert.equal(embeddings,index+1,'each request must embed exactly once and avoid worker handoff');
      }
    } finally {t.mock.restoreAll();for(const [key,value]of saved){if(value===undefined)delete process.env[key];else process.env[key]=value;}await resetContradictionRuntimeForTesting();}
  });
  await t.test('keyed replacement before first readiness still creates exactly one notification', async () => {
    const a=await acceptMemory(input('pending original',{idempotency_key:'pending-event-replacement'}),auth,agent);
    const stale=await claim(a.id);
    const b=await acceptMemory(input('pending replacement',{idempotency_key:'pending-event-replacement'}),auth,agent);
    assert.equal(b.id,a.id);assert.equal(await finalizeIngestionJob(stale,embedding),null);
    const job=await claim(b.id);const result=await finalizeIngestionJob(job,embedding);
    assert.equal(result?.created,false,'notification eligibility is separate from the current upsert response');
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE memory_id=$1',[a.id])).rows[0].n,1);
    assert.equal(await finalizeIngestionJob(job,embedding),null);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE memory_id=$1',[a.id])).rows[0].n,1);
  });
  await t.test('keyed content replacements do not emit subscription creation events', async () => {
    const a=await acceptMemory(input('keyed event original',{idempotency_key:'event-replacement'}),auth,agent);
    const nonmatching={...embedding,vector:Array.from({length:768},(_,i)=>i===20?1:0)};
    await finalizeIngestionJob(await claim(a.id),nonmatching);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE memory_id=$1',[a.id])).rows[0].n,0);
    const b=await acceptMemory(input('keyed event changed',{idempotency_key:'event-replacement'}),auth,agent);
    assert.equal(b.id,a.id);
    await finalizeIngestionJob(await claim(b.id),embedding);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE memory_id=$1',[a.id])).rows[0].n,0,'replacing content must not create a newly matching subscription event');
  });
  await t.test('terminal keyed retries report actual state without silently requeueing', async () => {
    for (const status of ['embedding_failed','cancelled']) {
      const content=`terminal retry ${status}`;
      const a=await acceptMemory(input(content,{idempotency_key:status}),auth,agent);
      await owner!.query('UPDATE memory_ingestion_jobs SET status=$2,finalized_at=now() WHERE memory_id=$1',[a.id,status]);
      const replay=await acceptMemory(input(content,{idempotency_key:status}),auth,agent);
      assert.equal(replay.id,a.id); assert.equal(replay.state,status); assert.equal(replay.created,false);
      assert.equal((await owner!.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1',[a.id])).rows[0].status,status);
    }
  });
  await t.test('inline completion exposes a permanent profile mismatch instead of queued', async () => {
    const {tryInlineIngestion}=await import('../src/ingestion.js');
    const a=await acceptMemory(input('inline mismatched profile'),auth,agent);
    await owner!.query("UPDATE memory_ingestion_jobs SET embedding_model='different-target' WHERE memory_id=$1",[a.id]);
    process.env.MEMORY_STORE_INLINE_EMBED_MS='1000';
    t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({embedding:{values:vector}})));
    try { assert.equal((await tryInlineIngestion(a,auth)).state,'embedding_failed'); }
    finally {process.env.MEMORY_STORE_INLINE_EMBED_MS='0';t.mock.restoreAll();}
  });
  await t.test('a zero-row vector update rolls back readiness, outbox and audit', async () => {
    const a=await acceptMemory(input('blocked vector write'),auth,agent);const job=await claim(a.id);
    await owner!.query(`CREATE FUNCTION ingestion_skip_vector_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER ingestion_skip_vector_test BEFORE UPDATE OF embedding ON memories FOR EACH ROW EXECUTE FUNCTION ingestion_skip_vector_test()`);
    try { await assert.rejects(finalizeIngestionJob(job,embedding),/memory update did not affect exactly one row/); }
    finally {await owner!.query('DROP TRIGGER ingestion_skip_vector_test ON memories; DROP FUNCTION ingestion_skip_vector_test()');}
    const row=(await owner!.query('SELECT m.embedding,j.status FROM memories m JOIN memory_ingestion_jobs j ON j.memory_id=m.id WHERE m.id=$1',[a.id])).rows[0];
    assert.equal(row.embedding,null);assert.equal(row.status,'processing');
    assert.equal((await owner!.query("SELECT count(*)::int AS n FROM audit_log WHERE memory_id=$1 AND action='memory.ingest.ready'",[a.id])).rows[0].n,0);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE memory_id=$1',[a.id])).rows[0].n,0);
  });
  await t.test('zero-row dedupe writes roll back canonical boosts and preserve the accepted memory', async () => {
    const exact={...embedding,vector:Array.from({length:768},(_,i)=>i===25?1:0)};
    const canonical=await acceptMemory(input('zero row canonical',{namespace:'private'}),auth,agent);
    await finalizeIngestionJob(await claim(canonical.id),exact);
    const a=await acceptMemory(input('zero row duplicate',{namespace:'private',dedupe:true}),auth,agent);const job=await claim(a.id);
    await owner!.query(`CREATE FUNCTION ingestion_skip_dedupe_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF (TG_ARGV[0]='boost' AND NEW.access_count>OLD.access_count) OR (TG_ARGV[0]='delete' AND NEW.deleted_at IS NOT NULL) THEN RETURN NULL; END IF;
      RETURN NEW; END $$`);
    try {
      for (const operation of ['boost','delete']) {
        await owner!.query(`CREATE TRIGGER ingestion_skip_dedupe_test BEFORE UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION ingestion_skip_dedupe_test('${operation}')`);
        try {await assert.rejects(finalizeIngestionJob(job,exact),/memory update did not affect exactly one row/);}
        finally {await owner!.query('DROP TRIGGER ingestion_skip_dedupe_test ON memories');}
        assert.equal((await owner!.query('SELECT access_count FROM memories WHERE id=$1',[canonical.id])).rows[0].access_count,0);
        assert.equal((await owner!.query('SELECT deleted_at FROM memories WHERE id=$1',[a.id])).rows[0].deleted_at,null);
        assert.equal((await owner!.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1',[a.id])).rows[0].status,'processing');
      }
    } finally {await owner!.query('DROP FUNCTION ingestion_skip_dedupe_test()');}
  });
  await t.test('revoked or narrowed keys finish accepted rows without dedupe, tags or supersession effects', async () => {
    const {contradictionPolicyFromEnv}=await import('../src/contradictions.js');
    const changes=["enabled=false","permissions=ARRAY['read']","namespaces=ARRAY['shared']","revoked_at=now()","expires_at=now()-interval '1 second'","max_access_level='normal'"];
    for (const [index,change] of changes.entries()) {
      const level=index===5?'secret':'normal';
      const exact={...embedding,vector:Array.from({length:768},(_,i)=>i===26+index?1:0)};
      const canonical=await acceptMemory(input(`revocation canonical ${index}`,{namespace:'private',access_level:level}),auth,agent);
      await finalizeIngestionJob(await claim(canonical.id),exact);
      const duplicate=await acceptMemory(input(`revocation duplicate ${index}`,{namespace:'private',access_level:level,dedupe:true,tags:['accepted-tag']}),auth,agent);
      const correction=await acceptMemory(input(`revocation correction ${index}`,{namespace:'private',access_level:level}),auth,agent);
      const duplicateJob=await claim(duplicate.id);const correctionJob=await claim(correction.id);
      await owner!.query(`UPDATE api_keys SET ${change} WHERE id=$1`,[ownerId]);
      let calls=0;
      try {
        const result=await finalizeIngestionJob(duplicateJob,exact);
        assert.equal(result?.deduplicated,false,change);assert.equal(result?.id,duplicate.id);assert.equal(result?.state,'ready');
        assert.equal((await finalizeIngestionJob(correctionJob,exact,{contradictionPolicy:{...contradictionPolicyFromEnv(),classificationEnabled:true,namespace:'private',mutationEnabled:true},prepareRevision:async()=>{calls++;return canonical.id;}}))?.state,'ready');
        assert.equal(calls,0,'revoked/narrowed jobs must not spend classification budget');
        const previous=(await owner!.query('SELECT tags,superseded_at,access_count FROM memories WHERE id=$1',[canonical.id])).rows[0];
        assert.equal(previous.tags.includes('accepted-tag'),false);assert.equal(previous.superseded_at,null);assert.equal(previous.access_count,0);
        const accepted=(await owner!.query('SELECT supersedes_id,embedding IS NOT NULL AS embedded,deleted_at FROM memories WHERE id=$1',[correction.id])).rows[0];
        assert.deepEqual(accepted,{supersedes_id:null,embedded:true,deleted_at:null});
      } finally {await owner!.query('UPDATE api_keys SET enabled=true,permissions=$2,namespaces=$3,revoked_at=NULL,expires_at=NULL,max_access_level=$4 WHERE id=$1',[ownerId,auth.permissions,auth.namespaces,auth.maxAccessLevel]);}
    }
  });
  await t.test('revocation during unlocked classification prevents a prepared revision from committing', async () => {
    const {contradictionPolicyFromEnv}=await import('../src/contradictions.js');
    const exact={...embedding,vector:Array.from({length:768},(_,i)=>i===32?1:0)};
    const canonical=await acceptMemory(input('revocation race canonical',{namespace:'private'}),auth,agent);
    await finalizeIngestionJob(await claim(canonical.id),exact);
    const a=await acceptMemory(input('revocation race correction',{namespace:'private',dedupe:true}),auth,agent);
    try {
      const result=await finalizeIngestionJob(await claim(a.id),exact,{contradictionPolicy:{...contradictionPolicyFromEnv(),classificationEnabled:true,namespace:'private',mutationEnabled:true},prepareRevision:async()=>{
        await owner!.query('UPDATE api_keys SET enabled=false WHERE id=$1',[ownerId]);return canonical.id;
      }});
      assert.equal(result?.id,a.id);assert.equal(result?.deduplicated,false);assert.equal(result?.state,'ready');
      const previous=(await owner!.query('SELECT superseded_at,access_count FROM memories WHERE id=$1',[canonical.id])).rows[0];
      assert.deepEqual(previous,{superseded_at:null,access_count:0});
    } finally {await owner!.query('UPDATE api_keys SET enabled=true WHERE id=$1',[ownerId]);}
  });
  await t.test('revocation cannot complete between the final authority check and canonical effects', async () => {
    const exact={...embedding,vector:Array.from({length:768},(_,i)=>i===33?1:0)};
    const canonical=await acceptMemory(input('authority lock canonical',{namespace:'private'}),auth,agent);
    await finalizeIngestionJob(await claim(canonical.id),exact);
    const a=await acceptMemory(input('authority lock duplicate',{namespace:'private',dedupe:true}),auth,agent);const job=await claim(a.id);
    const secondCanonical=await acceptMemory(input('authority lock second canonical'),auth,agent);await finalizeIngestionJob(await claim(secondCanonical.id),exact);
    const second=await acceptMemory(input('authority lock second duplicate',{dedupe:true}),auth,agent);const secondJob=await claim(second.id);
    const revoker=new pg.Client({connectionString:url});await revoker.connect();
    const revokerPid=(await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let completion:Promise<unknown>|undefined;let revocation:Promise<unknown>|undefined;let authentication:ReturnType<typeof validateKey>|undefined;let secondCompletion:Promise<unknown>|undefined;
    await owner!.query("SELECT pg_advisory_lock(hashtextextended('ingestion-authority-effect-test',0))");
    await owner!.query(`CREATE FUNCTION ingestion_authority_lock_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('ingestion-authority-effect-test',0)); RETURN NEW; END $$;
      CREATE TRIGGER ingestion_authority_lock_test BEFORE UPDATE OF access_count ON memories FOR EACH ROW EXECUTE FUNCTION ingestion_authority_lock_test()`);
    try {
      completion=finalizeIngestionJob(job,exact);
      let inEffects=false;
      for(let i=0;i<100;i++){
        inEffects=(await owner!.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%access_count = COALESCE%') AS active")).rows[0].active;
        if(inEffects)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(inEffects,true,'finalizer must reach canonical effects after the authority check');
      authentication=validateKey('tr_owner');
      let timer:ReturnType<typeof setTimeout>|undefined;
      const authenticated=await Promise.race([authentication,new Promise<'blocked'>(resolve=>{timer=setTimeout(()=>resolve('blocked'),1000);})]);
      if(timer)clearTimeout(timer);
      assert.notEqual(authenticated,'blocked','usage timestamp contention must not block authentication');
      assert.equal((authenticated as AuthContext).keyId,ownerId);
      let revoked=false;revocation=revoker.query('UPDATE api_keys SET enabled=false WHERE id=$1',[ownerId]).then(()=>{revoked=true;});
      let revocationBlocked=false;
      for(let i=0;i<100;i++){
        revocationBlocked=(await owner!.query("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",[revokerPid])).rows[0]?.blocked===true;
        if(revocationBlocked)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(revocationBlocked,true,'the authority row must remain locked through cross-row effects');assert.equal(revoked,false);
      secondCompletion=finalizeIngestionJob(secondJob,exact);
      let secondBlocked=false;
      for(let i=0;i<100;i++){
        secondBlocked=(await owner!.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT k.id FROM api_keys%') AS blocked")).rows[0].blocked;
        if(secondBlocked)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(secondBlocked,true,'later finalizers must queue behind a waiting revoker rather than join shared holders');
      await owner!.query("SELECT pg_advisory_unlock(hashtextextended('ingestion-authority-effect-test',0))");
      assert.equal((await completion as {deduplicated:boolean}).deduplicated,true);await revocation;
      assert.equal(revoked,true);
      const later=await secondCompletion as {id:string;deduplicated:boolean;state:string};
      assert.equal(later.id,second.id);assert.equal(later.deduplicated,false);assert.equal(later.state,'ready');
      assert.equal((await owner!.query('SELECT access_count FROM memories WHERE id=$1',[secondCanonical.id])).rows[0].access_count,0);
      assert.equal(await validateKey('tr_owner'),null,'the read-only authentication fallback must still reject a committed revocation');
    } finally {
      await owner!.query("SELECT pg_advisory_unlock(hashtextextended('ingestion-authority-effect-test',0))");
      await completion?.catch(()=>undefined);await revocation?.catch(()=>undefined);await authentication?.catch(()=>undefined);await secondCompletion?.catch(()=>undefined);await revoker.end();
      await owner!.query('DROP TRIGGER ingestion_authority_lock_test ON memories; DROP FUNCTION ingestion_authority_lock_test()');
      await owner!.query('UPDATE api_keys SET enabled=true WHERE id=$1',[ownerId]);
    }
  });
  await t.test('unlinked completion without cross-row effects does not wait for the accepting key lock', async () => {
    const a=await acceptMemory(input('key-independent completion',{idempotency_key:'key-independent'}),auth,agent);const job=await claim(a.id);
    await owner!.query('BEGIN');await owner!.query('SELECT id FROM api_keys WHERE id=$1 FOR UPDATE',[ownerId]);
    let completion:Promise<unknown>|undefined;let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      completion=finalizeIngestionJob(job,embedding);
      const result=await Promise.race([completion,new Promise<'blocked'>(resolve=>{timer=setTimeout(()=>resolve('blocked'),1000);})]);
      assert.notEqual(result,'blocked','a keyed completion has no other-memory effect requiring a key-row fence');
      assert.equal((result as {state:string}).state,'ready');
    } finally {if(timer)clearTimeout(timer);await owner!.query('ROLLBACK');await completion?.catch(()=>undefined);}
  });
  await t.test('namespace contention does not fence off revocation before effects can start', async () => {
    const a=await acceptMemory(input('namespace wait duplicate',{namespace:'private',dedupe:true}),auth,agent);const job=await claim(a.id);
    const namespaceLock='memory-store-dedupe:'+JSON.stringify(['private','normal']);
    const revoker=new pg.Client({connectionString:url});await revoker.connect();
    await owner!.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[namespaceLock]);
    let completion:Promise<unknown>|undefined;let revocation:Promise<unknown>|undefined;let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      completion=finalizeIngestionJob(job,embedding);
      let waiting=false;
      for(let i=0;i<100;i++){
        waiting=(await owner!.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%') AS waiting")).rows[0].waiting;
        if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(waiting,true);
      revocation=revoker.query('UPDATE api_keys SET enabled=false WHERE id=$1',[ownerId]);
      const revoked=await Promise.race([revocation.then(()=>true),new Promise<'blocked'>(resolve=>{timer=setTimeout(()=>resolve('blocked'),1000);})]);
      assert.equal(revoked,true,'waiting for a namespace must not hold the key-row fence');
    } finally {
      if(timer)clearTimeout(timer);await owner!.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[namespaceLock]);
      await completion?.catch(()=>undefined);await revocation?.catch(()=>undefined);await revoker.end();await owner!.query('UPDATE api_keys SET enabled=true WHERE id=$1',[ownerId]);
    }
  });
  await t.test('an explicitly linked pending successor keeps its history during embedding finalization', async () => {
    const {memoryUpdate}=await import('../src/tools/update.js');
    const exact={...embedding,vector:Array.from({length:768},(_,i)=>i===35?1:0)};
    const previous=await acceptMemory(input('explicit history predecessor',{namespace:'private'}),auth,agent);await finalizeIngestionJob(await claim(previous.id),exact);
    const canonical=await acceptMemory(input('explicit history unrelated canonical',{namespace:'private'}),auth,agent);await finalizeIngestionJob(await claim(canonical.id),exact);
    const successor=await acceptMemory(input('explicit history queued successor',{namespace:'private',dedupe:true}),auth,agent);const job=await claim(successor.id);
    await memoryUpdate({id:successor.id,supersedes:previous.id},auth);
    const result=await finalizeIngestionJob(job,exact);assert.equal(result?.id,successor.id);assert.equal(result?.deduplicated,false);
    const linked=(await owner!.query('SELECT supersedes_id,deleted_at,embedding IS NOT NULL AS embedded FROM memories WHERE id=$1',[successor.id])).rows[0];
    assert.deepEqual(linked,{supersedes_id:previous.id,deleted_at:null,embedded:true});
    assert.ok((await owner!.query('SELECT superseded_at FROM memories WHERE id=$1',[previous.id])).rows[0].superseded_at);
    assert.equal((await owner!.query('SELECT access_count FROM memories WHERE id=$1',[canonical.id])).rows[0].access_count,0);
  });
  await t.test('migration 037 bounds table lock waits and rolls back before a safe retry', async () => {
    await owner!.query('CREATE DATABASE ingestion_lock_test');
    const lockUrl=new URL(url);lockUrl.pathname='/ingestion_lock_test';
    const migrator=new pg.Client({connectionString:lockUrl.href});const locker=new pg.Client({connectionString:lockUrl.href});
    try {
      await migrator.connect();await locker.connect();
      await migrator.query('CREATE EXTENSION vector');
      await provisionDatabase(migrator,{appPassword:'app-test-only',rotateAppPassword:false});
      const inventory=loadMigrationInventory(fileURLToPath(new URL('../migrations',import.meta.url)));
      await runMigrations(migrator,inventory,{throughNumber:36,lockTimeoutMs:5000});
      await migrator.query("SET statement_timeout = '8s'");
      await locker.query('BEGIN; LOCK TABLE memories IN ROW EXCLUSIVE MODE');
      const started=Date.now();
      try {await assert.rejects(runMigrations(migrator,inventory,{lockTimeoutMs:5000}),error=>(error as {code?:string}).code==='55P03');}
      finally {await locker.query('ROLLBACK');}
      assert.ok(Date.now()-started<10000,'DDL acquisition must be bounded independently of the advisory migration lock');
      assert.equal((await migrator.query("SELECT to_regclass('public.memory_ingestion_jobs') AS jobs")).rows[0].jobs,null);
      assert.equal((await migrator.query("SELECT count(*)::int AS n FROM schema_migrations WHERE version='037_memory_ingestion_queue'")).rows[0].n,0);
      await runMigrations(migrator,inventory,{lockTimeoutMs:5000});
      assert.equal((await migrator.query("SELECT count(*)::int AS n FROM schema_migrations WHERE version='037_memory_ingestion_queue'")).rows[0].n,1);
    } finally {await locker.end();await migrator.end();await owner!.query('DROP DATABASE ingestion_lock_test');}
  });
  await t.test('HTTP inline budget is independent of provider timeout and happy path remains ready', async () => {
    const { app } = await import('../src/server.js');
    process.env.MEMORY_STORE_INLINE_EMBED_MS='40';
    let providerCalled=false;
    t.mock.method(globalThis,'fetch',async (_url,init) => {
      providerCalled=true;
      await new Promise<void>((resolve,reject) => {
        const timer=setTimeout(resolve,15000);
        init?.signal?.addEventListener('abort',()=>{ clearTimeout(timer); reject(init.signal!.reason); },{once:true});
      });
      return new Response(JSON.stringify({ embedding:{ values:vector } }));
    });
    const start = Date.now(); const queued = await request(app).post('/api/store').set('Authorization','Bearer tr_owner').send({ content:'http durable latency',agent_name:'http',dedupe:false });
    assert.equal(queued.status,200,JSON.stringify(queued.body)); assert.equal(queued.body.state,'queued'); assert.ok(Date.now()-start<5040); assert.equal(providerCalled,true); t.diagnostic(`HTTP queued latency ${Date.now()-start}ms with inline 40ms and provider 15000ms`); assert.ok(queued.body.accepted_at);
    t.mock.restoreAll();
    t.mock.method(globalThis,'fetch',async () => new Response(JSON.stringify({ embedding:{ values:vector } })));
    process.env.MEMORY_STORE_INLINE_EMBED_MS='3000';
    const ready = await request(app).post('/api/store').set('Authorization','Bearer tr_owner').send({ content:'http healthy',agent_name:'http',dedupe:false }); assert.equal(ready.body.state,'ready',JSON.stringify(ready.body));
    await owner!.query(`CREATE FUNCTION reject_http_acceptance_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private database failure'; END $$;
      CREATE TRIGGER reject_http_acceptance_test BEFORE INSERT ON memory_ingestion_jobs FOR EACH ROW EXECUTE FUNCTION reject_http_acceptance_test()`);
    try {
      const unavailable = await request(app).post('/api/store').set('Authorization','Bearer tr_owner').send({ content:'must not acknowledge',agent_name:'http',dedupe:false });
      assert.equal(unavailable.status,503); assert.equal(unavailable.body.code,'ingestion_persistence_unavailable');
      assert.doesNotMatch(JSON.stringify(unavailable.body),/private database failure|must not acknowledge/);
    } finally { await owner!.query('DROP TRIGGER reject_http_acceptance_test ON memory_ingestion_jobs; DROP FUNCTION reject_http_acceptance_test()'); }
    const keyed=await request(app).post('/api/store').set('Authorization','Bearer tr_owner').send({ content:'keyed healthy one',agent_name:'http',idempotency_key:'inline-created' });
    assert.equal(keyed.body.created,true); assert.equal(keyed.body.state,'ready');
    const changed=await request(app).post('/api/store').set('Authorization','Bearer tr_owner').send({ content:'keyed healthy two',agent_name:'http',idempotency_key:'inline-created' });
    assert.equal(changed.body.created,false); assert.equal(changed.body.state,'ready'); assert.equal(changed.body.id,keyed.body.id);
    const details=(await owner!.query("SELECT details FROM audit_log WHERE memory_id=$1 AND action='memory.store' ORDER BY created_at DESC LIMIT 1",[keyed.body.id])).rows[0].details;
    assert.equal(details.created,false); assert.equal(details.idempotent,true);
    setPoolForTesting(faultingPool(pool!,sql=>sql.includes('WITH candidate AS')));
    try {
      const deferred=await request(app).post('/api/store').set('Authorization','Bearer tr_owner').send({ content:'durable claim fault',agent_name:'http',dedupe:false });
      assert.equal(deferred.status,200); assert.equal(deferred.body.state,'queued');
      assert.equal((await owner!.query('SELECT content FROM memories WHERE id=$1',[deferred.body.id])).rows[0].content,'durable claim fault');
    } finally { setPoolForTesting(pool!); }
    const forbidden = await request(app).get('/api/ingestion/stats').set('Authorization','Bearer tr_owner'); assert.equal(forbidden.status,403);
    const stats = await request(app).get('/api/ingestion/stats').set('Authorization','Bearer tr_worker'); assert.equal(stats.status,200);
  });
});

