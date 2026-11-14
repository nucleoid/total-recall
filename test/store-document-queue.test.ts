import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import request from 'supertest';
import { loadMigrationInventory, runMigrations } from '../scripts/migrate.js';
import { provisionDatabase } from '../scripts/provision-db.js';
import { finalizeMemoryValidity } from '../scripts/finalize-memory-validity.js';
import { createDocumentIdempotencyIndex } from '../scripts/document-idempotency-index.js';
import { hashKey } from '../src/auth.js';
import { dbScopeFromAuth, setPoolForTesting } from '../src/db.js';
import { ACTIVE_EMBEDDING_PROFILE, EmbeddingProviderError } from '../src/embedding.js';
import { claimIngestionJobs, finalizeIngestionBatch, failIngestionBatch, ingestionStats, requeueDocument } from '../src/ingestion.js';
import { runIngestionWorker, processIngestionBatch } from '../src/ingestion-worker.js';
import { memoryDocumentStatus } from '../src/tools/document-status.js';
import { memoryRecall } from '../src/tools/recall.js';
import { memoryUpdate } from '../src/tools/update.js';
import { memoryForget } from '../src/tools/forget.js';
import { rankMemories } from '../src/search.js';
import { exportMemoryPage, exportPageSchema } from '../src/transfer/export.js';
import { repairDocumentChunkCounts } from '../scripts/repair-document-chunk-counts.js';
import { registerTools } from '../src/tools/register.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { memoryStoreDocument } from '../src/tools/store-document.js';
import type { AuthContext } from '../src/types.js';

const auth: AuthContext = { keyId: '11111111-1111-4111-8111-111111111111', name: 'document-owner', namespaces: ['shared'], permissions: ['read','write','delete','export'], maxAccessLevel: 'secret' };
const other: AuthContext = { ...auth,keyId:'22222222-2222-4222-8222-222222222222',name:'document-other' };
const admin: AuthContext = { ...auth,keyId:'33333333-3333-4333-8333-333333333333',name:'document-admin',permissions:['read','write','admin'] };
const vector = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0);
const params = (count: number, key?: string) => ({ title: 'synthetic document', content: 'quasar '.repeat(Math.ceil(count * 2000 / 7)).slice(0, count * 2000), namespace: 'shared', source: 'test', tags: [], ...(key ? { idempotency_key: key } : {}) });

