export const AUTO_RECOVERABLE_STEADY_ERRORS = Object.freeze(['embedding.resource_guard','embedding.runtime_health','ethereum_health']);
export const recoveryErrorCode = error => /^[a-z0-9_.]{1,96}$/.test(error?.code ?? error?.message ?? '') ? (error.code ?? error.message) : 'embedding.guard_check_failed';

// Healthy samples must span a full minute, without a missed 30-second sampling slot.
export class SteadyRecoveryGate {
  constructor(runId, {healthyMs=60_000,maxGapMs=45_000}={}) {
    this.runId=runId;this.healthyMs=healthyMs;this.maxGapMs=maxGapMs;this.reset();
  }
  reset(){this.identity=null;this.since=null;this.last=null;}
  eligible(row){return row?.steady_worker_enabled===false && row.cutover_attestation_run_id===this.runId
    && AUTO_RECOVERABLE_STEADY_ERRORS.includes(row.steady_worker_last_error)
    && typeof row.updated_at_token==='string' && row.updated_at_token.length>0;}
  observe(row,healthy,now,aborted=false){
    if(aborted || !this.eligible(row) || !healthy || !Number.isFinite(now)){this.reset();return false;}
    const identity=JSON.stringify([row.cutover_attestation_run_id,row.steady_worker_last_error,row.updated_at_token]);
    if(identity!==this.identity || this.last===null || now<this.last || now-this.last>this.maxGapMs){this.identity=identity;this.since=now;}
    this.last=now;return now-this.since>=this.healthyMs;
  }
}
