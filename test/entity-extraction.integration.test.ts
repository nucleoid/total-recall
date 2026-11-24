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
import { parseEntityExtractionPolicy } from '../src/entity-extractor.js';
import { claimEntityEnrichmentJob, enqueueEntityBackfill, enqueueEntityRequeue, enqueueLegacyEntityCoverage,
  loadEntityJobContent, previewEntityBackfill, previewEntityRequeue, previewLegacyEntityCoverage,
  replaceMemoryEntityLinks } from '../src/entities.js';
import { runEntityWorker } from '../scripts/entity-enrich.js';
import { memoryGraph } from '../src/tools/graph.js';
import type { AuthContext } from '../src/types.js';

const approval={ approved:true as const,approvedBy:'synthetic-test',approvedAt:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z' };
function policy(accessLevel: 'normal'|'sensitive'|'secret' = 'secret') { return parseEntityExtractionPolicy({
  version:1,feature:'memory-entity-extraction',environment:'test',
  generation:{ provider:'openclaw-adapter',model:'openclaw/total-recall-synthesis',endpoint:'https://example.test/generate',credentialEnv:'ENTITY_TEST_KEY' },
  terms:{ reference:'synthetic/entity',privacyApproved:true,retentionApproved:true,trainingApproved:true },
  scope:{ namespaces:['my-life'],accessLevel },
  budget:{ mode:'subscription',maxCallsPerInvocation:3,maxInputBytesPerInvocation:100000,
    maxOutputBytesPerInvocation:98304,usageControlReference:'synthetic-subscription-quota' },
  providerModelApproval:approval,termsApproval:approval,scopeApproval:approval,budgetApproval:approval,backfillApproval:approval,
},'test'); }

test('scoped entity worker extracts secret graph without source authority or read leakage', { timeout:240000 }, async t => {
  const port=await new Promise<number>((resolve,reject) => { const server=createServer(); server.once('error',reject);
    server.listen(0,'127.0.0.1',() => { const value=(server.address() as {port:number}).port;
      server.close(error => error ? reject(error) : resolve(value)); }); });
  const container=execFileSync('docker',['run','--rm','-d','-e','POSTGRES_PASSWORD=test-only','-p',`127.0.0.1:${port}:5432`,process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16'],{encoding:'utf8'}).trim();
  let owner:pg.Client|undefined, app:pg.Pool|undefined;
  t.after(async () => { setPoolForTesting(undefined); if (app) await app.end(); if (owner) await owner.end();
    try { execFileSync('docker',['rm','-f',container],{stdio:'ignore'}); } catch {} });
  for (let index=0;index<150;index++) { const candidate=new pg.Client({connectionString:`postgresql://postgres:test-only@127.0.0.1:${port}/postgres`,connectionTimeoutMillis:2000});
    try { await candidate.connect(); owner=candidate; break; } catch { await candidate.end(); await new Promise(resolve=>setTimeout(resolve,200)); } }
  assert.ok(owner); await owner.query('CREATE EXTENSION vector');
  await provisionDatabase(owner,{appPassword:'app-test-only',rotateAppPassword:false});
  await runMigrations(owner,loadMigrationInventory(fileURLToPath(new URL('../migrations',import.meta.url))),{lockTimeoutMs:5000});
  await finalizeMemoryValidity(owner);
  app=new pg.Pool({connectionString:`postgresql://total_recall_app:app-test-only@127.0.0.1:${port}/postgres`}); setPoolForTesting(app);
  const source:AuthContext={keyId:randomUUID(),name:'source-owner',namespaces:['my-life'],permissions:['read','write'],maxAccessLevel:'secret'};
  const worker:AuthContext={...source,keyId:randomUUID(),name:'entity-worker',permissions:['read','entity_extract']};
  const lowerWorker:AuthContext={...worker,keyId:randomUUID(),name:'lower-entity-worker',maxAccessLevel:'normal'};
  const normalReader:AuthContext={...source,keyId:randomUUID(),name:'normal-reader',permissions:['read'],maxAccessLevel:'normal'};
  for (const actor of [source,worker,lowerWorker,normalReader]) await owner.query(
    'INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level) VALUES($1,$2,$3,$4,$5,$6)',
    [actor.keyId,hashKey(`tr_${actor.name}`),actor.name,actor.namespaces,actor.permissions,actor.maxAccessLevel]);
  const inserted=await owner.query<{id:string}>(`INSERT INTO memories(content,source,namespace,access_level,client_id,memory_kind,valid_from)
    VALUES('Secret Alice coordinates Project Atlas.','synthetic','my-life','secret',$1,'semantic',statement_timestamp()) RETURNING id`,['legacy-import']);
  const memoryId=inserted.rows[0].id;
  let calls=0; const provider={name:'openclaw-adapter',generate:async () => { calls++; return JSON.stringify({entities:[
    {display_name:'ALICE',type:'person',mention:'Alice',aliases:[],confidence:0.99},
    {display_name:'Project Atlas',type:'project',mention:'Project Atlas',aliases:['Atlas'],confidence:0.98},
  ]}); }};
  assert.deepEqual(await runEntityWorker({once:true,maxJobs:1,pollMs:100},new AbortController().signal,{policy:policy(),provider,auth:worker}),{processed:1,providerCalls:1});
  assert.equal(calls,1);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM memory_entities WHERE memory_id=$1',[memoryId])).rows[0].n,2);
  assert.deepEqual((await owner.query('SELECT extraction_contract,extraction_result FROM entity_enrichment_queue WHERE memory_id=$1',[memoryId])).rows[0],
    {extraction_contract:'entity-extraction:v1',extraction_result:'entities'});
  assert.equal((await runEntityWorker({once:true,maxJobs:1,pollMs:100},new AbortController().signal,{policy:policy(),provider,auth:worker})).providerCalls,0);
  assert.equal(calls,1);
  await owner.query("UPDATE memories SET content=content || ' Durable replay.' WHERE id=$1",[memoryId]);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM memory_entities WHERE memory_id=$1',[memoryId])).rows[0].n,0);
  assert.equal((await owner.query('SELECT extraction_contract FROM entity_enrichment_queue WHERE memory_id=$1',[memoryId])).rows[0].extraction_contract,null);
  assert.equal((await runEntityWorker({once:true,maxJobs:1,pollMs:100},new AbortController().signal,
    {policy:policy(),provider,auth:worker})).providerCalls,1);
  assert.equal(calls,2);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM memory_entities WHERE memory_id=$1',[memoryId])).rows[0].n,2);
  const secretEntityIds=(await owner.query<{id:string}>('SELECT entity_id AS id FROM memory_entities WHERE memory_id=$1',[memoryId])).rows.map(row=>row.id);
  const hiddenRawEntities=await withScopedClient(dbScopeFromAuth(normalReader),client => client.query(
    'SELECT display_name FROM entities WHERE id=ANY($1::uuid[])',[secretEntityIds]));
  const hiddenRawLinks=await withScopedClient(dbScopeFromAuth(normalReader),client => client.query(
    'SELECT mention,aliases FROM memory_entities WHERE memory_id=$1',[memoryId]));
  assert.equal(hiddenRawEntities.rowCount,0); assert.equal(hiddenRawLinks.rowCount,0);

  const hidden=await memoryGraph({entity:'Alice',namespaces:['my-life'],depth:1},normalReader);
  assert.deepEqual(hidden.memories,[]); assert.deepEqual(hidden.entities,[]); assert.deepEqual(hidden.edges,[]);
  const visible=await memoryGraph({entity:'Alice',namespaces:['my-life'],depth:1},source);
  assert.equal(visible.memories.length,1); assert.equal(visible.memories[0].id,memoryId); assert.equal(visible.edges.length,2);
  const normal=await owner.query<{id:string}>(`INSERT INTO memories(content,source,namespace,access_level,client_id,memory_kind,valid_from)
    VALUES('Alice reviews public notes.','synthetic','my-life','normal',$1,'semantic',statement_timestamp()) RETURNING id`,['legacy-public']);
  const normalProvider={name:'openclaw-adapter',generate:async () => {
    const hiddenDuringProcessing=await withScopedClient(dbScopeFromAuth(lowerWorker),client => client.query(
      'SELECT display_name FROM entities WHERE id=ANY($1::uuid[])',[secretEntityIds]));
    assert.equal(hiddenDuringProcessing.rowCount,0);
    return JSON.stringify({entities:[
      {display_name:'Alice',type:'person',mention:'Alice',aliases:[],confidence:0.99},
    ]});
  }};
  assert.equal((await runEntityWorker({once:true,maxJobs:1,pollMs:100},new AbortController().signal,
    {policy:policy('normal'),provider:normalProvider,auth:lowerWorker})).providerCalls,1);
  const workerEntityRows=await withScopedClient(dbScopeFromAuth(lowerWorker),client => client.query('SELECT display_name FROM entities'));
  assert.equal(workerEntityRows.rowCount,0);
  const publicGraph=await memoryGraph({entity:'Alice',namespaces:['my-life'],depth:0},normalReader);
  assert.equal(publicGraph.memories.length,1); assert.equal(publicGraph.memories[0].id,normal.rows[0].id);
  assert.equal(publicGraph.entities.length,1); assert.equal(publicGraph.entities[0].name,'alice');
  assert.notEqual(publicGraph.entities[0].name,'ALICE');
  const publicRawEntity=await withScopedClient(dbScopeFromAuth(normalReader),client => client.query<{display_name:string}>(
    "SELECT display_name FROM entities WHERE normalized_name='alice'"));
  assert.deepEqual(publicRawEntity.rows.map(row=>row.display_name),['alice']);

  const legacyCoverage=await owner.query<{id:string}>(`INSERT INTO memories(content,source,namespace,access_level,client_id,memory_kind,valid_from)
    VALUES('Legacy source without a proved extraction.','synthetic','my-life','sensitive',$1,'semantic',statement_timestamp()) RETURNING id`,['legacy-coverage']);
  await owner.query("UPDATE entity_enrichment_queue SET status='done',completed_at=statement_timestamp(),source_updated_at='2019-01-01T00:00:00Z' WHERE memory_id=$1",[legacyCoverage.rows[0].id]);
  const honestGraph=await memoryGraph({entity:'not-present',namespaces:['my-life'],depth:0},source);
  assert.equal(honestGraph.indexing.complete,false);assert.ok(honestGraph.indexing.legacy_skipped>=1);
  assert.ok(honestGraph.indexing.unindexed>=1);assert.ok(honestGraph.indexing.covered>=2);
  assert.equal(honestGraph.indexing.hasMore,false);assert.equal(honestGraph.indexing.countsExact,true);
  assert.ok(honestGraph.indexing.sampled<honestGraph.indexing.limit);
  const legacyPreview=await withScopedClient(dbScopeFromAuth(worker),client=>previewLegacyEntityCoverage(
    client,'my-life','sensitive','2026-11-24T11:40:00Z',[legacyCoverage.rows[0].id]));
  assert.equal(legacyPreview.rows,1);
  const legacyQueued=await withScopedClient(dbScopeFromAuth(worker),client=>enqueueLegacyEntityCoverage(
    client,'my-life','sensitive','2026-11-24T11:40:00Z',1,[legacyCoverage.rows[0].id]));
  assert.equal(legacyQueued.enqueued,1);
  const legacyEmptyProvider={name:'openclaw-adapter',generate:async()=>JSON.stringify({entities:[]})};
  assert.equal((await runEntityWorker({once:true,maxJobs:1,pollMs:100,memoryIds:[legacyCoverage.rows[0].id]},
    new AbortController().signal,{policy:policy('sensitive'),provider:legacyEmptyProvider,auth:worker})).providerCalls,1);
  assert.deepEqual((await owner.query('SELECT extraction_contract,extraction_result FROM entity_enrichment_queue WHERE memory_id=$1',[legacyCoverage.rows[0].id])).rows[0],
    {extraction_contract:'entity-extraction:v1',extraction_result:'empty'});
  const expiredLegacy=await owner.query<{id:string}>(`INSERT INTO memories(content,source,namespace,access_level,client_id,memory_kind,valid_from,expires_at)
    VALUES('Expired legacy source.','synthetic','my-life','sensitive',$1,'semantic','2018-01-01T00:00:00Z','2019-01-01T00:00:00Z') RETURNING id`,['legacy-expired']);
  await owner.query("UPDATE entity_enrichment_queue SET status='done',completed_at=statement_timestamp(),source_updated_at='2018-01-01T00:00:00Z' WHERE memory_id=$1",[expiredLegacy.rows[0].id]);
  assert.equal((await withScopedClient(dbScopeFromAuth(worker),client=>previewLegacyEntityCoverage(
    client,'my-life','sensitive','2026-11-24T11:40:00Z',[expiredLegacy.rows[0].id]))).rows,0);
  const normalLegacy=await owner.query<{id:string}>(`INSERT INTO memories(content,source,namespace,access_level,client_id,memory_kind,valid_from)
    VALUES('Normal legacy uncovered source.','synthetic','my-life','normal',$1,'semantic',statement_timestamp()) RETURNING id`,['legacy-normal']);
  await owner.query("UPDATE entity_enrichment_queue SET status='done',completed_at=statement_timestamp(),source_updated_at='2019-01-01T00:00:00Z' WHERE memory_id=$1",[normalLegacy.rows[0].id]);
  assert.equal((await withScopedClient(dbScopeFromAuth(worker),client=>previewLegacyEntityCoverage(
    client,'my-life','sensitive','2026-11-24T11:40:00Z',[normalLegacy.rows[0].id]))).rows,0);
  assert.equal((await withScopedClient(dbScopeFromAuth(lowerWorker),client=>previewLegacyEntityCoverage(
    client,'my-life','normal','2026-11-24T11:40:00Z',[normalLegacy.rows[0].id]))).rows,1);
  await owner.query("UPDATE entity_enrichment_queue SET completed_at='2019-01-01T00:00:00Z' WHERE memory_id=$1",[normal.rows[0].id]);
  const linkedRequeue=await withScopedClient(dbScopeFromAuth(lowerWorker),client => previewEntityRequeue(
    client,'my-life','normal','2020-01-01T00:00:00Z',[normal.rows[0].id]));
  assert.equal(linkedRequeue.rows,0);

  const ordinaryInsert=withScopedClient(dbScopeFromAuth(worker),client => client.query(`INSERT INTO memories
    (content,source,namespace,access_level,client_id,memory_kind,valid_from) VALUES('forged','manual','my-life','secret',$1,'semantic',statement_timestamp())`,[source.keyId]));
  await assert.rejects(ordinaryInsert,error => (error as {code?:string}).code==='42501');
  const updated=await withScopedClient(dbScopeFromAuth(worker),client => client.query('UPDATE memories SET tags=ARRAY[$2] WHERE id=$1 RETURNING id',[memoryId,'forged']));
  assert.equal(updated.rowCount,0);
  const deleted=await withScopedClient(dbScopeFromAuth(worker),client => client.query('DELETE FROM memories WHERE id=$1 RETURNING id',[memoryId]));
  assert.equal(deleted.rowCount,0);

  const drift=await owner.query<{id:string}>(`INSERT INTO memories(content,source,namespace,access_level,client_id,memory_kind,valid_from)
    VALUES('Secret Bob maintains Project Nova.','synthetic','my-life','secret',$1,'semantic',statement_timestamp()) RETURNING id`,['legacy-import']);
  const prepared=await withScopedClient(dbScopeFromAuth(worker),async client => { const job=await claimEntityEnrichmentJob(client,['my-life'],'secret');
    assert.ok(job); assert.equal(job.memoryId,drift.rows[0].id); const content=await loadEntityJobContent(client,job); assert.ok(content); return {job,content}; });
  await assert.rejects(withScopedClient(dbScopeFromAuth(worker),client => client.query(
    "UPDATE memories SET tags=ARRAY['forged-processing'] WHERE id=$1",[drift.rows[0].id])),
  error => (error as {code?:string}).code==='42501');
  assert.deepEqual((await owner.query('SELECT tags FROM memories WHERE id=$1',[drift.rows[0].id])).rows[0].tags,[]);
  await owner.query("UPDATE api_keys SET max_access_level='normal' WHERE id=$1",[worker.keyId]);
  try {
    assert.equal(await withScopedClient(dbScopeFromAuth(worker),client => replaceMemoryEntityLinks(client,prepared.job,[
      {displayName:'Bob',normalizedName:'bob',type:'person',mention:'Bob',aliases:[],confidence:0.99},
    ])),false);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM memory_entities WHERE memory_id=$1',[drift.rows[0].id])).rows[0].n,0);
  } finally { await owner.query("UPDATE api_keys SET max_access_level='secret' WHERE id=$1",[worker.keyId]); }
  await owner.query('ALTER TABLE memories DISABLE TRIGGER memories_entity_enrichment_enqueue');
  const historical=await owner.query<{id:string}>(`INSERT INTO memories(content,source,namespace,access_level,client_id,memory_kind,valid_from)
    VALUES('Legacy Carol founded Project Orion.','synthetic','my-life','secret',$1,'semantic',statement_timestamp()) RETURNING id`,['legacy-archive']);
  await owner.query('ALTER TABLE memories ENABLE TRIGGER memories_entity_enrichment_enqueue');
  const preview=await withScopedClient(dbScopeFromAuth(worker),client => previewEntityBackfill(client,'my-life','secret'));
  assert.equal(preview.rows,1);
  const enqueued=await withScopedClient(dbScopeFromAuth(worker),client => enqueueEntityBackfill(client,'my-life','secret',1));
  assert.equal(enqueued.enqueued,1);
  assert.equal((await owner.query('SELECT source_access_level FROM entity_enrichment_queue WHERE memory_id=$1',[historical.rows[0].id])).rows[0].source_access_level,'secret');

  const priorIneligible=await owner.query<{id:string}>(`INSERT INTO memories(content,source,namespace,access_level,client_id,memory_kind,valid_from)
    VALUES('Sensitive Dana supports Project Ember.','synthetic','my-life','sensitive',$1,'semantic',statement_timestamp()) RETURNING id`,['legacy-sensitive']);
  await owner.query("UPDATE entity_enrichment_queue SET status='done',completed_at='2019-01-01T00:00:00Z' WHERE memory_id=$1",[priorIneligible.rows[0].id]);
  const requeuePreview=await withScopedClient(dbScopeFromAuth(worker),client => previewEntityRequeue(
    client,'my-life','sensitive','2020-01-01T00:00:00Z',[priorIneligible.rows[0].id]));
  assert.equal(requeuePreview.rows,1);
  const reopened=await withScopedClient(dbScopeFromAuth(worker),client => enqueueEntityRequeue(
    client,'my-life','sensitive','2020-01-01T00:00:00Z',1,[priorIneligible.rows[0].id]));
  assert.equal(reopened.enqueued,1);
  const sensitiveProvider={name:'openclaw-adapter',generate:async () => JSON.stringify({entities:[
    {display_name:'Dana',type:'person',mention:'Dana',aliases:[],confidence:0.99},
  ]})};
  assert.equal((await runEntityWorker({once:true,maxJobs:1,pollMs:100,memoryIds:[priorIneligible.rows[0].id]},
    new AbortController().signal,{policy:policy('sensitive'),provider:sensitiveProvider,auth:worker})).providerCalls,1);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM memory_entities WHERE memory_id=$1',
    [priorIneligible.rows[0].id])).rows[0].n,1);
  assert.equal((await withScopedClient(dbScopeFromAuth(normalReader),client => client.query(
    'SELECT entity_id FROM memory_entities WHERE memory_id=$1',[priorIneligible.rows[0].id]))).rowCount,0);
  const newlyEmpty=await owner.query<{id:string}>(`INSERT INTO memories(content,source,namespace,access_level,client_id,memory_kind,valid_from)
    VALUES('No durable named identity here.','synthetic','my-life','sensitive',$1,'semantic',statement_timestamp()) RETURNING id`,['new-empty']);
  const emptyProvider={name:'openclaw-adapter',generate:async()=>JSON.stringify({entities:[]})};
  assert.equal((await runEntityWorker({once:true,maxJobs:1,pollMs:100,memoryIds:[newlyEmpty.rows[0].id]},new AbortController().signal,
    {policy:policy('sensitive'),provider:emptyProvider,auth:worker})).providerCalls,1);
  assert.deepEqual((await owner.query('SELECT extraction_contract,extraction_result FROM entity_enrichment_queue WHERE memory_id=$1',[newlyEmpty.rows[0].id])).rows[0],
    {extraction_contract:'entity-extraction:v1',extraction_result:'empty'});
  const excludedNewEmpty=await withScopedClient(dbScopeFromAuth(worker),client => previewEntityRequeue(
    client,'my-life','sensitive','2020-01-01T00:00:00Z',[newlyEmpty.rows[0].id]));
  assert.equal(excludedNewEmpty.rows,0);

  const sampledEmptyId='00000000-0000-4000-8000-000000000001';
  await owner.query(`INSERT INTO memories(id,content,source,namespace,access_level,client_id,memory_kind,valid_from)
    VALUES($1,'No named entity in this bounded sample.','synthetic','my-life','normal',$2,'semantic',statement_timestamp())`,
  [sampledEmptyId,'bounded-status-empty']);
  assert.equal((await runEntityWorker({once:true,maxJobs:1,pollMs:100,memoryIds:[sampledEmptyId]},new AbortController().signal,
    {policy:policy('normal'),provider:emptyProvider,auth:lowerWorker})).providerCalls,1);
  assert.deepEqual((await owner.query('SELECT extraction_contract,extraction_result FROM entity_enrichment_queue WHERE memory_id=$1',[sampledEmptyId])).rows[0],
    {extraction_contract:'entity-extraction:v1',extraction_result:'empty'});
  await owner.query(`INSERT INTO memories(id,content,source,namespace,access_level,client_id,memory_kind,valid_from)
    SELECT ('70000000-0000-4000-8000-'||lpad(series::text,12,'0'))::uuid,
      'Bounded graph status source '||series,'synthetic','my-life','normal','bounded-status','semantic',statement_timestamp()
    FROM generate_series(1,1001) series`);
  const boundedStatus=await memoryGraph({entity:'not-present',namespaces:['my-life'],depth:0},normalReader);
  assert.equal(boundedStatus.indexing.sampled,1000);
  assert.equal(boundedStatus.indexing.limit,1000);
  assert.equal(boundedStatus.indexing.hasMore,true);
  assert.equal(boundedStatus.indexing.countsExact,false);
  assert.equal(boundedStatus.indexing.complete,false);
  assert.ok(boundedStatus.indexing.covered>=1,'valid empty extraction must count as observed coverage');
  assert.ok(boundedStatus.indexing.pending>0,'pending count must be an observed lower bound');
  assert.deepEqual(boundedStatus.memories,[]);
  assert.deepEqual(boundedStatus.entities,[]);
  assert.deepEqual(boundedStatus.edges,[]);

});
