import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { buildShadowIndex, completeShadowRun, inspectShadowIndex } from '../src/shadow-embedding-index.js';
import { hashOperationalManifest, validateOperationalManifest } from '../src/shadow-embedding-control.js';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID, sha256 } from '../src/local-embedding-contract.js';
import { CURRENT_PARENT_ELIGIBILITY } from '../src/shadow-embedding-store.js';
import { activateCutover, attestCutover, rollbackCutover, validateCutoverPlan } from '../src/shadow-embedding-cutover.js';

const url=process.env.SHADOW_EMBEDDING_TEST_DATABASE_URL;
const database='total_recall_reembedding_test';
const indexPlan={maintenanceWorkMemMb:64,maxParallelMaintenanceWorkers:0,lockTimeoutMs:2000,statementTimeoutMs:120000};
function manifest(){return {version:1 as const,approval:{reference:'synthetic/index-integration',sha256:'a'.repeat(64),approvedBy:'test',approvedAt:'2026-01-01T00:00:00Z'},
  source:{releaseSha:'b'.repeat(40)},eligibility:{predicate:CURRENT_PARENT_ELIGIBILITY,namespaces:'all' as const,includeNullVectors:true as const,activeSubscriptions:true as const},
  resources:{maxParentsPerBatch:1,maxSourceBytesPerBatch:1000,maxTokensPerBatch:1000,maxElapsedMsPerBatch:1000,maxAttempts:1,
    host:{deploymentProfile:'linux-worker' as const,expectedHostname:'test',diskPath:'/tmp',minAvailableMemoryBytes:268435456,minAvailableDiskBytes:1073741824,maxLoadPerCpu:1,maxSwapUsedBytes:0,maxMemoryPsiAvg10:1,maxCpuPsiAvg10:5},indexBuild:indexPlan},
  runtime:{acceptanceReceiptSha256:'c'.repeat(64),artifactSha256:QWEN_CHUNK_CONTRACT.artifactSha256,runtimeContract:QWEN_CHUNK_CONTRACT.runtimeContract,
    expectedRuntimeHost:'test',expectedRuntimeMode:'cpu' as const}}}

