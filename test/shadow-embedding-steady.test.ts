import test from 'node:test';
import assert from 'node:assert/strict';
import {QWEN_CHUNK_CONTRACT,QWEN_CONTRACT_ID} from '../src/local-embedding-contract.js';
import {CURRENT_PARENT_ELIGIBILITY} from '../src/shadow-embedding-store.js';
import {hashOperationalManifest,validateOperationalManifest,type OperationalManifest} from '../src/shadow-embedding-control.js';
import {enableSteadyWorker,pauseSteadyWorker} from '../src/shadow-embedding-steady.js';

const resources={maxParentsPerBatch:2,maxSourceBytesPerBatch:100_000,maxTokensPerBatch:10_000,maxElapsedMsPerBatch:10_000,maxAttempts:2,
  host:{deploymentProfile:'linux-worker' as const,expectedHostname:'synthetic',diskPath:'/tmp',minAvailableMemoryBytes:2_147_483_648,
    minAvailableDiskBytes:107_374_182_400,maxLoadPerCpu:1,maxSwapUsedBytes:134_217_728,maxMemoryPsiAvg10:1,maxCpuPsiAvg10:5},
  indexBuild:{maintenanceWorkMemMb:64,maxParallelMaintenanceWorkers:0,lockTimeoutMs:100,statementTimeoutMs:60_000}};
const runtime=(mode:'cpu'|'gpu')=>({acceptanceReceiptSha256:'a'.repeat(64),artifactSha256:QWEN_CHUNK_CONTRACT.artifactSha256,
  runtimeContract:QWEN_CHUNK_CONTRACT.runtimeContract,expectedRuntimeHost:'synthetic',expectedRuntimeMode:mode});
function manifest(steady=true):OperationalManifest{return{version:1,approval:{reference:'synthetic',sha256:'b'.repeat(64),approvedBy:'test',approvedAt:'2026-10-20T00:00:00Z'},
  source:{releaseSha:'c'.repeat(40)},eligibility:{predicate:CURRENT_PARENT_ELIGIBILITY,namespaces:'all',includeNullVectors:true,activeSubscriptions:true},
  resources,runtime:runtime('gpu'),...(steady?{steadyState:{resources,runtime:runtime('cpu')}}:{})};}

class FakeClient{
  calls:string[]=[];
  constructor(readonly row:any){}
  async query(text:string,values?:unknown[]){this.calls.push(text.replace(/\s+/g,' ').trim());
    if(text.includes('FROM pg_roles'))return{rows:[{db:'synthetic_db',operator:true}],rowCount:1};
    if(text.includes('FROM embedding_runs'))return{rows:this.row?[this.row]:[],rowCount:this.row?1:0};
    if(text.includes('FROM embedding_serving_settings'))return{rows:this.row?[this.row]:[],rowCount:this.row?1:0};
    if(text.includes('UPDATE embedding_serving_settings'))return{rows:[{steady_worker_enabled:text.includes('=true'),steady_worker_last_error:text.includes('=true')?null:values?.[2]}],rowCount:1};
    return{rows:[],rowCount:null};}}

test('steady manifest pins a CPU runtime and rejects GPU or omitted activation plans',async()=>{
  const good=manifest(),envelope=validateOperationalManifest(good,hashOperationalManifest(good));
  const gpu={...good,steadyState:{resources,runtime:runtime('gpu')}};
  assert.throws(()=>validateOperationalManifest(gpu,hashOperationalManifest(gpu)),/steady_runtime_mode/);
  const omitted=manifest(false),omittedEnvelope=validateOperationalManifest(omitted,hashOperationalManifest(omitted));
  const base={status:'paused',release_sha:good.source.releaseSha,manifest:good,completion_attestation:{},contract_id:QWEN_CONTRACT_ID,
    capture_required:true,cutover_attestation_run_id:'00000000-0000-4000-8000-000000000001',capture_enabled:true};
  await assert.rejects(enableSteadyWorker(new FakeClient({...base,manifest:omitted}) as never,'synthetic_db',base.cutover_attestation_run_id,omittedEnvelope),/steady_fence/);
  assert.equal(envelope.manifest.steadyState?.runtime.expectedRuntimeMode,'cpu');
});

test('steady controls require the attested serving fence and pause never rewrites historical run status',async()=>{
  const value=manifest(),envelope=validateOperationalManifest(value,hashOperationalManifest(value)),run='00000000-0000-4000-8000-000000000001';
  const row={status:'complete',release_sha:value.source.releaseSha,manifest:value,completion_attestation:{},contract_id:QWEN_CONTRACT_ID,
    capture_required:true,cutover_attestation_run_id:run,capture_enabled:true};
  for(const changed of [{...row,cutover_attestation_run_id:'00000000-0000-4000-8000-000000000002'},{...row,capture_required:false},{...row,capture_enabled:false},{...row,release_sha:'d'.repeat(40)}])
    await assert.rejects(enableSteadyWorker(new FakeClient(changed) as never,'synthetic_db',run,envelope),/steady_fence/);
  const enabled=new FakeClient(row);assert.deepEqual(await enableSteadyWorker(enabled as never,'synthetic_db',run,envelope),{steady_worker_enabled:true,steady_worker_last_error:null});
  const paused=new FakeClient(row);assert.deepEqual(await pauseSteadyWorker(paused as never,'synthetic_db',run,envelope,'embedding.synthetic_pause'),{steady_worker_enabled:false,steady_worker_last_error:'embedding.synthetic_pause'});
  assert.equal(paused.calls.some(sql=>/UPDATE embedding_runs/i.test(sql)),false,'steady pause preserves completed historical run state');
});
