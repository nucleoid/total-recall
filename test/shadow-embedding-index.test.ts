import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShadowIndex, inspectShadowIndex, validateShadowIndexPlan } from '../src/shadow-embedding-index.js';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import { CURRENT_PARENT_ELIGIBILITY } from '../src/shadow-embedding-store.js';
import { hashOperationalManifest, validateOperationalManifest } from '../src/shadow-embedding-control.js';
import { readFile } from 'node:fs/promises';
import { validateCutoverPlan } from '../src/shadow-embedding-cutover.js';
import { parseShadowIndexArguments } from '../scripts/shadow-embedding-index.js';

const indexPlan={maintenanceWorkMemMb:256,maxParallelMaintenanceWorkers:1,lockTimeoutMs:2000,statementTimeoutMs:600000};
test('index build plan is strictly bounded',()=>{
  assert.deepEqual(validateShadowIndexPlan(indexPlan),indexPlan);
  assert.throws(()=>validateShadowIndexPlan({...indexPlan,maintenanceWorkMemMb:8192}),/maintenanceWorkMemMb/);
  assert.throws(()=>validateShadowIndexPlan({...indexPlan,extra:true}),/index_plan/);
});

test('index build is explicit, concurrent, partition-local and verifies validity',async()=>{
  let built=false; const sql:string[]=[];
  const manifest={version:1 as const,approval:{reference:'synthetic',sha256:'a'.repeat(64),approvedBy:'test',approvedAt:'2026-01-01T00:00:00Z'},
    source:{releaseSha:'b'.repeat(40)},eligibility:{predicate:CURRENT_PARENT_ELIGIBILITY,namespaces:'all' as const,includeNullVectors:true as const,activeSubscriptions:true as const},
    resources:{maxParentsPerBatch:1,maxSourceBytesPerBatch:1,maxTokensPerBatch:1,maxElapsedMsPerBatch:1000,maxAttempts:1,
      host:{deploymentProfile:'linux-worker' as const,expectedHostname:'worker',diskPath:'/srv',minAvailableMemoryBytes:268435456,
        minAvailableDiskBytes:1073741824,maxLoadPerCpu:1,maxSwapUsedBytes:0,maxMemoryPsiAvg10:1,maxCpuPsiAvg10:5},indexBuild:indexPlan},
    runtime:{acceptanceReceiptSha256:'c'.repeat(64),artifactSha256:QWEN_CHUNK_CONTRACT.artifactSha256,runtimeContract:QWEN_CHUNK_CONTRACT.runtimeContract,
      expectedRuntimeHost:'worker',expectedRuntimeMode:'cpu' as const}};
  const envelope=validateOperationalManifest(manifest,hashOperationalManifest(manifest));
  const client={query:async(text:string)=>{sql.push(text);
    if(text.includes('current_database()')) return {rows:[{db:'test',operator:true}]};
    if(text.startsWith('SELECT status')) return {rows:[{status:'paused',release_sha:manifest.source.releaseSha,manifest}]};
    if(text.includes('FROM pg_inherits')) return {rows:[{relname:'memory_embedding_chunks_fixture'}]};
    if(text.includes('FROM pg_index')) return {rows:built?[{valid:true,ready:true,definition:'CREATE INDEX x ON public.x USING hnsw (embedding vector_cosine_ops)'}]:[]};
    if(text.includes('CREATE INDEX CONCURRENTLY')) built=true;
    return {rows:[],rowCount:0};
  }} as any;
  const result=await buildShadowIndex(client,'test','00000000-0000-4000-8000-000000000001',envelope,indexPlan);
  assert.equal(result.valid,true); assert.ok(sql.some(value=>/CREATE INDEX CONCURRENTLY[\s\S]*memory_embedding_chunks_fixture[\s\S]*USING hnsw/.test(value)));
});

test('index inspection rejects a valid HNSW index with the wrong distance opclass',async()=>{
  const client={query:async(text:string)=>{
    if(text.includes('current_database()')) return {rows:[{db:'test',operator:true}]};
    if(text.includes('FROM pg_inherits')) return {rows:[{relname:'memory_embedding_chunks_fixture'}]};
    if(text.includes('FROM pg_index')) return {rows:[{valid:true,ready:true,
      definition:'CREATE INDEX x ON public.memory_embedding_chunks_fixture USING hnsw (embedding vector_l2_ops)'}]};
    return {rows:[]};
  }} as any;
  const result=await inspectShadowIndex(client,'test');
  assert.equal(result.exists,true); assert.equal(result.ready,true); assert.equal(result.valid,false);
});