test('real HNSW build, planner use and completion guards', {skip:!url}, async()=>{
  assert.equal(new URL(url!).pathname,`/${database}`);
  const pool=new pg.Pool({connectionString:url,max:1}); const client=await pool.connect();
  const runId=randomUUID(),parent=randomUUID(),text='index integration source';
  const receipts={qualityReceiptSha256:'1'.repeat(64),auditReceiptSha256:'2'.repeat(64),backupReceiptSha256:'3'.repeat(64),cutoverApprovalSha256:'a'.repeat(64)};
  const value=manifest(),envelope=validateOperationalManifest(value,hashOperationalManifest(value));
  const cutoverValue={version:1 as const,contractId:QWEN_CONTRACT_ID,runId,operationalManifestSha256:envelope.manifestSha256,
    watermark:new Date(Date.now()-60_000).toISOString(),evidence:{auditReceiptSha256:receipts.auditReceiptSha256,
      qualityReceiptSha256:receipts.qualityReceiptSha256,backupReceiptSha256:receipts.backupReceiptSha256},
    activation:{observationEndsAt:new Date(Date.now()+120_000).toISOString(),rollbackWritesEnabled:true,
      rollbackInputsPerMinute:1,rollbackUntil:new Date(Date.now()+90_000).toISOString()},approval:value.approval};
  const cutover=validateCutoverPlan(cutoverValue,hashOperationalManifest(cutoverValue),envelope);
  let indexName:string|undefined; const planParents:string[]=[];
  const cleanPlanFixture=async()=>{
    if(!planParents.length)return;
    await client.query('DELETE FROM shadow_subscription_insert_events WHERE memory_id=ANY($1::uuid[])',[planParents]);
    await client.query('DELETE FROM memories WHERE id=ANY($1::uuid[])',[planParents]);
    await client.query('DELETE FROM embedding_work_items WHERE parent_id=ANY($1::uuid[])',[planParents]);
    planParents.length=0;
  };
  try {
    assert.equal((await client.query('SELECT current_database() db')).rows[0].db,database);
    await client.query(`INSERT INTO embedding_contracts(id,canonical_json,capture_enabled) VALUES($1,$2,true)
      ON CONFLICT(id) DO UPDATE SET capture_enabled=true`,[QWEN_CONTRACT_ID,JSON.stringify(QWEN_CHUNK_CONTRACT)]);
    const initial=await inspectShadowIndex(client,database); indexName=initial.index;
    await client.query(`DROP INDEX IF EXISTS public."${initial.index}"`);
    await client.query(`INSERT INTO embedding_runs(id,contract_id,release_sha,manifest,status,inventory_complete,source_watermark)
      VALUES($1,$2,$3,$4::jsonb,'paused',true,$5)`,[runId,QWEN_CONTRACT_ID,value.source.releaseSha,JSON.stringify(value),cutoverValue.watermark]);
    const built=await buildShadowIndex(client,database,runId,envelope,indexPlan);
    assert.equal(built.valid,true); assert.match(built.definition!,/USING hnsw[\s\S]*vector_cosine_ops/);
    await assert.rejects(buildShadowIndex(client,database,runId,envelope,{...indexPlan,maintenanceWorkMemMb:128}),/manifest_mismatch/);

    assert.equal((await attestCutover(client,database,envelope,cutover)).run_id,runId);
    const mismatchedValue={...cutoverValue,evidence:{...cutoverValue.evidence,auditReceiptSha256:'9'.repeat(64)}};
    const mismatched=validateCutoverPlan(mismatchedValue,hashOperationalManifest(mismatchedValue),envelope);
    await assert.rejects(activateCutover(client,database,envelope,mismatched),/cutover_readiness/);
    const expiredValue={...cutoverValue,activation:{...cutoverValue.activation,observationEndsAt:new Date(Date.now()-1_000).toISOString(),
      rollbackUntil:new Date(Date.now()-10_000).toISOString()}};
    const expired=validateCutoverPlan(expiredValue,hashOperationalManifest(expiredValue),envelope);
    await assert.rejects(activateCutover(client,database,envelope,expired),/cutover_window_expired/);
    const queuedId=randomUUID();
    await client.query(`INSERT INTO embedding_work_items(contract_id,parent_type,parent_id,state) VALUES($1,'subscription',$2,'pending')`,[QWEN_CONTRACT_ID,queuedId]);
    await assert.rejects(activateCutover(client,database,envelope,cutover),/cutover_readiness/);
    await client.query(`DELETE FROM embedding_work_items WHERE contract_id=$1 AND parent_type='subscription' AND parent_id=$2`,[QWEN_CONTRACT_ID,queuedId]);
    assert.equal((await activateCutover(client,database,envelope,cutover)).cutover_attestation_run_id,runId);
    await assert.rejects(activateCutover(client,database,envelope,cutover),/serving_already_active/);
    const lateValue={...cutoverValue,activation:{...cutoverValue.activation,rollbackUntil:new Date(Date.now()-10_000).toISOString()}};
    const late=validateCutoverPlan(lateValue,hashOperationalManifest(lateValue),envelope);
    await client.query('UPDATE embedding_serving_settings SET rollback_until=$1 WHERE singleton',[lateValue.activation.rollbackUntil]);
    await assert.rejects(rollbackCutover(client,database,envelope,late,'late rollback','7'.repeat(64)),/rollback_window_expired/);
    await client.query('UPDATE embedding_serving_settings SET rollback_until=$1 WHERE singleton',[cutoverValue.activation.rollbackUntil]);
    const rollbackParent=randomUUID(),rollbackVector=`[1,${Array(767).fill(0).join(',')}]`;
    await client.query(`INSERT INTO memories(id,content,embedding,embedding_provider,embedding_model,embedding_dimensions,source,namespace,client_id)
      VALUES($1,'rollback original',$2::vector,'gemini','gemini-embedding-2-preview',768,'rollback-test','personal','synthetic')`,[rollbackParent,rollbackVector]);
    await client.query(`UPDATE memories SET content='rollback stale' WHERE id=$1`,[rollbackParent]);
    await assert.rejects(rollbackCutover(client,database,envelope,cutover,'test rollback','8'.repeat(64)),/rollback_mutations_stale/);
    const repairedVector=`[0,1,${Array(766).fill(0).join(',')}]`;
    await client.query(`UPDATE memories SET embedding=$2::vector,embedding_provider='gemini',embedding_model='gemini-embedding-2-preview',embedding_dimensions=768 WHERE id=$1`,[rollbackParent,repairedVector]);
    const proofBefore=(await client.query(`SELECT source_sha256,vector_sha256,verified,updated_at::text
      FROM embedding_rollback_mutations WHERE contract_id=$1 AND parent_id=$2`,[QWEN_CONTRACT_ID,rollbackParent])).rows[0];
    await client.query(`UPDATE memories SET content=content,embedding=embedding,embedding_provider=embedding_provider,
      embedding_model=embedding_model,embedding_dimensions=embedding_dimensions WHERE id=$1`,[rollbackParent]);
    const proofAfter=(await client.query(`SELECT source_sha256,vector_sha256,verified,updated_at::text
      FROM embedding_rollback_mutations WHERE contract_id=$1 AND parent_id=$2`,[QWEN_CONTRACT_ID,rollbackParent])).rows[0];
    assert.deepEqual(proofAfter,proofBefore,'a no-op embedding update preserves the existing verified rollback proof');
    const unlabelledParent=randomUUID();
    await client.query(`INSERT INTO memories(id,content,embedding,source,namespace,client_id)
      VALUES($1,'rollback unlabelled',$2::vector,'rollback-test','personal','synthetic')`,[unlabelledParent,rollbackVector]);
    assert.equal((await client.query(`SELECT verified FROM embedding_rollback_mutations
      WHERE contract_id=$1 AND parent_id=$2`,[QWEN_CONTRACT_ID,unlabelledParent])).rows[0].verified,false,
    'a non-null vector with incomplete identity commits but is recorded as stale');
    await assert.rejects(rollbackCutover(client,database,envelope,cutover,'test rollback','8'.repeat(64)),/rollback_mutations_stale/);
    await client.query(`UPDATE memories SET embedding=$2::vector,embedding_provider='gemini',
      embedding_model='gemini-embedding-2-preview',embedding_dimensions=768 WHERE id=$1`,[unlabelledParent,repairedVector]);
    const race=new pg.Client({connectionString:url});await race.connect();await race.query('BEGIN');
    const raceVector=`[0,0,1,${Array(765).fill(0).join(',')}]`;
    await race.query('UPDATE memories SET embedding=$2::vector WHERE id=$1',[rollbackParent,raceVector]);
    let rollbackSettled=false;
    const rollbackPromise=rollbackCutover(client,database,envelope,cutover,'test rollback','8'.repeat(64))
      .then(value=>{rollbackSettled=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(rollbackSettled,false,'rollback waits for an in-flight mutation ledger writer');
    await race.query('COMMIT');await race.end();
    const rollbackReceipt=await rollbackPromise;
    assert.equal(Number(rollbackReceipt.mutation_count),2);
    assert.equal((await client.query('SELECT count(*)::int n FROM embedding_serving_settings')).rows[0].n,0);
    await client.query('DELETE FROM memories WHERE id=$1',[unlabelledParent]);
    await client.query('DELETE FROM shadow_subscription_insert_events WHERE memory_id=$1',[unlabelledParent]);
    await client.query('DELETE FROM embedding_work_items WHERE parent_id=$1',[unlabelledParent]);
    await client.query(`INSERT INTO embedding_serving_settings(singleton,contract_id,capture_required,rollback_writes_enabled,rollback_inputs_per_minute,
      rollback_until,observation_ends_at,cutover_attestation_run_id) VALUES(true,$1,true,true,1,$2,$3,$4)`,
    [QWEN_CONTRACT_ID,cutoverValue.activation.rollbackUntil,cutoverValue.activation.observationEndsAt,runId]);
    await client.query('DELETE FROM memories WHERE id=$1',[rollbackParent]);
    await client.query('DELETE FROM shadow_subscription_insert_events WHERE memory_id=$1',[rollbackParent]);
    await client.query('DELETE FROM embedding_work_items WHERE parent_id=$1',[rollbackParent]);
    await client.query(`UPDATE embedding_serving_settings SET observation_ends_at=statement_timestamp()-interval '1 minute' WHERE singleton`);
    await client.query(`INSERT INTO memories(id,content,source,namespace,client_id) VALUES($1,$2,'index-test','personal','synthetic')`,[parent,text]);
    const vector=`[${Array(768).fill(1/Math.sqrt(768)).join(',')}]`;
    await client.query(`INSERT INTO memory_embedding_manifests(contract_id,parent_id,source_sha256,source_revision,source_bytes,chunk_count,total_tokens,is_current)
      SELECT $1,id,$3,revision,octet_length(content),1,10,false FROM memories WHERE id=$2`,[QWEN_CONTRACT_ID,parent,sha256(text)]);
    await client.query(`INSERT INTO memory_embedding_chunks(contract_id,parent_id,ordinal,core_start,core_end,chunk_sha256,formatted_tokens,embedding)
      VALUES($1,$2,0,0,$3,$4,10,$5::vector)`,[QWEN_CONTRACT_ID,parent,Buffer.byteLength(text),sha256(text),vector]);
    await client.query('UPDATE memory_embedding_manifests SET is_current=true WHERE contract_id=$1 AND parent_id=$2',[QWEN_CONTRACT_ID,parent]);
    await client.query(`INSERT INTO embedding_work_items(contract_id,parent_type,parent_id,state,source_sha256,source_revision)
      SELECT $1,'memory',id,'complete',$3,revision FROM memories WHERE id=$2 ON CONFLICT(contract_id,parent_type,parent_id)
      DO UPDATE SET state='complete',source_sha256=EXCLUDED.source_sha256,source_revision=EXCLUDED.source_revision`,[QWEN_CONTRACT_ID,parent,sha256(text)]);
    // Give the planner realistic cardinality beyond the production ANN head. These
    // foreign-namespace rows must remain outside the correlated eligibility filter.
    const insertedPlanParents=await client.query(`INSERT INTO memories(id,content,source,namespace,client_id)
      SELECT gen_random_uuid(),'index plan fixture '||g,'index-plan-fixture',
        CASE WHEN g<=5000 THEN 'personal' ELSE 'foreign' END,'synthetic'
      FROM generate_series(1,7500) g RETURNING id`);
    planParents.push(...insertedPlanParents.rows.map(row=>String(row.id)));
    await client.query(`INSERT INTO memory_embedding_manifests(contract_id,parent_id,source_sha256,source_revision,source_bytes,chunk_count,total_tokens,is_current)
      SELECT $1,id,encode(digest(content,'sha256'),'hex'),revision,octet_length(content),1,10,false
      FROM memories WHERE id=ANY($2::uuid[])`,[QWEN_CONTRACT_ID,planParents]);
    await client.query(`INSERT INTO memory_embedding_chunks(contract_id,parent_id,ordinal,core_start,core_end,chunk_sha256,formatted_tokens,embedding)
      SELECT $1,id,0,0,octet_length(content),encode(digest(content,'sha256'),'hex'),10,$2::vector
      FROM memories WHERE id=ANY($3::uuid[])`,[QWEN_CONTRACT_ID,vector,planParents]);
    await client.query(`UPDATE memory_embedding_manifests SET is_current=true
      WHERE contract_id=$1 AND parent_id=ANY($2::uuid[])`,[QWEN_CONTRACT_ID,planParents]);
    await client.query(`ANALYZE memories; ANALYZE memory_embedding_manifests; ANALYZE public."${built.partition}"`);
    const explained=await client.query(`EXPLAIN (COSTS OFF)
      WITH eligible_local_parents AS MATERIALIZED (
        SELECT m.id FROM memories m JOIN memory_embedding_manifests f
          ON f.contract_id=$1 AND f.parent_id=m.id AND f.is_current
        WHERE m.namespace='personal' AND m.deleted_at IS NULL AND m.superseded_at IS NULL
          AND m.consolidated_into_id IS NULL AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())
          AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp())
          AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())
      ), local_ann_head AS MATERIALIZED (
        SELECT c.parent_id,1-(c.embedding <=> $2::vector) AS score
        FROM memory_embedding_chunks c WHERE c.contract_id=$1
          AND (SELECT true FROM eligible_local_parents e WHERE e.id=c.parent_id)
        ORDER BY c.embedding <=> $2::vector LIMIT 1000
      ), local_parent_scores AS (
        SELECT parent_id,max(score) AS score FROM local_ann_head GROUP BY parent_id
      ) SELECT parent_id FROM local_parent_scores ORDER BY score DESC LIMIT 10`,[QWEN_CONTRACT_ID,vector]);
    const planText=explained.rows.map(row=>row['QUERY PLAN']).join('\n');
    assert.match(planText,new RegExp(`Index Scan using ${indexName}`,'i'));
    assert.match(planText,/Filter: .*\(SubPlan \d+\)/i);
    await cleanPlanFixture();

    await assert.rejects(completeShadowRun(client,database,runId,envelope,{},cutoverValue.watermark),/completion_attestation/);
    await client.query(`UPDATE embedding_work_items SET state='pending',source_sha256=NULL,source_revision=NULL WHERE contract_id=$1 AND parent_id=$2`,[QWEN_CONTRACT_ID,parent]);
    await assert.rejects(completeShadowRun(client,database,runId,envelope,receipts,cutoverValue.watermark),/completion_not_drained/);
    await client.query(`UPDATE embedding_work_items SET state='complete',source_sha256=$3,source_revision=(SELECT revision FROM memories WHERE id=$2)
      WHERE contract_id=$1 AND parent_id=$2`,[QWEN_CONTRACT_ID,parent,sha256(text)]);
    await assert.rejects(completeShadowRun(client,database,runId,envelope,receipts,new Date(Date.now()-1000).toISOString()),/completion_cutover_mismatch/);
    assert.equal((await completeShadowRun(client,database,runId,envelope,receipts,cutoverValue.watermark)).status,'complete');
    await assert.rejects(client.query(`UPDATE embedding_runs SET completion_attestation=$2::jsonb WHERE id=$1`,[runId,JSON.stringify({...receipts,qualityReceiptSha256:'9'.repeat(64)})]),/immutable_completion_attestation/);
    await assert.rejects(client.query(`UPDATE embedding_runs SET status='paused' WHERE id=$1`,[runId]),/complete_run_immutable/);
  } finally {
    await cleanPlanFixture();
    await client.query('DELETE FROM shadow_subscription_insert_events WHERE memory_id=$1',[parent]);
    await client.query('DELETE FROM memories WHERE id=$1',[parent]);
    await client.query('DELETE FROM embedding_work_items WHERE parent_id=$1',[parent]);
    await client.query('DELETE FROM embedding_serving_settings WHERE singleton');
    await client.query('DELETE FROM embedding_rollback_mutations WHERE contract_id=$1',[QWEN_CONTRACT_ID]);
    if(indexName) await client.query(`DROP INDEX IF EXISTS public."${indexName}"`);
    client.release(); await pool.end();
  }
});
