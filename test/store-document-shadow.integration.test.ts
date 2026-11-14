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

test('durable document batches preserve versioned shadow publication on current lineage', { timeout:240000 }, async t => {
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
  const rollback=process.env.DOCUMENT_TEST_ROLLBACK==='true';
  if (rollback) {
    process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES='true';
    await owner.query("UPDATE embedding_serving_settings SET rollback_writes_enabled=true,rollback_inputs_per_minute=1000,rollback_until=statement_timestamp()+interval '1 hour'");
  } else delete process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
  process.env.MEMORY_INGESTION_QUEUE_ENABLED='true'; process.env.MEMORY_INGESTION_DOCUMENT_ENABLED='true';
  process.env.MEMORY_INGESTION_UPDATE_ENABLED='true'; process.env.MEMORY_STORE_INLINE_EMBED_MS='0';
  const key=randomUUID(), adminKey=randomUUID();
  const auth:AuthContext={ keyId:key,name:'shadow-document-owner',namespaces:['personal'],permissions:['read','write','delete','export'],maxAccessLevel:'normal' };
  const admin:AuthContext={ ...auth,keyId:adminKey,name:'shadow-document-worker',permissions:['read','write','admin'] };
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
  const { memoryStoreDocument }=await import('../src/tools/store-document.js');
  const { memoryUpdate }=await import('../src/tools/update.js');
  const { memoryDocumentStatus }=await import('../src/tools/document-status.js');
  const { claimIngestionJobs,embedBatchWithinBudget,finalizeIngestionBatch,requeueDocument }=await import('../src/ingestion.js');
  const { runIngestionWorker }=await import('../src/ingestion-worker.js');
  const { ACTIVE_EMBEDDING_PROFILE }=await import('../src/embedding.js');
  const params=(count:number,key?:string) => ({ title:key ?? randomUUID(),content:'m'.repeat(count*2000),namespace:'personal',source:'document-shadow-test',tags:[],...(key ? { idempotency_key:key } : {}) });
  const status=(id:string) => memoryDocumentStatus({ document_id:id },auth);
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

  await t.test('capture acceptance rolls back with document jobs before any provider work',async () => {
    const before=(await owner!.query("SELECT count(*)::int AS n FROM embedding_work_items WHERE parent_type='memory'")).rows[0].n;
    await owner!.query("CREATE FUNCTION reject_shadow_document_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.chunk_index=1 THEN RAISE EXCEPTION 'synthetic acceptance rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_shadow_document_job BEFORE INSERT ON memory_ingestion_jobs FOR EACH ROW EXECUTE FUNCTION reject_shadow_document_job()");
    try { await assert.rejects(memoryStoreDocument(params(3,'shadow-acceptance-failure'),auth),/synthetic acceptance rollback/); }
    finally { await owner!.query('DROP TRIGGER reject_shadow_document_job ON memory_ingestion_jobs; DROP FUNCTION reject_shadow_document_job()'); }
    assert.equal((await owner!.query("SELECT count(*)::int AS n FROM embedding_work_items WHERE parent_type='memory'")).rows[0].n,before);
    assert.equal((await owner!.query("SELECT count(*)::int AS n FROM documents WHERE idempotency_key='shadow-acceptance-failure'")).rows[0].n,0);
  });
  await t.test('inline batch is ready only with every current target manifest and one target event per chunk',async () => {
    process.env.MEMORY_STORE_INLINE_EMBED_MS='10000';
    const doc=await memoryStoreDocument(params(2,'shadow-inline'),auth);
    process.env.MEMORY_STORE_INLINE_EMBED_MS='0';
    assert.equal(doc.state,'ready'); await assertComplete(doc.document_id,2); assert.equal(await events(doc.document_id),2);
    assert.equal((await memoryStoreDocument(params(2,'shadow-inline'),auth)).document_id,doc.document_id);
    assert.equal(await events(doc.document_id),2);
  });
  await t.test('batch vectors, target manifests, capture completion and events finalize atomically under the lease',async () => {
    const input=params(3,'shadow-atomic'),doc=await memoryStoreDocument(input,auth); assert.equal(doc.state,'queued');
    const jobs=await claim(doc.document_id), prepared=await embedBatchWithinBudget(jobs.map(job => job.content),30000);
    assert.ok(prepared.every(result => 'localPrepared' in result && (result as any).localPrepared.vectors.length>1));
    await assert.rejects(finalizeIngestionBatch(jobs,prepared.map(result => ({ ...result,localPrepared:undefined }))),/ingestion_vectors_required/);
    await memoryUpdate({ id:jobs[0].memory_id,tags:['metadata-only'] },auth);
    await owner!.query(`CREATE FUNCTION reject_shadow_document_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.parent_id='${jobs[1].memory_id}' THEN RAISE EXCEPTION 'synthetic target rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_shadow_document_publish BEFORE INSERT OR UPDATE ON memory_embedding_manifests FOR EACH ROW EXECUTE FUNCTION reject_shadow_document_publish()`);
    try { await assert.rejects(finalizeIngestionBatch(jobs,prepared),/synthetic target rollback/); }
    finally { await owner!.query('DROP TRIGGER reject_shadow_document_publish ON memory_embedding_manifests; DROP FUNCTION reject_shadow_document_publish()'); }
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM memories WHERE document_id=$1 AND embedding IS NOT NULL',[doc.document_id])).rows[0].n,0);
    assert.ok((await manifests(doc.document_id)).every(row => !row.is_current)); assert.equal(await events(doc.document_id),0);
    assert.equal(await finalizeIngestionBatch(jobs,prepared),true); await assertComplete(doc.document_id,3);
    assert.equal((await status(doc.document_id)).state,'ready'); assert.equal(await events(doc.document_id),3);
    assert.equal(await finalizeIngestionBatch(jobs,prepared),false); assert.equal(await events(doc.document_id),3);
    assert.equal((await memoryStoreDocument(input,auth)).state,'ready');
  });
  await t.test('wrong physical profile fails the whole batch without publishing any target manifest',async () => {
    const doc=await memoryStoreDocument(params(2),auth),jobs=await claim(doc.document_id);
    const prepared=await embedBatchWithinBudget(jobs.map(job => job.content),30000);
    assert.equal(await finalizeIngestionBatch(jobs,prepared.map(result => ({ ...result,model:'wrong-profile' }))),false);
    assert.equal((await status(doc.document_id)).failed,2); assert.ok((await manifests(doc.document_id)).every(row => !row.is_current));
    assert.equal(await events(doc.document_id),0); assert.deepEqual(await requeueDocument(doc.document_id,admin),{ requeued:2 });
  });
  await t.test('new content generation fences all target publication and then scalar/update and batch workers drain correctly',async () => {
    const doc=await memoryStoreDocument(params(3),auth),jobs=await claim(doc.document_id);
    const prepared=await embedBatchWithinBudget(jobs.map(job => job.content),30000);
    await memoryUpdate({ id:jobs[0].memory_id,content:'n'.repeat(2000) },auth);
    assert.equal(await finalizeIngestionBatch(jobs,prepared),false); assert.ok((await manifests(doc.document_id)).every(row => !row.is_current));
    process.env.INGESTION_WORKER_API_KEY='tr_shadow-document-worker';
    // Ignore a deliberately failed profile-test document in this worker boundary.
    await owner!.query("UPDATE memory_ingestion_jobs SET next_attempt_at=statement_timestamp()+interval '1 day' WHERE document_id<>$1 AND status='pending'",[doc.document_id]);
    await runIngestionWorker({ once:true,maxJobs:3,pollMs:100,concurrency:1,batchSize:16 },new AbortController().signal);
    assert.equal((await status(doc.document_id)).state,'ready'); await assertComplete(doc.document_id,3); assert.equal(await events(doc.document_id),2);
  });
  if (rollback) assert.ok(legacyCalls>0); else assert.equal(legacyCalls,0);
});
