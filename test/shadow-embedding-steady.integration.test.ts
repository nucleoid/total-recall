import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {QWEN_CHUNK_CONTRACT,QWEN_CONTRACT_ID} from '../src/local-embedding-contract.js';
import {CURRENT_PARENT_ELIGIBILITY,ShadowEmbeddingStore} from '../src/shadow-embedding-store.js';
import {LocalEmbeddingClient} from '../src/local-embedding-client.js';
import {runShadowBatch} from '../src/shadow-embedding-worker.js';
import {enableSteadyWorker,pauseSteadyWorker} from '../src/shadow-embedding-steady.js';
import {hashOperationalManifest,validateOperationalManifest,type OperationalManifest} from '../src/shadow-embedding-control.js';

const url=process.env.SHADOW_EMBEDDING_TEST_DATABASE_URL;
const resources={maxParentsPerBatch:10,maxSourceBytesPerBatch:100_000,maxTokensPerBatch:20_000,maxElapsedMsPerBatch:10_000,maxAttempts:2,
  host:{deploymentProfile:'linux-worker' as const,expectedHostname:'synthetic',diskPath:'/tmp',minAvailableMemoryBytes:2_147_483_648,
    minAvailableDiskBytes:107_374_182_400,maxLoadPerCpu:1,maxSwapUsedBytes:134_217_728,maxMemoryPsiAvg10:1,maxCpuPsiAvg10:5},
  indexBuild:{maintenanceWorkMemMb:64,maxParallelMaintenanceWorkers:0,lockTimeoutMs:100,statementTimeoutMs:60_000}};
const runtime={acceptanceReceiptSha256:'a'.repeat(64),artifactSha256:QWEN_CHUNK_CONTRACT.artifactSha256,
  runtimeContract:QWEN_CHUNK_CONTRACT.runtimeContract,expectedRuntimeHost:'synthetic',expectedRuntimeMode:'cpu' as const};
const limits={maxParents:10,maxSourceBytes:100_000,maxTokens:20_000,maxElapsedMs:10_000,maxAttempts:2};
function fakeClient(){return new LocalEmbeddingClient({baseUrl:'http://localhost:1234',bearerToken:'synthetic',runtime:{contractId:QWEN_CONTRACT_ID,
  artifactSha256:QWEN_CHUNK_CONTRACT.artifactSha256,runtimeContract:QWEN_CHUNK_CONTRACT.runtimeContract,acceptanceReceiptSha256:runtime.acceptanceReceiptSha256},
  beforeInference:async()=>{},fetch:(async(input:string|URL|Request,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));
    if(String(input).endsWith('/tokenize'))return Response.json({tokens:Array(body.content.length+2).fill(1)});
    return Response.json({data:body.input.map((_:string,index:number)=>({index,embedding:Array(QWEN_CHUNK_CONTRACT.nativeDimensions).fill(1)})),usage:{prompt_tokens:body.input.reduce((n:number,s:string)=>n+s.length+2,0)}});}) as typeof fetch});}
function manifest():OperationalManifest{return{version:1,approval:{reference:'synthetic',sha256:'b'.repeat(64),approvedBy:'test',approvedAt:'2026-10-20T00:00:00Z'},
  source:{releaseSha:'c'.repeat(40)},eligibility:{predicate:CURRENT_PARENT_ELIGIBILITY,namespaces:'all',includeNullVectors:true,activeSubscriptions:true},
  resources,runtime:{...runtime,expectedRuntimeMode:'gpu'},steadyState:{resources,runtime}};}
class SavepointPool{private serial=0;constructor(private readonly db:pg.PoolClient){}query(text:string,values?:unknown[]){return this.db.query(text,values)}async connect(){const name=`steady_${++this.serial}`,db=this.db;return{query(text:string,values?:unknown[]){if(text==='BEGIN')return db.query(`SAVEPOINT ${name}`);if(text==='COMMIT')return db.query(`RELEASE SAVEPOINT ${name}`);if(text==='ROLLBACK')return db.query(`ROLLBACK TO SAVEPOINT ${name}`);return db.query(text,values)},release(){}}}}

