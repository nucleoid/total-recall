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
import { runSessionWorker } from '../scripts/session-distill.js';
import { applySessionDistillation, claimSessionDistillationJob, loadSessionTranscript, reserveSessionDistillationBudget,
  sessionDistillationInputBytes, parseSessionDistillationPolicy } from '../src/session-distillation.js';
import { claimIngestionJob, claimIngestionJobs, finalizeIngestionJob, finalizeIngestionBatch, failIngestionJob,
  requeueDocument, acceptSessionFact } from '../src/ingestion.js';
import { runIngestionWorker } from '../src/ingestion-worker.js';
import { ACTIVE_EMBEDDING_PROFILE, EmbeddingProviderError } from '../src/embedding.js';
import { memoryUpdate } from '../src/tools/update.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../src/tools/register.js';

function policy() {
  const approval={ approved:true,approvedBy:'synthetic-test',approvedAt:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z' };
  return parseSessionDistillationPolicy({
    version:1,feature:'memory-session-distillation',environment:'test',
    generation:{ provider:'synthetic',model:'synthetic-model',endpoint:'https://example.test/generate',credentialEnv:'SESSION_TEST_KEY' },
    terms:{ reference:'synthetic/57',privacyApproved:true,retentionApproved:true,trainingApproved:true },
    scope:{ namespaces:['shared'],accessLevel:'normal' },
    budget:{ maxInputBytesPerSession:1100000,maxOutputBytesPerSession:65536,maxCostUsdPerSession:1,maxCostUsdPerMonth:100,
      estimatedRequestCostUsd:0.001,estimatedInputCostUsdPerMillionBytes:1,estimatedOutputCostUsdPerMillionBytes:4,monthlyControlReference:'synthetic-budget' },
    providerModelApproval:approval,termsApproval:approval,scopeApproval:approval,budgetApproval:approval,
  },'test');
}

function faultingPool(pool:pg.Pool, fail:(sql:string)=>boolean):pg.Pool {
  return { query:pool.query.bind(pool),connect:async () => {
    const client=await pool.connect();
    return { release:(error?:Error)=>client.release(error),query:async (sql:string,values?:unknown[]) => {
      if (fail(sql)) throw new Error('synthetic database boundary');
      return client.query(sql,values);
    } };
  } } as unknown as pg.Pool;
}

function lostCommitPool(pool:pg.Pool, boundary:string):pg.Pool {
  return { query:pool.query.bind(pool),connect:async () => {
    const client=await pool.connect(); let accepted=false;
    return { release:(error?:Error)=>client.release(error),query:async (sql:string,values?:unknown[]) => {
      const result=await client.query(sql,values);
      if (sql.includes(boundary)) accepted=true;
      if (sql==='COMMIT' && accepted) throw new Error('synthetic lost commit acknowledgement');
      return result;
    } };
  } } as unknown as pg.Pool;
}

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
  const vector=Array.from({ length:768 },(_,i) => i===0 ? 1 : 0);
  const embedding={ ...ACTIVE_EMBEDDING_PROFILE,vector };
  let online=false,embeddingCalls=0;
  globalThis.fetch=async (_,options) => {
    embeddingCalls++;
    if (!online) throw new Error('synthetic embedding offline');
    const body=JSON.parse(String(options?.body));
    return Response.json(body.requests ? { embeddings:body.requests.map(() => ({ values:vector })) } : { embedding:{ values:vector } });
  };
  const params=(session_id=randomUUID(), transcript='User prefers PostgreSQL.') => storeSessionSchema.parse({ session_id,transcript });
  const status=(episode_id:string,actor=auth) => memorySessionStatus({ episode_id },actor);
  const claim=(documentId:string,limit=64) => claimIngestionJobs(dbScopeFromAuth(admin),{ documentId,limit });
  const facts=[{ content:'User prefers PostgreSQL.',kind:'preference' as const }];
  const worker=(provider={ name:'synthetic',generate:async () => JSON.stringify({ facts }) },approved=policy()) =>
    runSessionWorker({ once:true,maxJobs:1,pollMs:100 },new AbortController().signal,{ policy:approved,provider,auth:admin });
  const prepare=async (episodeId:string) => withScopedClient(dbScopeFromAuth(admin),async client => {
    const job=await claimSessionDistillationJob(client,'shared'); assert.ok(job); assert.equal(job.episodeId,episodeId);
    const loaded=await loadSessionTranscript(client,job); assert.ok(loaded);
    assert.ok(await reserveSessionDistillationBudget(client,job,policy(),sessionDistillationInputBytes(loaded.transcript)));
    return { job,loaded };
  });
  t.beforeEach(async () => {
    online=false; embeddingCalls=0; process.env.MEMORY_STORE_INLINE_EMBED_MS='0';
    process.env.MEMORY_INGESTION_QUEUE_ENABLED='true'; process.env.MEMORY_INGESTION_SESSION_ENABLED='true';
    await owner!.query("UPDATE memory_session_distillation_runs SET status='dead',locked_at=NULL,completed_at=now(),last_error_code='test_isolation' WHERE status IN ('pending','retry','processing')");
  });

  await t.test('offline provider still commits episode, every chunk, run, document jobs and audit', async () => {
    const input=params();
    process.env.MEMORY_STORE_INLINE_EMBED_MS='100';
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

  await t.test('replay preserves IDs across pending, partial, failed, ready, gate rollback and concurrent acceptance', async () => {
    const input=params(randomUUID(),'x'.repeat(4500));
    const [a,b]=await Promise.all([memoryStoreSession(input,auth),memoryStoreSession(input,auth)]);
    assert.equal(a.episode_id,b.episode_id); assert.equal(a.run_id,b.run_id); assert.equal(a.chunks_stored,3);
    const pending=await status(a.episode_id); assert.deepEqual(pending.embedding?.episode,{ state:'queued',ready:0,queued:3,failed:0 });
    const first=await claim(a.episode_id,1); assert.equal(first.length,1); assert.ok(await finalizeIngestionBatch(first,[embedding]));
    assert.deepEqual((await status(a.episode_id)).embedding?.episode,{ state:'queued',ready:1,queued:2,failed:0 });
    assert.equal((await memoryStoreSession(input,auth)).state,'queued');
    const rest=await claim(a.episode_id); assert.equal(rest.length,2);
    for (const job of rest) await failIngestionJob(job,new EmbeddingProviderError(400));
    assert.equal((await memoryStoreSession(input,auth)).state,'embedding_failed');
    assert.deepEqual((await status(a.episode_id)).embedding?.episode,{ state:'embedding_failed',ready:1,queued:0,failed:2 });
    await requeueDocument(a.episode_id,admin); const retry=await claim(a.episode_id);
    assert.ok(await finalizeIngestionBatch(retry,retry.map(() => embedding)));
    process.env.MEMORY_INGESTION_SESSION_ENABLED='false';
    const ready=await memoryStoreSession(input,auth); assert.equal(ready.state,'ready'); assert.equal(ready.episode_id,a.episode_id);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM memory_ingestion_jobs WHERE document_id=$1',[a.episode_id])).rows[0].n,3);
    await assert.rejects(memoryStoreSession({ ...input,agent_model:'different' },auth),/different request/);
  });

  await t.test('inline batches are bounded, threshold obeyed, and both gates fail closed', async () => {
    online=true; process.env.MEMORY_STORE_INLINE_EMBED_MS='1000';
    assert.equal((await memoryStoreSession(params(),auth)).state,'ready'); assert.equal(embeddingCalls,1);
    process.env.MEMORY_STORE_DOCUMENT_INLINE_MAX_CHUNKS='0'; embeddingCalls=0;
    assert.equal((await memoryStoreSession(params(),auth)).state,'queued'); assert.equal(embeddingCalls,0);
    delete process.env.MEMORY_STORE_DOCUMENT_INLINE_MAX_CHUNKS;
    const fetch=globalThis.fetch; globalThis.fetch=async () => new Promise<Response>(() => {});
    process.env.MEMORY_STORE_INLINE_EMBED_MS='20'; const started=Date.now();
    try { assert.equal((await memoryStoreSession(params(),auth)).state,'queued'); assert.ok(Date.now()-started<1500); }
    finally { globalThis.fetch=fetch; }
    for (const gate of ['MEMORY_INGESTION_SESSION_ENABLED','MEMORY_INGESTION_QUEUE_ENABLED']) {
      process.env[gate]='false'; online=false;
      const input=params(); await assert.rejects(memoryStoreSession(input,auth),/embedding offline/);
      assert.equal((await owner!.query('SELECT count(*)::int AS n FROM documents WHERE session_id=$1',[input.session_id])).rows[0].n,0);
      online=true; const sync=await memoryStoreSession(input,auth); assert.equal(sync.state,undefined);
      assert.equal((await owner!.query('SELECT count(*)::int AS n FROM memory_ingestion_jobs WHERE document_id=$1',[sync.episode_id])).rows[0].n,0);
      process.env[gate]='true';
    }
  });

  await t.test('sensitive and secret queued episodes embed but cannot be claimed for generation', async () => {
    for (const access_level of ['sensitive','secret'] as const) {
      const episode=await memoryStoreSession({ ...params(),access_level },auth);
      assert.equal(episode.state,'queued'); const jobs=await claim(episode.episode_id);
      assert.ok(jobs.every(job => job.access_level===access_level));
      assert.ok(await finalizeIngestionBatch(jobs,jobs.map(() => embedding)));
      assert.equal((await status(episode.episode_id)).embedding?.episode.state,'ready');
      assert.equal((await status(episode.episode_id)).status,'pending');
    }
    let calls=0; await worker({ name:'synthetic',generate:async () => { calls++; return '{"facts":[]}'; } }); assert.equal(calls,0);
  });

  await t.test('gate-off worker preserves synchronous facts without jobs or provider work inside transactions', async () => {
    process.env.MEMORY_INGESTION_SESSION_ENABLED='false'; online=true;
    const episode=await memoryStoreSession(params(),auth); let activeTransactions=0;
    setPoolForTesting({ query:app!.query.bind(app!),connect:async () => {
      const client=await app!.connect();
      return { release:(error?:Error)=>client.release(error),query:async (sql:string,values?:unknown[]) => {
        const result=await client.query(sql,values);
        if (sql==='BEGIN') activeTransactions++; if (sql==='COMMIT' || sql==='ROLLBACK') activeTransactions--;
        return result;
      } };
    } } as unknown as pg.Pool);
    const fetch=globalThis.fetch; globalThis.fetch=async (...args) => { assert.equal(activeTransactions,0); return fetch(...args); };
    try { assert.equal((await worker()).factsStored,1); } finally { globalThis.fetch=fetch; setPoolForTesting(app!); }
    assert.equal((await status(episode.episode_id)).embedding?.facts.state,'ready');
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM memory_ingestion_jobs j JOIN memory_session_derivations d ON d.memory_id=j.memory_id WHERE d.run_id=$1',[episode.run_id])).rows[0].n,0);
  });

  await t.test('one generation call completes unembedded transcript with durable facts before embedding outage', async () => {
    const episode=await memoryStoreSession(params(),auth); process.env.MEMORY_STORE_INLINE_EMBED_MS='100';
    let calls=0; const provider={ name:'synthetic',generate:async () => { calls++; return JSON.stringify({ facts }); } };
    const result=await worker(provider); assert.deepEqual(result,{ processed:1,providerCalls:1,factsStored:1 });
    const completed=await status(episode.episode_id); assert.equal(completed.status,'completed'); assert.equal(completed.facts_stored,1);
    assert.deepEqual(completed.embedding,{ episode:{ state:'queued',ready:0,queued:1,failed:0 },facts:{ state:'queued',ready:0,queued:1,failed:0 } });
    const stored=(await owner!.query(`SELECT m.id,m.embedding,j.status,j.client_id,j.kind,j.dedupe,j.contradiction_eligible
      FROM memory_session_derivations d JOIN memories m ON m.id=d.memory_id JOIN memory_ingestion_jobs j ON j.memory_id=m.id WHERE d.run_id=$1`,[episode.run_id])).rows[0];
    assert.equal(stored.embedding,null); assert.equal(stored.client_id,auth.keyId); assert.equal(stored.kind,'store');
    assert.equal(stored.dedupe,false); assert.equal(stored.contradiction_eligible,false);
    const budget=(await owner!.query('SELECT estimated_cost_micro_usd FROM memory_session_distillation_runs WHERE id=$1',[episode.run_id])).rows[0];
    assert.equal((await worker(provider)).providerCalls,0); assert.equal(calls,1);
    assert.deepEqual((await owner!.query('SELECT estimated_cost_micro_usd FROM memory_session_distillation_runs WHERE id=$1',[episode.run_id])).rows[0],budget);
    online=true; await owner!.query('UPDATE memory_ingestion_jobs SET next_attempt_at=now() WHERE memory_id=$1',[stored.id]);
    process.env.INGESTION_WORKER_API_KEY='tr_session-worker';
    await runIngestionWorker({ once:true,maxJobs:1000,pollMs:100,concurrency:2 },new AbortController().signal);
    assert.equal((await status(episode.episode_id)).embedding?.facts.state,'ready'); assert.equal(calls,1);
  });

  await t.test('acceptance rolls back every pre-commit boundary and response-loss replay uses committed identity', async () => {
    for (const boundary of ['INSERT INTO documents','INSERT INTO memories','INSERT INTO memory_ingestion_jobs','INSERT INTO memory_session_distillation_runs','INSERT INTO audit_log']) {
      const input=params(); setPoolForTesting(faultingPool(app!,sql => sql.includes(boundary)));
      try { await assert.rejects(memoryStoreSession(input,auth),/synthetic database boundary/); } finally { setPoolForTesting(app!); }
      assert.equal((await owner!.query('SELECT count(*)::int AS n FROM documents WHERE session_id=$1',[input.session_id])).rows[0].n,0,boundary);
    }
    const input=params(); setPoolForTesting(lostCommitPool(app!,'INSERT INTO documents'));
    try { await assert.rejects(memoryStoreSession(input,auth),/lost commit acknowledgement/); } finally { setPoolForTesting(app!); }
    const accepted=await memoryStoreSession(input,auth); assert.equal(accepted.idempotent_replay,true);
    const abandoned=await claim(accepted.episode_id);
    await owner!.query("UPDATE memory_ingestion_jobs SET lease_expires_at=now()-interval '1 second' WHERE document_id=$1",[accepted.episode_id]);
    const reclaimed=await claim(accepted.episode_id); assert.notEqual(reclaimed[0].lease_token,abandoned[0].lease_token);
    assert.equal(await finalizeIngestionBatch(abandoned,[embedding]),false);
    assert.ok(await finalizeIngestionBatch(reclaimed,[embedding]));
    assert.equal((await memoryStoreSession(input,auth)).episode_id,accepted.episode_id);
  });

  await t.test('fact, derivation, job and run completion roll back together; source-key replay never reembeds ready facts', async () => {
    const episode=await memoryStoreSession(params(),auth), { job,loaded }=await prepare(episode.episode_id);
    for (const boundary of ['INSERT INTO memories','INSERT INTO memory_session_derivations','INSERT INTO memory_ingestion_jobs',"SET status = 'completed'"]) {
      setPoolForTesting(faultingPool(app!,sql => sql.includes(boundary)));
      try { await assert.rejects(withScopedClient(dbScopeFromAuth(admin),client => applySessionDistillation(client,job,loaded,facts,100,policy())),/synthetic database boundary/); }
      finally { setPoolForTesting(app!); }
      assert.equal((await owner!.query("SELECT count(*)::int AS n FROM memories WHERE metadata->>'run_id'=$1",[job.runId])).rows[0].n,0,boundary);
      assert.equal((await status(episode.episode_id)).status,'processing');
    }
    assert.ok(await withScopedClient(dbScopeFromAuth(admin),client => applySessionDistillation(client,job,loaded,facts,100,policy())));
    // Simulated process loss after commit: no inline phase ran. A replay is a no-op.
    assert.equal(await withScopedClient(dbScopeFromAuth(admin),client => applySessionDistillation(client,job,loaded,facts,100,policy())),false);
    const memoryId=(await owner!.query('SELECT memory_id FROM memory_session_derivations WHERE run_id=$1',[job.runId])).rows[0].memory_id;
    await owner!.query("UPDATE memory_session_distillation_runs SET status='processing',locked_at=now(),completed_at=NULL WHERE id=$1",[job.runId]);
    const pendingJob=(await owner!.query('SELECT * FROM memory_ingestion_jobs WHERE memory_id=$1',[memoryId])).rows[0];
    assert.ok(await withScopedClient(dbScopeFromAuth(admin),client => applySessionDistillation(client,job,loaded,facts,100,policy())));
    assert.deepEqual((await owner!.query('SELECT * FROM memory_ingestion_jobs WHERE memory_id=$1',[memoryId])).rows[0],pendingJob);
    const factJob=await claimIngestionJob(dbScopeFromAuth(admin),{ memoryId }); assert.ok(factJob);
    assert.ok(await finalizeIngestionJob(factJob,embedding));
    // Exercise the existing-source_key branch with an interrupted legacy run.
    await owner!.query("UPDATE memory_session_distillation_runs SET status='processing',locked_at=now(),completed_at=NULL WHERE id=$1",[job.runId]);
    assert.ok(await withScopedClient(dbScopeFromAuth(admin),client => applySessionDistillation(client,job,loaded,facts,100,policy())));
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM memory_session_derivations WHERE run_id=$1',[job.runId])).rows[0].n,1);
    assert.equal(await claimIngestionJob(dbScopeFromAuth(admin),{ memoryId }),null);
    assert.equal((await owner!.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1',[memoryId])).rows[0].status,'ready');
  });

  await t.test('abandoned distillation claim recovers; lost completion acknowledgement cannot regenerate facts', async () => {
    const episode=await memoryStoreSession(params(),auth); await prepare(episode.episode_id);
    await owner!.query("UPDATE memory_session_distillation_runs SET locked_at=now()-interval '10 minutes' WHERE id=$1",[episode.run_id]);
    let calls=0; const provider={ name:'synthetic',generate:async () => { calls++; return JSON.stringify({ facts }); } };
    setPoolForTesting(lostCommitPool(app!,"SET status = 'completed'"));
    try { await worker(provider); } finally { setPoolForTesting(app!); }
    assert.equal((await status(episode.episode_id)).status,'completed'); assert.equal(calls,1);
    assert.equal((await worker(provider)).providerCalls,0); assert.equal(calls,1);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM memory_session_derivations WHERE run_id=$1',[episode.run_id])).rows[0].n,1);
    assert.equal((await owner!.query("SELECT attempts FROM memory_session_distillation_runs WHERE id=$1",[episode.run_id])).rows[0].attempts,2);
  });

  await t.test('metadata edits preserve chunk leases; content edits fence vectors and generation source', async () => {
    process.env.MEMORY_INGESTION_UPDATE_ENABLED='true';
    const episode=await memoryStoreSession(params(),auth),jobs=await claim(episode.episode_id);
    await memoryUpdate({ id:jobs[0].memory_id,tags:['metadata-only'] },auth);
    assert.ok(await finalizeIngestionBatch(jobs,[embedding]));
    await owner!.query("UPDATE memory_session_distillation_runs SET status='dead',completed_at=now(),last_error_code='test_isolation' WHERE id=$1",[episode.run_id]);
    const changed=await memoryStoreSession(params(),auth), old=await claim(changed.episode_id);
    await memoryUpdate({ id:old[0].memory_id,content:'Changed transcript.' },auth);
    assert.equal(await finalizeIngestionBatch(old,[embedding]),false);
    const replacement=await claimIngestionJob(dbScopeFromAuth(admin),{ memoryId:old[0].memory_id }); assert.ok(replacement);
    assert.equal(replacement.content,'Changed transcript.'); assert.ok(await finalizeIngestionJob(replacement,embedding));
    const { job,loaded }=await prepare(changed.episode_id);
    await owner!.query('UPDATE memories SET content=$2 WHERE document_id=$1',[changed.episode_id,'Changed after generation.']);
    assert.equal(await withScopedClient(dbScopeFromAuth(admin),client => applySessionDistillation(client,job,loaded,facts,100,policy())),false);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM memory_session_derivations WHERE run_id=$1',[job.runId])).rows[0].n,0);
  });

  await t.test('generation remains fail-closed on budget, policy, secret output and changed or forgotten sources', async () => {
    let calls=0; const provider={ name:'synthetic',generate:async () => { calls++; return JSON.stringify({ facts }); } };
    const budgeted=await memoryStoreSession(params(),auth), approved=policy(); approved.budget.maxCostUsdPerSession=0.000001;
    assert.equal((await worker(provider,approved)).providerCalls,0); assert.equal(calls,0);
    assert.equal((await status(budgeted.episode_id)).last_error_code,'session_budget_exhausted');
    const expired=policy(); expired.termsApproval.expiresAt='2020-01-02T00:00:00Z';
    await assert.rejects(worker(provider,expired),/expired/); assert.equal(calls,0);
    const changed=await memoryStoreSession(params(),auth);
    await worker({ name:'synthetic',generate:async () => {
      await owner!.query('UPDATE memories SET content=$2 WHERE document_id=$1',[changed.episode_id,'changed while generating']);
      return JSON.stringify({ facts });
    } });
    assert.equal((await status(changed.episode_id)).last_error_code,'source_changed');
    const forgotten=await memoryStoreSession(params(),auth);
    await owner!.query('UPDATE memories SET deleted_at=now() WHERE document_id=$1',[forgotten.episode_id]);
    assert.equal((await worker(provider)).providerCalls,0); assert.equal((await status(forgotten.episode_id)).last_error_code,'source_unavailable');
    const credential=await memoryStoreSession(params(),auth);
    await worker({ name:'synthetic',generate:async () => '{"facts":[{"kind":"fact","content":"api_key = synthetic-secret"}]}' });
    const rejected=await status(credential.episode_id); assert.equal(rejected.status,'retry'); assert.equal(rejected.facts_stored,0);
  });

  await t.test('real owner-or-admin INSERT RLS retains namespace boundary and owner attribution', async () => {
    const memoryId=(await owner!.query("INSERT INTO memories(content,source,namespace,client_id,memory_kind,valid_from) VALUES('synthetic owner fact','test','shared',$1,'semantic',now()) RETURNING id",[auth.keyId])).rows[0].id;
    await assert.rejects(withScopedClient(dbScopeFromAuth(other),c => acceptSessionFact(c,memoryId,'shared')),/row-level security/);
    await withScopedClient(dbScopeFromAuth(admin),c => acceptSessionFact(c,memoryId,'shared'));
    assert.equal((await owner!.query('SELECT client_id FROM memory_ingestion_jobs WHERE memory_id=$1',[memoryId])).rows[0].client_id,auth.keyId);
    await assert.rejects(withScopedClient(dbScopeFromAuth(admin),c => c.query(`INSERT INTO memory_ingestion_jobs
      (memory_id,namespace,client_id,access_level,allowed_namespaces,dedupe,contradiction_eligible,embedding_provider,embedding_model,embedding_dimensions)
      VALUES(gen_random_uuid(),'outside',$1,'normal',ARRAY['outside'],false,false,$2,$3,768)`,[auth.keyId,embedding.provider,embedding.model])),/row-level security/);
  });

  await t.test('episode insert and readiness never enqueue entities or subscriptions; fact readiness notifies exactly once', async () => {
    const subscription=(await owner!.query(`INSERT INTO memory_subscriptions
      (api_key_id,query_text,query_embedding,embedding_provider,embedding_model,embedding_dimensions,threshold,exclude_self,
       webhook_url_ciphertext,webhook_url_iv,webhook_url_tag,signing_secret_ciphertext,signing_secret_iv,signing_secret_tag,
       encryption_key_id,idempotency_key,request_hash)
      VALUES($1,'fixture',$2::vector,$3,$4,768,0.5,false,'x',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),
       'x',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'test','session-once',repeat('a',64)) RETURNING id`,
      [other.keyId,JSON.stringify(vector),embedding.provider,embedding.model])).rows[0].id;
    await owner!.query('INSERT INTO subscription_namespaces(subscription_id,api_key_id,namespace) VALUES($1,$2,$3)',[subscription,other.keyId,'shared']);
    await owner!.query('ALTER TABLE memories ENABLE TRIGGER memories_subscription_enqueue; ALTER TABLE memories ENABLE TRIGGER memories_subscription_ready_enqueue; ALTER TABLE memories ENABLE TRIGGER memories_entity_enrichment_enqueue');
    const episode=await memoryStoreSession(params(),auth),jobs=await claim(episode.episode_id);
    const sideEffects=async () => (await owner!.query(`SELECT
      (SELECT count(*)::int FROM entity_enrichment_queue WHERE memory_id=ANY($1::uuid[])) AS entities,
      (SELECT count(*)::int FROM webhook_deliveries WHERE memory_id=ANY($1::uuid[])) AS webhooks`,[jobs.map(job => job.memory_id)])).rows[0];
    assert.deepEqual(await sideEffects(),{ entities:0,webhooks:0 });
    assert.ok(await finalizeIngestionBatch(jobs,jobs.map(() => embedding)));
    assert.deepEqual(await sideEffects(),{ entities:0,webhooks:0 });
    await worker(); const memoryId=(await owner!.query('SELECT memory_id FROM memory_session_derivations WHERE run_id=$1',[episode.run_id])).rows[0].memory_id;
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE memory_id=$1',[memoryId])).rows[0].n,0);
    const job=await claimIngestionJob(dbScopeFromAuth(admin),{ memoryId }); assert.ok(job);
    assert.ok(await finalizeIngestionJob(job,embedding)); assert.equal(await finalizeIngestionJob(job,embedding),null);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE memory_id=$1',[memoryId])).rows[0].n,1);
  });

  await t.test('actual MCP registration and status flows are owner-scoped and content-free', async () => {
    const server=new Server({ name:'session-test',version:'1' },{ capabilities:{ tools:{} } }); registerTools(server,async () => auth);
    const client=new Client({ name:'session-client',version:'1' }); const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const listed=await client.listTools(); assert.ok(listed.tools.some(tool => tool.name==='memory_store_session'));
      const stored=await client.callTool({ name:'memory_store_session',arguments:params() }); assert.ok(!stored.isError);
      const episode=JSON.parse((stored.content as any[])[0].text);
      const result=await client.callTool({ name:'memory_session_status',arguments:{ episode_id:episode.episode_id } }); assert.ok(!result.isError);
      const observed=JSON.parse((result.content as any[])[0].text); assert.equal(observed.embedding.episode.state,'queued');
      assert.deepEqual(Object.keys(observed).sort(),['attempts','embedding','episode_id','facts_stored','last_error_code','run_id','status']);
      assert.ok(!JSON.stringify(observed).includes('PostgreSQL')); await assert.rejects(status(episode.episode_id,other),/not found/);
      // The dedicated admin sees owner jobs within its namespace but status remains explicitly owned.
      await assert.rejects(status(episode.episode_id,admin),/not found/);
      assert.equal((await withScopedClient(dbScopeFromAuth(other),c => c.query('SELECT * FROM memory_ingestion_jobs WHERE document_id=$1',[episode.episode_id]))).rows.length,0);
      assert.equal((await withScopedClient(dbScopeFromAuth(admin),c => c.query('SELECT * FROM memory_ingestion_jobs WHERE document_id=$1',[episode.episode_id]))).rows.length,1);
      process.env.MEMORY_SESSION_TOOLS_ENABLED='false';
      assert.ok(!(await client.listTools()).tools.some(tool => tool.name==='memory_store_session'));
      assert.equal((await client.callTool({ name:'memory_session_status',arguments:{ episode_id:episode.episode_id } })).isError,true);
    } finally { delete process.env.MEMORY_SESSION_TOOLS_ENABLED; await client.close(); await server.close(); }
  });
});