test('document queue acceptance and batching on disposable PostgreSQL', { timeout: 180000 }, async t => {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port; server.close(error => error ? reject(error) : resolve(port));
    });
  });
  const container = execFileSync('docker', ['run','--rm','-d','-e','POSTGRES_PASSWORD=test-only','-p',`127.0.0.1:${port}:5432`,process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16'], { encoding: 'utf8' }).trim();
  let owner: pg.Client | undefined; let pool: pg.Pool | undefined;
  const env = { ...process.env }; const originalFetch = globalThis.fetch;
  t.after(async () => {
    setPoolForTesting(null); await pool?.end(); await owner?.end();
    execFileSync('docker',['rm','-f',container], { stdio: 'ignore' }); process.env = env; globalThis.fetch = originalFetch;
  });
  for (let i = 0; i < 100; i++) {
    const client = new pg.Client({ connectionString: `postgresql://postgres:test-only@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    try { await client.connect(); owner = client; break; } catch { await client.end(); await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(owner);
  await owner.query('CREATE EXTENSION vector');
  await provisionDatabase(owner, { appPassword: 'app-test-only', rotateAppPassword: false });
  await runMigrations(owner, loadMigrationInventory(fileURLToPath(new URL('../migrations', import.meta.url))), { lockTimeoutMs: 5000 });
  await finalizeMemoryValidity(owner);
  await createDocumentIdempotencyIndex({ connectionString: `postgresql://postgres:test-only@127.0.0.1:${port}/postgres` });
  pool = new pg.Pool({ connectionString: `postgresql://total_recall_app:app-test-only@127.0.0.1:${port}/postgres` }); setPoolForTesting(pool);
  for (const key of [auth,other,admin]) await owner.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level) VALUES ($1,$2,$3,$4,$5,$6)`, [key.keyId,hashKey(`tr_${key.name}`),key.name,key.namespaces,key.permissions,key.maxAccessLevel]);
  process.env.MEMORY_INGESTION_QUEUE_ENABLED = 'true'; process.env.MEMORY_INGESTION_DOCUMENT_ENABLED = 'true'; process.env.MEMORY_STORE_INLINE_EMBED_MS = '1000';

  await t.test('provider offline acknowledges all durable chunks before contacting provider', async () => {
    let countsAtProvider: any[]=[];
    globalThis.fetch = async () => {
      countsAtProvider = (await owner!.query(`SELECT d.chunk_count, count(m.id)::int AS chunks FROM documents d JOIN memories m ON m.document_id=d.id GROUP BY d.id`)).rows;
      throw new Error('provider offline');
    };
    const result = await memoryStoreDocument(params(2,'offline'),auth);
    assert.equal((result as any).state,'queued');
    assert.equal(countsAtProvider.length,1); assert.equal(countsAtProvider[0].chunk_count,2); assert.equal(countsAtProvider[0].chunks,2);
    const jobs = (await owner!.query('SELECT * FROM memory_ingestion_jobs WHERE document_id=$1', [result.document_id])).rows;
    assert.equal(jobs.length,2); assert.ok(jobs.every(job => job.kind === 'document' && !job.dedupe && !job.contradiction_eligible));
    assert.equal((await owner!.query('SELECT count(*)::int AS count FROM memories WHERE document_id=$1 AND embedding IS NULL',[result.document_id])).rows[0].count,2);
  });
  await t.test('small documents use exactly one batch call and large ones make no inline call', async () => {
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++; assert.match(String(url),/batchEmbedContents/);
      const body = JSON.parse(String(options?.body)); assert.equal(body.requests.length,3);
      return new Response(JSON.stringify({ embeddings: body.requests.map(() => ({ values: vector })) }));
    };
    assert.equal((await memoryStoreDocument(params(3),auth) as any).state,'ready'); assert.equal(calls,1);
    assert.equal((await memoryStoreDocument(params(40),auth) as any).state,'queued'); assert.equal(calls,1);
  });

  const reset = async () => { await owner!.query('TRUNCATE memories,documents CASCADE'); process.env.MEMORY_STORE_INLINE_EMBED_MS='0'; globalThis.fetch=originalFetch; };
  const status = (id: string, actor=auth) => memoryDocumentStatus({ document_id:id },actor);
  const claim = (id: string,limit=16) => claimIngestionJobs(dbScopeFromAuth(admin),{ documentId:id,limit });
  const results = (count: number) => Array.from({ length:count },() => ({ ...ACTIVE_EMBEDDING_PROFILE,vector }));
  const invariant = async (id: string) => {
    const row=(await owner!.query('SELECT d.chunk_count,count(m.id)::int AS physical,count(j.memory_id)::int AS jobs FROM documents d JOIN memories m ON m.document_id=d.id LEFT JOIN memory_ingestion_jobs j ON j.memory_id=m.id WHERE d.id=$1 GROUP BY d.id',[id])).rows[0];
    assert.equal(row.chunk_count,row.physical); assert.equal(row.jobs,row.physical);
  };
  await t.test('40 chunks drain in 16/16/8 batches and no batch mixes documents or scalar jobs', async () => {
    await reset(); const doc=await memoryStoreDocument(params(40),auth);
    const calls: number[]=[];
    globalThis.fetch=async (_,options) => { const body=JSON.parse(String(options?.body)); calls.push(body.requests.length); return new Response(JSON.stringify({ embeddings:body.requests.map(() => ({ values:vector })) })); };
    process.env.INGESTION_WORKER_API_KEY='tr_document-admin';
    assert.deepEqual(await runIngestionWorker({ once:true,maxJobs:40,pollMs:100,concurrency:1,batchSize:16 },new AbortController().signal),{ processed:40 });
    assert.deepEqual(calls,[16,16,8]); assert.equal((await status(doc.document_id)).state,'ready'); await invariant(doc.document_id);
    const a=await memoryStoreDocument(params(2),auth), b=await memoryStoreDocument(params(2),auth);
    const batches=await Promise.all([claimIngestionJobs(dbScopeFromAuth(admin),{ limit:64 }),claimIngestionJobs(dbScopeFromAuth(admin),{ limit:64 })]);
    assert.ok(batches.flat().length===4);
    for (const batch of batches) assert.ok(batch.every(job => job.document_id===batch[0].document_id));
    assert.deepEqual(new Set(batches.flat().map(job => job.document_id)),new Set([a.document_id,b.document_id]));
  });
  await t.test('replay across queued, partial, failed and ready states never calls provider or creates rows', async () => {
    await reset(); const input=params(3,'replay'), doc=await memoryStoreDocument(input,auth);
    globalThis.fetch=async () => { throw new Error('replay must not embed'); };
    assert.equal((await memoryStoreDocument(input,auth)).document_id,doc.document_id);
    const first=await claim(doc.document_id,1); assert.equal(first[0].chunk_index,0);
    await finalizeIngestionBatch(first,results(1));
    let state=await status(doc.document_id); assert.equal(state.ready,1); assert.equal(state.queued,2);
    assert.equal((await memoryStoreDocument(input,auth)).state,'queued');
    const rest=await claim(doc.document_id); await failIngestionBatch(rest,new EmbeddingProviderError(400));
    assert.equal((await memoryStoreDocument(input,auth)).state,'embedding_failed');
    await assert.rejects(memoryStoreDocument({ ...input,title:'changed' },auth),/different document/);
    assert.deepEqual(await requeueDocument(doc.document_id,admin),{ requeued:2 });
    await finalizeIngestionBatch(await claim(doc.document_id),results(2));
    assert.equal((await memoryStoreDocument(input,auth)).state,'ready');
    await invariant(doc.document_id);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM documents')).rows[0].n,1);
    await owner!.query('UPDATE memories SET deleted_at=now() WHERE document_id=$1 AND chunk_index=1',[doc.document_id]);
    await assert.rejects(memoryStoreDocument(input,auth),error => (error as any).code==='idempotency_key_tombstoned');
    assert.equal((await status(doc.document_id)).cancelled,1);
  });
  await t.test('acceptance failures roll back document, every chunk, jobs and audit before provider work', async () => {
    await reset(); let calls=0; globalThis.fetch=async () => { calls++; throw new Error('unexpected provider'); };
    await owner!.query(`CREATE FUNCTION reject_document_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.chunk_index=1 THEN RAISE EXCEPTION 'synthetic acceptance failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_document_job BEFORE INSERT ON memory_ingestion_jobs FOR EACH ROW EXECUTE FUNCTION reject_document_job()`);
    try { await assert.rejects(memoryStoreDocument(params(3,'acceptance-crash'),auth),/synthetic acceptance failure/); }
    finally { await owner!.query('DROP TRIGGER reject_document_job ON memory_ingestion_jobs; DROP FUNCTION reject_document_job()'); }
    for (const table of ['documents','memories','memory_ingestion_jobs']) assert.equal((await owner!.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
    assert.equal(calls,0);
    const doc=await memoryStoreDocument(params(3,'acceptance-crash'),auth); await invariant(doc.document_id);
  });
  await t.test('crashes after claim/provider and inside finalize recover without partial vectors or duplicate effects', async () => {
    await reset(); const doc=await memoryStoreDocument(params(3),auth);
    const abandoned=await claim(doc.document_id); await invariant(doc.document_id);
    await owner!.query(`UPDATE memory_ingestion_jobs SET lease_expires_at=now()-interval '1 second' WHERE document_id=$1`,[doc.document_id]);
    const current=await claim(doc.document_id);
    assert.notEqual(current[0].lease_token,abandoned[0].lease_token);
    assert.equal(await finalizeIngestionBatch(abandoned,results(3)),false);
    await failIngestionBatch(abandoned,new Error('stale failure'));
    assert.equal((await status(doc.document_id)).queued,3);
    await owner!.query(`CREATE FUNCTION reject_document_vector() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.chunk_index=1 AND NEW.embedding IS NOT NULL THEN RAISE EXCEPTION 'synthetic finalize crash'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_document_vector BEFORE UPDATE OF embedding ON memories FOR EACH ROW EXECUTE FUNCTION reject_document_vector()`);
    try { await assert.rejects(finalizeIngestionBatch(current,results(3)),/synthetic finalize crash/); }
    finally { await owner!.query('DROP TRIGGER reject_document_vector ON memories; DROP FUNCTION reject_document_vector()'); }
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM memories WHERE embedding IS NOT NULL')).rows[0].n,0);
    assert.equal((await status(doc.document_id)).ready,0); await invariant(doc.document_id);
    assert.equal(await finalizeIngestionBatch(current,results(3)),true);
    assert.equal(await finalizeIngestionBatch(current,results(3)),false);
    assert.equal((await status(doc.document_id)).ready,3);
    assert.equal((await owner!.query("SELECT count(*)::int AS n FROM audit_log WHERE action='memory.ingest.ready' AND memory_id=ANY($1::uuid[])",[current.map(job => job.memory_id)])).rows[0].n,3);
  });
  await t.test('batch response count/profile errors and provider failures affect the whole batch with shared retry', async () => {
    await reset(); const doc=await memoryStoreDocument(params(3),auth); const jobs=await claim(doc.document_id);
    await assert.rejects(finalizeIngestionBatch(jobs,results(2)),/count/);
    assert.equal((await status(doc.document_id)).ready,0);
    await failIngestionBatch(jobs,new EmbeddingProviderError(429,'120'));
    const retries=(await owner!.query('SELECT * FROM memory_ingestion_jobs WHERE document_id=$1',[doc.document_id])).rows;
    assert.ok(retries.every(job => job.status==='retry_wait' && job.failure_category==='rate_limited'));
    assert.equal(new Set(retries.map(job => job.next_attempt_at.toISOString())).size,1);
    await owner!.query('UPDATE memory_ingestion_jobs SET next_attempt_at=now() WHERE document_id=$1',[doc.document_id]);
    const next=await claim(doc.document_id); await finalizeIngestionBatch(next,results(3).map(result => ({ ...result,model:'different-space' })));
    const state=await status(doc.document_id); assert.equal(state.failed,3); assert.equal(state.failure_categories.space_mismatch,3); assert.equal(state.ready,0);
  });
  await t.test('status is owner/read/namespace/access scoped, content-free through MCP and REST; requeue is scoped admin only', async () => {
    await reset(); const doc=await memoryStoreDocument(params(4),auth);
    const ready=await claim(doc.document_id,1); await finalizeIngestionBatch(ready,results(1));
    const failed=await claim(doc.document_id,1); await failIngestionBatch(failed,new EmbeddingProviderError(400));
    const cancelled=await claim(doc.document_id,1);
    await owner!.query("UPDATE memory_ingestion_jobs SET status='cancelled',lease_token=NULL WHERE memory_id=$1",[cancelled[0].memory_id]);
    const summary=await status(doc.document_id); assert.equal(summary.ready,1); assert.equal(summary.queued,1); assert.equal(summary.failed,1); assert.equal(summary.cancelled,1);
    assert.doesNotMatch(JSON.stringify(summary),/quasar|synthetic|content|test-only/);
    for (const actor of [other,admin,{ ...auth,namespaces:['private'] },{ ...auth,permissions:['write'] }]) await assert.rejects(status(doc.document_id,actor));
    await assert.rejects(requeueDocument(doc.document_id,auth),/Permission denied/);
    await assert.rejects(requeueDocument(doc.document_id,{ ...admin,namespaces:['private'] }),/unavailable/);
    const handlers=new Map<any,any>(); registerTools({ setRequestHandler:(schema:any,handler:any) => handlers.set(schema,handler) } as any,async () => auth);
    assert.ok((await handlers.get(ListToolsRequestSchema)()).tools.some((tool:any) => tool.name==='memory_document_status'));
    const mcp=await handlers.get(CallToolRequestSchema)({ params:{ name:'memory_document_status',arguments:{ document_id:doc.document_id } } });
    const mcpStatus=JSON.parse(mcp.content[0].text);
    assert.ok(mcpStatus.oldest_pending_age_seconds>=summary.oldest_pending_age_seconds!);
    assert.deepEqual({ ...mcpStatus,oldest_pending_age_seconds:null },{ ...summary,oldest_pending_age_seconds:null });
    const { app }=await import('../src/server.js');
    assert.equal((await request(app).get(`/api/documents/${doc.document_id}/status`)).status,401);
    const response=await request(app).get(`/api/documents/${doc.document_id}/status`).set('Authorization','Bearer tr_document-owner');
    assert.equal(response.status,200); assert.equal(response.body.failed,1);
    assert.equal((await request(app).get(`/api/documents/${doc.document_id}/status`).set('Authorization','Bearer tr_document-other')).status,404);
    assert.equal((await request(app).post(`/api/ingestion/documents/${doc.document_id}/requeue`).set('Authorization','Bearer tr_document-owner')).status,403);
    const requeued=await request(app).post(`/api/ingestion/documents/${doc.document_id}/requeue`).set('Authorization','Bearer tr_document-admin');
    assert.equal(requeued.status,200); assert.deepEqual(requeued.body,{ requeued:2 });
    const now=await status(doc.document_id); assert.equal(now.ready,1); assert.equal(now.queued,3);
    assert.equal((await owner!.query("SELECT count(*)::int AS n FROM audit_log WHERE action='ingestion.document.requeue' AND resource_id=$1",[doc.document_id])).rows[0].n,1);
    const secret=(await owner!.query("INSERT INTO documents(title,source,namespace,client_id,access_level) VALUES ('private','test','shared',$1,'secret') RETURNING id",[auth.keyId])).rows[0].id;
    await assert.rejects(status(secret,{ ...auth,maxAccessLevel:'normal' }));
  });
  await t.test('pending chunks are ordered in recall, FTS and export; vector search excludes them and repair counts physical rows', async () => {
    await reset(); const doc=await memoryStoreDocument(params(3),auth);
    const recalled=await memoryRecall({ document_id:doc.document_id },auth);
    assert.deepEqual(recalled.map(row => row.chunk_index),[0,1,2]); assert.ok(recalled.every(row => row.ingestion?.state==='pending'));
    const shared=await memoryRecall({ document_id:doc.document_id },other); assert.deepEqual(Object.keys(shared[0].ingestion!),['state']);
    const search=(query:string) => rankMemories({ query,limit:100,threshold:0.3 },auth.namespaces,dbScopeFromAuth(auth),auth.maxAccessLevel,{ queryVectors:[{ profile:ACTIVE_EMBEDDING_PROFILE,vector }] });
    assert.equal((await search('quasar')).length,3); assert.ok((await search('quasar')).every(row => row.vec_score===null));
    assert.equal((await search('unmatchedterm')).length,0);
    const exported=await exportMemoryPage(exportPageSchema.parse({}),auth);
    assert.equal(exported.records.length,3); assert.ok(exported.records.every(row => row.ingestion_state==='pending'));
    await finalizeIngestionBatch(await claim(doc.document_id,1),results(1));
    assert.equal((await search('unmatchedterm')).length,1);
    await owner!.query('UPDATE documents SET chunk_count=99 WHERE id=$1',[doc.document_id]);
    assert.equal((await repairDocumentChunkCounts({ connectionString:`postgresql://postgres:test-only@127.0.0.1:${port}/postgres` })).updatedRows,1);
    await invariant(doc.document_id);
    await memoryForget({ ids:[recalled[1].id] },auth);
    assert.equal((await status(doc.document_id)).cancelled,1);
    await invariant(doc.document_id);
  });
  await t.test('document subscriptions enqueue once at readiness and updates replace generations without chunk creation events', async () => {
    await reset();
    const subscription=(await owner!.query(`INSERT INTO memory_subscriptions
      (api_key_id,query_text,query_embedding,embedding_provider,embedding_model,embedding_dimensions,threshold,exclude_self,
       webhook_url_ciphertext,webhook_url_iv,webhook_url_tag,signing_secret_ciphertext,signing_secret_iv,signing_secret_tag,
       encryption_key_id,idempotency_key,request_hash)
      VALUES ($1,'fixture',$2::vector,$3,$4,768,0.5,false,'x',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),
        'x',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'test','document',repeat('a',64)) RETURNING id`,[other.keyId,JSON.stringify(vector),ACTIVE_EMBEDDING_PROFILE.provider,ACTIVE_EMBEDDING_PROFILE.model])).rows[0].id;
    await owner!.query('INSERT INTO subscription_namespaces(subscription_id,api_key_id,namespace) VALUES ($1,$2,$3)',[subscription,other.keyId,'shared']);
    await owner!.query('ALTER TABLE memories ENABLE TRIGGER memories_subscription_enqueue; ALTER TABLE memories ENABLE TRIGGER memories_subscription_ready_enqueue');
    const doc=await memoryStoreDocument(params(3),auth); const jobs=await claim(doc.document_id);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries')).rows[0].n,0);
    await memoryUpdate({ id:jobs[0].memory_id,tags:['metadata-only'] },auth);
    await owner!.query(`CREATE FUNCTION reject_document_notify() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.chunk_index=1 AND NEW.embedding IS NOT NULL THEN RAISE EXCEPTION 'synthetic outbox rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_document_notify BEFORE UPDATE OF embedding ON memories FOR EACH ROW EXECUTE FUNCTION reject_document_notify()`);
    try { await assert.rejects(finalizeIngestionBatch(jobs,results(3)),/synthetic outbox rollback/); }
    finally { await owner!.query('DROP TRIGGER reject_document_notify ON memories; DROP FUNCTION reject_document_notify()'); }
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries')).rows[0].n,0);
    assert.equal((await status(doc.document_id)).ready,0);
    await finalizeIngestionBatch(jobs,results(3)); await finalizeIngestionBatch(jobs,results(3));
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries')).rows[0].n,3);
    process.env.MEMORY_INGESTION_UPDATE_ENABLED='true';
    const pending=await memoryStoreDocument(params(2),auth); const stale=await claim(pending.document_id);
    await memoryUpdate({ id:stale[0].memory_id,content:'changed generation' },auth);
    assert.equal(await finalizeIngestionBatch(stale,results(2)),false);
    const replacement=await claim(pending.document_id); assert.equal(replacement.length,1); assert.equal(replacement[0].kind,'update');
    globalThis.fetch=async () => new Response(JSON.stringify({ embedding:{ values:vector } }));
    await processIngestionBatch(replacement);
    await owner!.query("UPDATE memory_ingestion_jobs SET lease_expires_at=now()-interval '1 second' WHERE document_id=$1 AND status='processing'",[pending.document_id]);
    const remaining=await claim(pending.document_id); await finalizeIngestionBatch(remaining,results(1));
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries')).rows[0].n,4);
    assert.equal((await status(pending.document_id)).state,'ready');
  });
  await t.test('gate-off writes remain synchronous while queued replay/status/drain survive rollback', async () => {
    await reset(); const input=params(2,'rollback'), doc=await memoryStoreDocument(input,auth);
    process.env.MEMORY_INGESTION_DOCUMENT_ENABLED='false';
    assert.equal((await memoryStoreDocument(input,auth)).state,'queued');
    let calls=0; globalThis.fetch=async () => { calls++; return new Response(JSON.stringify({ embedding:{ values:vector } })); };
    const synchronous=await memoryStoreDocument(params(2),auth); assert.equal(calls,2); assert.equal(synchronous.state,undefined);
    assert.equal((await status(synchronous.document_id)).state,'ready');
    assert.equal((await ingestionStats(admin)).pending_documents,1);
    await finalizeIngestionBatch(await claim(doc.document_id),results(2)); assert.equal((await status(doc.document_id)).state,'ready');
    process.env.MEMORY_INGESTION_DOCUMENT_ENABLED='true';
  });
});
