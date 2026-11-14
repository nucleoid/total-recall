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
import { createDocumentIdempotencyIndex } from '../scripts/document-idempotency-index.js';
import { LocalEmbeddingClient } from '../src/local-embedding-client.js';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import { setLocalServingClientForTesting } from '../src/local-embedding-runtime.js';
import { dbScopeFromAuth, setPoolForTesting } from '../src/db.js';
import { hashKey } from '../src/auth.js';
import { activateAttestedServing } from './shadow-embedding-fixtures.js';
import type { AuthContext } from '../src/types.js';

test('queued episodes and generated facts preserve local target publication and rollback', { timeout:240000 }, async t => {
  const port=await new Promise<number>((resolve,reject) => {
    const server=createServer(); server.once('error',reject); server.listen(0,'127.0.0.1',() => {
      const port=(server.address() as { port:number }).port; server.close(error => error ? reject(error) : resolve(port));
    });
  });
  const container=execFileSync('docker',['run','--rm','-d','-e','POSTGRES_PASSWORD=test-only','-e','POSTGRES_DB=total_recall_reembedding_test','-p',`127.0.0.1:${port}:5432`,process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16'],{ encoding:'utf8' }).trim();
  const url=`postgresql://postgres:test-only@127.0.0.1:${port}/total_recall_reembedding_test`;
  let ownerPool:pg.Pool | undefined, owner:pg.PoolClient | undefined, app:pg.Pool | undefined;
  const env={ ...process.env }, originalFetch=globalThis.fetch;
  t.after(async () => {
    setPoolForTesting(null); if (process.env.NODE_ENV==='test') setLocalServingClientForTesting(undefined); process.env=env; globalThis.fetch=originalFetch;
    await app?.end(); owner?.release(); await ownerPool?.end();
    execFileSync('docker',['rm','-f',container],{ stdio:'ignore' });
  });
  for (let index=0; index<300; index++) {
    const candidate=new pg.Pool({ connectionString:url,connectionTimeoutMillis:2000 });
    try { owner=await candidate.connect(); ownerPool=candidate; break; }
    catch { await candidate.end(); await new Promise(resolve => setTimeout(resolve,200)); }
  }
  assert.ok(owner);
  await owner.query('CREATE EXTENSION vector');
  await provisionDatabase(owner,{ appPassword:'app-test-only',rotateAppPassword:false });
  await runMigrations(owner,loadMigrationInventory(fileURLToPath(new URL('../migrations',import.meta.url))),{ lockTimeoutMs:5000 });
  await finalizeMemoryValidity(owner); await createDocumentIdempotencyIndex({ connectionString:url });
  await activateAttestedServing(owner);
  process.env.NODE_ENV='test'; process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT=QWEN_CONTRACT_ID;
  const rollback=process.env.SESSION_TEST_ROLLBACK==='true';
  if (rollback) {
    process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES='true';
    await owner.query("UPDATE embedding_serving_settings SET rollback_writes_enabled=true,rollback_inputs_per_minute=1000,rollback_until=statement_timestamp()+interval '1 hour'");
  } else delete process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
  process.env.MEMORY_INGESTION_QUEUE_ENABLED='true'; process.env.MEMORY_INGESTION_SESSION_ENABLED='true';
  process.env.MEMORY_INGESTION_UPDATE_ENABLED='true'; process.env.MEMORY_STORE_INLINE_EMBED_MS='0';
  const key=randomUUID(), adminKey=randomUUID();
  const auth:AuthContext={ keyId:key,name:'shadow-session-owner',namespaces:['personal'],permissions:['read','write','delete','export'],maxAccessLevel:'normal' };
  const admin:AuthContext={ ...auth,keyId:adminKey,name:'shadow-session-worker',permissions:['read','write','admin'] };
  for (const actor of [auth,admin]) await owner.query('INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level) VALUES($1,$2,$3,$4,$5,$6)',[actor.keyId,hashKey(`tr_${actor.name}`),actor.name,actor.namespaces,actor.permissions,actor.maxAccessLevel]);
  app=new pg.Pool({ connectionString:`postgresql://total_recall_app:app-test-only@127.0.0.1:${port}/total_recall_reembedding_test` }); setPoolForTesting(app);
  const vector=Array.from({ length:768 },(_,index) => index===0 ? 1 : 0);
  let legacyCalls=0;
  globalThis.fetch=async (_,options) => {
    assert.ok(rollback,'local document writes must not call a cloud provider'); legacyCalls++;
    const body=JSON.parse(String(options?.body));
    return Response.json(body.requests ? { embeddings:body.requests.map(() => ({ values:vector })) } : { embedding:{ values:vector } });
  };
  const local=new LocalEmbeddingClient({ baseUrl:'http://localhost:1234',bearerToken:'synthetic',
    runtime:{ contractId:QWEN_CONTRACT_ID,artifactSha256:QWEN_CHUNK_CONTRACT.artifactSha256,runtimeContract:QWEN_CHUNK_CONTRACT.runtimeContract,acceptanceReceiptSha256:'e'.repeat(64) },
    beforeInference:async () => {},fetch:(async (target,options) => {
      const body=JSON.parse(String(options?.body));
      const tokens=(text:string) => Math.max(1,Math.ceil(Buffer.byteLength(text)/4));
      if (String(target).endsWith('/tokenize')) return Response.json({ tokens:Array(tokens(body.content)).fill(1) });
      return Response.json({ data:body.input.map((_:string,index:number) => ({ index,embedding:Array.from({ length:QWEN_CHUNK_CONTRACT.nativeDimensions },(_,i) => i===0 ? 1 : 0) })),
        usage:{ prompt_tokens:body.input.reduce((sum:number,text:string) => sum+tokens(text),0) } });
    }) as typeof fetch });
  setLocalServingClientForTesting(local);
  // Select the active physical profile only after the versioned serving environment is set.
  const { memoryStoreSession,memorySessionStatus,storeSessionSchema,parseSessionDistillationPolicy }=await import('../src/session-distillation.js');
  const { runSessionWorker }=await import('../scripts/session-distill.js');
  const { memoryUpdate }=await import('../src/tools/update.js');
  const { claimIngestionJobs,embedBatchWithinBudget,finalizeIngestionBatch,requeueDocument,claimIngestionJob,embedWithinBudget,finalizeIngestionJob }=await import('../src/ingestion.js');
  const { runIngestionWorker }=await import('../src/ingestion-worker.js');
  const { ACTIVE_EMBEDDING_PROFILE }=await import('../src/embedding.js');
  const params=(count:number) => storeSessionSchema.parse({ session_id:randomUUID(),transcript:'m'.repeat(count*2000),namespace:'personal' });
  const status=(id:string) => memorySessionStatus({ episode_id:id },auth);
  const claim=(id:string) => claimIngestionJobs(dbScopeFromAuth(admin),{ documentId:id,limit:16 });
  const manifests=async (id:string) => (await owner!.query(`SELECT m.id,m.revision,f.source_revision,f.is_current,f.chunk_count,
    f.source_sha256=encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex') AS matching,
    m.embedding_provider,m.embedding_model,(SELECT count(*)::int FROM memory_embedding_chunks c WHERE c.parent_id=m.id AND c.contract_id=f.contract_id) AS actual
    FROM memories m LEFT JOIN memory_embedding_manifests f ON f.parent_id=m.id AND f.contract_id=$2 WHERE m.document_id=$1 ORDER BY m.chunk_index`,[id,QWEN_CONTRACT_ID])).rows;
  const assertComplete=async (id:string,count:number) => {
    const rows=await manifests(id); assert.equal(rows.length,count);
    assert.ok(rows.every(row => row.is_current && row.matching && row.revision===row.source_revision && row.chunk_count===row.actual && row.actual>1));
    assert.ok(rows.every(row => row.embedding_provider===ACTIVE_EMBEDDING_PROFILE.provider && row.embedding_model===ACTIVE_EMBEDDING_PROFILE.model));
  };
  const subscription=randomUUID();
  await owner.query(`INSERT INTO memory_subscriptions(id,api_key_id,query_text,query_embedding,embedding_provider,embedding_model,embedding_dimensions,threshold,exclude_self,
    webhook_url_ciphertext,webhook_url_iv,webhook_url_tag,signing_secret_ciphertext,signing_secret_iv,signing_secret_tag,encryption_key_id,idempotency_key,request_hash,created_at)
    VALUES($1,$2,'target query',$3::vector,'llama.cpp',$4,768,0.9,false,decode('00','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),decode('00','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'test',($1::uuid)::text,repeat('a',64),clock_timestamp()-interval '1 second')`,[subscription,key,JSON.stringify(vector),QWEN_CONTRACT_ID]);
  await owner.query("INSERT INTO subscription_namespaces(subscription_id,api_key_id,namespace) VALUES($1,$2,'personal')",[subscription,key]);
  await owner.query("INSERT INTO subscription_embedding_targets(contract_id,subscription_id,source_sha256,formatted_tokens,embedding) VALUES($1,$2,encode(digest('target query','sha256'),'hex'),8,$3::vector)",[QWEN_CONTRACT_ID,subscription,JSON.stringify(vector)]);
  await owner.query('ALTER TABLE memories ENABLE TRIGGER memories_subscription_enqueue; ALTER TABLE memories ENABLE TRIGGER memories_subscription_ready_enqueue');
  const events=async (id:string) => (await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE memory_id IN (SELECT id FROM memories WHERE document_id=$1)',[id])).rows[0].n;


  const approval={ approved:true,approvedBy:'synthetic',approvedAt:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z' };
  const policy=parseSessionDistillationPolicy({ version:1,feature:'memory-session-distillation',environment:'test',
    generation:{ provider:'synthetic',model:'synthetic',endpoint:'https://example.test/generate',credentialEnv:'SESSION_TEST_KEY' },
    terms:{ reference:'synthetic/57',privacyApproved:true,retentionApproved:true,trainingApproved:true },
    scope:{ namespaces:['personal'],accessLevel:'normal' },budget:{ maxInputBytesPerSession:1100000,maxOutputBytesPerSession:65536,
      maxCostUsdPerSession:1,maxCostUsdPerMonth:100,estimatedRequestCostUsd:0.001,estimatedInputCostUsdPerMillionBytes:1,
      estimatedOutputCostUsdPerMillionBytes:4,monthlyControlReference:'synthetic' },
    providerModelApproval:approval,termsApproval:approval,scopeApproval:approval,budgetApproval:approval },'test');
  const sessionWorker=() => runSessionWorker({ once:true,maxJobs:1,pollMs:100 },new AbortController().signal,{
    policy,auth:admin,provider:{ name:'synthetic',generate:async () => JSON.stringify({ facts:[{ content:'f'.repeat(3000),kind:'fact' }] }) } });

  await t.test('pending episodes capture target work, finalize all chunks atomically, and never notify',async () => {
    const input=params(3),episode=await memoryStoreSession(input,auth);
    assert.equal(episode.state,'queued');
    assert.equal((await owner!.query("SELECT count(*)::int AS n FROM embedding_work_items WHERE parent_type='memory' AND parent_id IN (SELECT id FROM memories WHERE document_id=$1)",[episode.episode_id])).rows[0].n,3);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM shadow_subscription_insert_events WHERE memory_id IN (SELECT id FROM memories WHERE document_id=$1)',[episode.episode_id])).rows[0].n,0);
    // Older API builds captured episode events before migration 053. They must stay excluded too.
    await owner!.query(`INSERT INTO shadow_subscription_insert_events(memory_id,contract_id,source_revision,inserted_at)
      SELECT id,$2,revision,clock_timestamp() FROM memories WHERE document_id=$1`,[episode.episode_id,QWEN_CONTRACT_ID]);
    const jobs=await claim(episode.episode_id),prepared=await embedBatchWithinBudget(jobs.map(job => job.content),30000);
    await memoryUpdate({ id:jobs[0].memory_id,tags:['metadata-only'] },auth);
    assert.ok(await finalizeIngestionBatch(jobs,prepared)); await assertComplete(episode.episode_id,3);
    assert.equal((await status(episode.episode_id)).embedding?.episode.state,'ready');
    assert.equal(await events(episode.episode_id),0);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM entity_enrichment_queue WHERE memory_id IN (SELECT id FROM memories WHERE document_id=$1)',[episode.episode_id])).rows[0].n,0);
    assert.equal(await finalizeIngestionBatch(jobs,prepared),false);
    assert.equal((await memoryStoreSession(input,auth)).episode_id,episode.episode_id);
  });

  await t.test('durable generated fact jobs publish complete local manifests and one target subscription event',async () => {
    const result=await sessionWorker(); assert.deepEqual(result,{ processed:1,providerCalls:1,factsStored:1 });
    const fact=(await owner!.query('SELECT memory_id,episode_id FROM memory_session_derivations LIMIT 1')).rows[0];
    assert.equal((await status(fact.episode_id)).status,'completed');
    assert.equal((await status(fact.episode_id)).embedding?.facts.state,'queued');
    const job=await claimIngestionJob(dbScopeFromAuth(admin),{ memoryId:fact.memory_id }); assert.ok(job);
    const prepared=await embedWithinBudget(job.content,30000); assert.ok(prepared.localPrepared);
    await memoryUpdate({ id:fact.memory_id,tags:['fact-metadata'] },auth);
    assert.ok(await finalizeIngestionJob(job,prepared));
    const manifest=(await owner!.query(`SELECT f.is_current,f.source_revision=m.revision AS current_revision,
      f.source_sha256=encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex') AS matching,
      f.chunk_count=(SELECT count(*) FROM memory_embedding_chunks c WHERE c.parent_id=m.id AND c.contract_id=f.contract_id) AS complete
      FROM memories m JOIN memory_embedding_manifests f ON f.parent_id=m.id WHERE m.id=$1`,[fact.memory_id])).rows[0];
    assert.deepEqual(manifest,{ is_current:true,current_revision:true,matching:true,complete:true });
    assert.equal((await status(fact.episode_id)).embedding?.facts.state,'ready');
    assert.equal(await finalizeIngestionJob(job,prepared),null);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE memory_id=$1',[fact.memory_id])).rows[0].n,1);
    assert.equal((await sessionWorker()).providerCalls,0);
  });

  await t.test('episode lease replacement, profile mismatch and abandoned claims cannot publish stale targets',async () => {
    const episode=await memoryStoreSession(params(2),auth),jobs=await claim(episode.episode_id);
    const prepared=await embedBatchWithinBudget(jobs.map(job => job.content),30000);
    assert.equal(await finalizeIngestionBatch(jobs,prepared.map(item => ({ ...item,model:'wrong-profile' }))),false);
    assert.equal((await status(episode.episode_id)).embedding?.episode.failed,2);
    await requeueDocument(episode.episode_id,admin); const old=await claim(episode.episode_id);
    await owner!.query("UPDATE memory_ingestion_jobs SET lease_expires_at=now()-interval '1 second' WHERE document_id=$1",[episode.episode_id]);
    const current=await claim(episode.episode_id); assert.equal(await finalizeIngestionBatch(old,prepared),false);
    const currentPrepared=await embedBatchWithinBudget(current.map(job => job.content),30000);
    await memoryUpdate({ id:current[0].memory_id,content:'new episode content' },auth);
    assert.equal(await finalizeIngestionBatch(current,currentPrepared),false);
    assert.ok((await manifests(episode.episode_id)).every(row => !row.is_current));
    process.env.INGESTION_WORKER_API_KEY='tr_shadow-session-worker';
    await runIngestionWorker({ once:true,maxJobs:10,pollMs:100,concurrency:1 },new AbortController().signal);
    assert.equal((await status(episode.episode_id)).embedding?.episode.state,'ready');
    assert.equal(await events(episode.episode_id),0);
  });
  if (rollback) assert.ok(legacyCalls>0); else assert.equal(legacyCalls,0);
});