test('steady worker continuously repairs target state and every pause or serving change fences commits',{skip:!url,timeout:60_000},async()=>{
  assert.equal(new URL(url!).pathname,'/total_recall_reembedding_test');const pool=new pg.Pool({connectionString:url,max:4,connectionTimeoutMillis:2_000}),db=await pool.connect();
  const run=randomUUID(),parent=randomUUID(),future=randomUUID(),key=randomUUID(),subscription=randomUUID(),value=manifest(),envelope=validateOperationalManifest(value,hashOperationalManifest(value));let committed=false;
  try{await db.query('BEGIN');
    await db.query(`INSERT INTO embedding_contracts(id,canonical_json,capture_enabled)VALUES($1,$2,true)ON CONFLICT(id)DO UPDATE SET capture_enabled=true`,[QWEN_CONTRACT_ID,JSON.stringify(QWEN_CHUNK_CONTRACT)]);
    await db.query(`DO $b$ DECLARE part regclass;BEGIN SELECT i.inhrelid::regclass INTO part FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='memory_embedding_chunks'::regclass AND pg_get_expr(c.relpartbound,c.oid)LIKE '%${QWEN_CONTRACT_ID}%' LIMIT 1;IF part IS NULL THEN CREATE TABLE memory_embedding_chunks_steady_test PARTITION OF memory_embedding_chunks FOR VALUES IN('${QWEN_CONTRACT_ID}');part:='memory_embedding_chunks_steady_test';END IF;IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=part AND pg_get_indexdef(indexrelid)LIKE '%USING hnsw%')THEN EXECUTE format('CREATE INDEX shadow_steady_hnsw ON %s USING hnsw(embedding vector_cosine_ops)',part);END IF;END$b$`);
    const receipts={qualityReceiptSha256:'d'.repeat(64),auditReceiptSha256:'d'.repeat(64),backupReceiptSha256:'d'.repeat(64),cutoverApprovalSha256:'d'.repeat(64)};
    await db.query(`INSERT INTO embedding_runs(id,contract_id,release_sha,manifest,status,inventory_complete,source_watermark,completion_attestation)VALUES($1,$2,$3,$4,'paused',true,statement_timestamp(),$5)`,[run,QWEN_CONTRACT_ID,value.source.releaseSha,value,receipts]);
    const census=(await db.query(`SELECT(SELECT count(*) FROM memories m WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL AND(m.expires_at IS NULL OR m.expires_at>statement_timestamp())AND(m.valid_from IS NULL OR m.valid_from<=statement_timestamp())AND(m.valid_to IS NULL OR m.valid_to>statement_timestamp()))memory,(SELECT count(*) FROM memory_subscriptions s JOIN api_keys k ON k.id=s.api_key_id WHERE s.status='active'AND k.enabled AND k.revoked_at IS NULL AND(k.expires_at IS NULL OR k.expires_at>statement_timestamp()))subscriptions`)).rows[0];
    await db.query(`INSERT INTO embedding_cutover_attestations(run_id,contract_id,watermark,memory_census,subscription_census,audit_receipt_sha256,quality_receipt_sha256,backup_receipt_sha256,approval_sha256)VALUES($1,$2,statement_timestamp(),$3,$4,$5,$5,$5,$5)`,[run,QWEN_CONTRACT_ID,census.memory,census.subscriptions,'d'.repeat(64)]);
    await db.query(`UPDATE embedding_runs SET cutover_watermark=(SELECT watermark FROM embedding_cutover_attestations WHERE run_id=$1) WHERE id=$1`,[run]);
    await db.query(`INSERT INTO embedding_serving_settings(singleton,contract_id,capture_required,cutover_attestation_run_id,observation_ends_at)VALUES(true,$1,true,$2,statement_timestamp()-interval '1 second')`,[QWEN_CONTRACT_ID,run]);
    const scopedPool=new SavepointPool(db),store=new ShadowEmbeddingStore(scopedPool as never,run,120,'steady');await store.verifyDatabase('total_recall_reembedding_test');
    assert.equal(await store.claim(),null,'disabled steady worker cannot claim');
    await db.query('SAVEPOINT completion_disabled');await assert.rejects(db.query(`UPDATE embedding_runs SET status='complete' WHERE id=$1`,[run]),/steady_plan_required/);await db.query('ROLLBACK TO SAVEPOINT completion_disabled');
    await enableSteadyWorker(await scopedPool.connect() as never,'total_recall_reembedding_test',run,envelope);
    await db.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level)VALUES($1::uuid,($1::uuid)::text,'steady',ARRAY['personal'],ARRAY['read','write'],'normal')`,[key]);
    await db.query(`INSERT INTO memories(id,content,source,namespace,client_id)VALUES($1,'initial steady fact','steady-test','personal',$2::text)`,[parent,key]);
    assert.equal((await runShadowBatch(store,fakeClient(),limits,async()=>{})).completeParents,1);
    await db.query(`UPDATE memories SET content='async updated steady fact' WHERE id=$1`,[parent]);
    assert.equal((await runShadowBatch(store,fakeClient(),limits,async()=>{})).completeParents,1);
    assert.equal(await store.claim(),null,'queue drained before stale fence');
    await db.query(`UPDATE memories SET content='stale fence source' WHERE id=$1`,[parent]);
    const originalCommit=store.commitMemory.bind(store);let pausedAtCommit=false;
    store.commitMemory=async(...args)=>{if(!pausedAtCommit){pausedAtCommit=true;await pauseSteadyWorker(await scopedPool.connect() as never,
      'total_recall_reembedding_test',run,envelope,'embedding.operator_paused');}return originalCommit(...args);};
    const fenced=await runShadowBatch(store,fakeClient(),limits,async()=>{});store.commitMemory=originalCommit;
    assert.equal(fenced.staleParents,1);assert.deepEqual((await db.query(`SELECT state,error_code,attempts FROM embedding_work_items WHERE contract_id=$1 AND parent_id=$2`,[QWEN_CONTRACT_ID,parent])).rows[0],
      {state:'retry',error_code:'embedding.source_changed',attempts:0},'control fencing after inference defers without charging provider attempts');
    await db.query(`UPDATE embedding_work_items SET state='pending',claimed_by=NULL,lease_until=NULL,next_attempt_at=statement_timestamp() WHERE contract_id=$1 AND parent_id=$2`,[QWEN_CONTRACT_ID,parent]);
    await enableSteadyWorker(await scopedPool.connect() as never,'total_recall_reembedding_test',run,envelope);assert.equal((await runShadowBatch(store,fakeClient(),limits,async()=>{})).completeParents,1);
    await db.query(`UPDATE memories SET content='generation race source' WHERE id=$1`,[parent]);let raced=false;
    store.commitMemory=async(...args)=>{if(!raced){raced=true;await db.query(`UPDATE memories SET content='newer generation wins' WHERE id=$1`,[parent]);}return originalCommit(...args);};
    const race=await runShadowBatch(store,fakeClient(),limits,async()=>{});store.commitMemory=originalCommit;
    assert.equal(race.staleParents,1);assert.deepEqual((await db.query(`SELECT state,attempts FROM embedding_work_items WHERE contract_id=$1 AND parent_id=$2`,[QWEN_CONTRACT_ID,parent])).rows[0],
      {state:'pending',attempts:0},'old-claim defer cannot consume or steal a newer source generation');
    assert.equal((await runShadowBatch(store,fakeClient(),limits,async()=>{})).completeParents,1);
    await db.query(`UPDATE embedding_runs SET status='complete' WHERE id=$1`,[run]);
    await db.query(`INSERT INTO memories(id,content,source,namespace,client_id,valid_from)VALUES($1,'future steady fact','steady-test','personal',$2::text,statement_timestamp()+interval '1 second')`,[future,key]);
    assert.equal((await runShadowBatch(store,fakeClient(),limits,async()=>{})).completeParents,0);
    await new Promise(resolve=>setTimeout(resolve,1200));
    assert.equal((await runShadowBatch(store,fakeClient(),limits,async()=>{})).completeParents,1,'elapsed database time alone makes deferred work due');
    const unit=`[1,${Array(767).fill(0).join(',')}]`;await db.query(`INSERT INTO memory_subscriptions(id,api_key_id,query_text,query_embedding,embedding_provider,embedding_model,embedding_dimensions,threshold,webhook_url_ciphertext,webhook_url_iv,webhook_url_tag,signing_secret_ciphertext,signing_secret_iv,signing_secret_tag,encryption_key_id,idempotency_key,request_hash,status)VALUES($1,$2,'first subscription query',$3::vector,'gemini','gemini-embedding-2-preview',768,0.5,decode('00','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),decode('00','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'test','steady-test',repeat('a',64),'active')`,[subscription,key,unit]);await db.query(`INSERT INTO subscription_namespaces(subscription_id,api_key_id,namespace)VALUES($1,$2,'personal')`,[subscription,key]);
    assert.equal((await runShadowBatch(store,fakeClient(),limits,async()=>{})).completeParents,1);
    await db.query(`UPDATE memory_subscriptions SET query_text='edited subscription query' WHERE id=$1`,[subscription]);assert.equal((await runShadowBatch(store,fakeClient(),limits,async()=>{})).completeParents,1);
    const stopped=await runShadowBatch(store,fakeClient(),limits,async()=>{throw Error('synthetic resource stop')});assert.equal(stopped.state,'paused');
    assert.deepEqual((await db.query(`SELECT steady_worker_enabled,steady_worker_last_error FROM embedding_serving_settings WHERE singleton`)).rows[0],{steady_worker_enabled:false,steady_worker_last_error:'embedding.resource_guard'});
    assert.equal((await db.query(`SELECT status FROM embedding_runs WHERE id=$1`,[run])).rows[0].status,'complete','fatal steady pause preserves history');
    await db.query(`UPDATE memories SET content='rollback-fenced update' WHERE id=$1`,[parent]);await db.query('DELETE FROM embedding_serving_settings WHERE singleton');assert.equal(await store.claim(),null,'rollback/removal fences steady claims');
    assert.equal(await new ShadowEmbeddingStore(scopedPool as never,randomUUID(),120,'steady').claim(),null,'mismatched run cannot claim');
    await db.query(`INSERT INTO embedding_serving_settings(singleton,contract_id,capture_required,cutover_attestation_run_id,steady_worker_enabled,observation_ends_at)VALUES(true,$1,true,$2,true,statement_timestamp()-interval '1 second')`,[QWEN_CONTRACT_ID,run]);
    await db.query('COMMIT');committed=true;

    const worker=await pool.connect(),operator=await pool.connect();let pausing:Promise<unknown>|undefined;try{
      const operatorPid=(await operator.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await worker.query('BEGIN');await worker.query(`SELECT 1 FROM embedding_runs WHERE id=$1 AND contract_id=$2 FOR SHARE`,[run,QWEN_CONTRACT_ID]);
      await worker.query(`SELECT 1 FROM embedding_serving_settings s JOIN embedding_contracts c ON c.id=s.contract_id WHERE s.singleton AND s.contract_id=$1 AND s.cutover_attestation_run_id=$2 FOR SHARE OF s,c`,[QWEN_CONTRACT_ID,run]);
      let pauseDone=false;pausing=pauseSteadyWorker(operator,'total_recall_reembedding_test',run,envelope,'embedding.concurrent_pause').then(x=>{pauseDone=true;return x;});
      let waiting=false;for(let i=0;i<100;i++){const state=(await db.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1`,[operatorPid])).rows[0];if(state?.wait_event_type==='Lock'){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
      assert.equal(waiting,true,'operator pause deterministically waits on publication control locks');assert.equal(pauseDone,false);
      await worker.query(`UPDATE memory_embedding_manifests SET committed_at=statement_timestamp() WHERE contract_id=$1 AND parent_id=$2`,[QWEN_CONTRACT_ID,parent]);await worker.query('COMMIT');
      assert.deepEqual(await pausing,{steady_worker_enabled:false,steady_worker_last_error:'embedding.concurrent_pause'});pausing=undefined;
      await db.query(`UPDATE memories SET content='post-pause claim must remain queued' WHERE id=$1`,[parent]);assert.equal(await new ShadowEmbeddingStore(pool,run,120,'steady').claim(),null);
    }finally{try{await worker.query('ROLLBACK')}catch{}if(pausing)try{await pausing}catch{}worker.release();operator.release();}
  }finally{if(committed){try{await db.query('SET session_replication_role=replica');await db.query('DELETE FROM embedding_serving_settings WHERE singleton AND cutover_attestation_run_id=$1',[run]);await db.query('DELETE FROM memory_subscriptions WHERE id=$1',[subscription]);await db.query('DELETE FROM memories WHERE id=ANY($1::uuid[])',[[parent,future]]);await db.query('DELETE FROM embedding_work_items WHERE parent_id=ANY($1::uuid[])',[[parent,future,subscription]]);await db.query('DELETE FROM embedding_cutover_attestations WHERE run_id=$1',[run]);await db.query('DELETE FROM embedding_runs WHERE id=$1',[run]);await db.query('DELETE FROM api_keys WHERE id=$1',[key]);}catch{}finally{try{await db.query('SET session_replication_role=origin')}catch{}}}else try{await db.query('ROLLBACK');}catch{}db.release();await pool.end();}
});
