import test from 'node:test';
import assert from 'node:assert/strict';
import {SteadyRecoveryGate,recoveryErrorCode} from './steady-recovery-policy.mjs';
const row={steady_worker_enabled:false,steady_worker_last_error:'embedding.resource_guard',cutover_attestation_run_id:'run',updated_at_token:'2026-11-20 00:26:37.422445+00'};
test('three healthy samples span60s; unhealthy sample restarts cooldown',()=>{
 const g=new SteadyRecoveryGate('run');assert.equal(g.observe(row,true,0),false);assert.equal(g.observe(row,true,30000),false);assert.equal(g.observe(row,true,59999),false);assert.equal(g.observe(row,true,60000),true);
 g.observe(row,false,60001);assert.equal(g.observe(row,true,90000),false);assert.equal(g.observe(row,true,120000),false);assert.equal(g.observe(row,true,150000),true);
});
test('missed polling slot, clock rollback and changed generation require fresh minute',()=>{
 for(const altered of [{...row,updated_at_token:'new'},{...row,steady_worker_last_error:'ethereum_health'}]){
  const g=new SteadyRecoveryGate('run');g.observe(row,true,0);g.observe(row,true,30000);assert.equal(g.observe(altered,true,60000),false);
 }
 const g=new SteadyRecoveryGate('run');g.observe(row,true,0);assert.equal(g.observe(row,true,60000),false);assert.equal(g.observe(row,true,59000),false);
});
test('manual/unknown/changed-run/enabled/aborted states cannot recover',()=>{
 for(const invalid of [{...row,steady_worker_last_error:'embedding.operator_paused'},{...row,steady_worker_last_error:'embedding.cancelled'},{...row,steady_worker_last_error:'unknown'},{...row,cutover_attestation_run_id:'other'},{...row,steady_worker_enabled:true},null]){
  const g=new SteadyRecoveryGate('run');g.observe(row,true,0);g.observe(row,true,30000);assert.equal(g.observe(invalid,true,60000),false);
 }
 const g=new SteadyRecoveryGate('run');g.observe(row,true,0);g.observe(row,true,30000);assert.equal(g.observe(row,true,60000,true),false);
});
test('diagnostics carry codes only, never freeform exception content',()=>{
 assert.equal(recoveryErrorCode(new Error('embedding.runtime_health')),'embedding.runtime_health');assert.equal(recoveryErrorCode(new Error('token=secret https://private')),'embedding.guard_check_failed');
});