test('completion migration requires attestations, drained derived state and a valid HNSW index',async()=>{
  const sql=await readFile(new URL('../migrations/043_shadow_embedding_completion_guard.sql',import.meta.url),'utf8');
  assert.match(sql,/OLD\.status<>'paused'/); assert.match(sql,/completion_attestation/);
  assert.match(sql,/embedding_work_items[\s\S]*memory_embedding_manifests[\s\S]*subscription_embedding_targets/);
  assert.match(sql,/shadow_subscription_insert_events/); assert.match(sql,/indisvalid[\s\S]*USING hnsw/);
});

test('cutover plan binds the operational approval and all activation limits',()=>{
  const manifest={version:1 as const,approval:{reference:'approved/full-job',sha256:'a'.repeat(64),approvedBy:'operator',approvedAt:'2026-10-20T00:00:00Z'},
    source:{releaseSha:'b'.repeat(40)},eligibility:{predicate:CURRENT_PARENT_ELIGIBILITY,namespaces:'all' as const,includeNullVectors:true as const,activeSubscriptions:true as const},
    resources:{maxParentsPerBatch:1,maxSourceBytesPerBatch:1,maxTokensPerBatch:1,maxElapsedMsPerBatch:1000,maxAttempts:1,
      host:{deploymentProfile:'linux-worker' as const,expectedHostname:'worker',diskPath:'/srv',minAvailableMemoryBytes:268435456,minAvailableDiskBytes:1073741824,maxLoadPerCpu:1,maxSwapUsedBytes:0,maxMemoryPsiAvg10:1,maxCpuPsiAvg10:5},indexBuild:indexPlan},
    runtime:{acceptanceReceiptSha256:'c'.repeat(64),artifactSha256:QWEN_CHUNK_CONTRACT.artifactSha256,runtimeContract:QWEN_CHUNK_CONTRACT.runtimeContract,expectedRuntimeHost:'worker',expectedRuntimeMode:'cpu' as const}};
  const operational=validateOperationalManifest(manifest,hashOperationalManifest(manifest));
  const plan={version:1 as const,contractId:QWEN_CONTRACT_ID,runId:'00000000-0000-4000-8000-000000000001',operationalManifestSha256:operational.manifestSha256,
    watermark:'2026-10-20T01:00:00Z',evidence:{auditReceiptSha256:'d'.repeat(64),qualityReceiptSha256:'e'.repeat(64),backupReceiptSha256:'f'.repeat(64)},
    activation:{observationEndsAt:'2026-10-27T01:00:00Z',rollbackWritesEnabled:true,rollbackInputsPerMinute:10,rollbackUntil:'2026-10-21T01:00:00Z'},approval:manifest.approval};
  assert.deepEqual(validateCutoverPlan(plan,hashOperationalManifest(plan),operational).plan,plan);
  assert.throws(()=>validateCutoverPlan({...plan,approval:{...plan.approval,reference:'implicit-reuse'}},hashOperationalManifest({...plan,approval:{...plan.approval,reference:'implicit-reuse'}}),operational),/approval_binding/);
  const tooLong={...plan,activation:{...plan.activation,rollbackUntil:'2026-10-28T01:00:00Z'}};
  assert.throws(()=>validateCutoverPlan(tooLong,hashOperationalManifest(tooLong),operational),/rollback_until/);
  const stringBoolean={...plan,activation:{...plan.activation,rollbackWritesEnabled:'false'}};
  assert.throws(()=>validateCutoverPlan(stringBoolean,hashOperationalManifest(stringBoolean),operational),/cutover_plan/);
});

test('cutover mutations require apply and an independently hashed plan file',()=>{
  const common=['--database','test','--run-id','00000000-0000-4000-8000-000000000001','--manifest','manifest.json','--manifest-sha256','a'.repeat(64)];
  assert.throws(()=>parseShadowIndexArguments(['attest-cutover',...common,'--cutover-plan','cutover.json','--cutover-plan-sha256','b'.repeat(64)]),/apply_required/);
  const parsed=parseShadowIndexArguments(['activate',...common,'--apply','--cutover-plan','cutover.json','--cutover-plan-sha256','b'.repeat(64)]);
  assert.equal(parsed.command,'activate'); assert.equal(parsed.cutoverPlanPath,'cutover.json');
  assert.throws(()=>parseShadowIndexArguments(['rollback',...common,'--apply','--cutover-plan','cutover.json','--cutover-plan-sha256','b'.repeat(64)]),/rollback_evidence/);
  const rollback=parseShadowIndexArguments(['rollback',...common,'--apply','--cutover-plan','cutover.json','--cutover-plan-sha256','b'.repeat(64),
    '--reason','runtime regression','--rollback-evidence-sha256','c'.repeat(64)]);
  assert.equal(rollback.command,'rollback');assert.equal(rollback.reason,'runtime regression');
});
