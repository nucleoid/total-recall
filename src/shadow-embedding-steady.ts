import type pg from 'pg';
import {QWEN_CONTRACT_ID} from './local-embedding-contract.js';
import {assertShadowOperator} from './shadow-embedding-audit.js';
import {hashOperationalManifest,type ManifestEnvelope} from './shadow-embedding-control.js';

async function lock(client:pg.PoolClient,expectedDatabase:string,runId:string,envelope:ManifestEnvelope){
  await assertShadowOperator(client,expectedDatabase);
  const run=(await client.query(`SELECT status,release_sha,manifest FROM embedding_runs
    WHERE id=$1 AND contract_id=$2 FOR UPDATE`,[runId,QWEN_CONTRACT_ID])).rows[0];
  const control=(await client.query(`SELECT s.contract_id,s.capture_required,s.cutover_attestation_run_id,c.capture_enabled
    FROM embedding_serving_settings s JOIN embedding_contracts c ON c.id=s.contract_id
    JOIN embedding_cutover_attestations a ON a.contract_id=s.contract_id AND a.run_id=s.cutover_attestation_run_id
    WHERE s.singleton AND s.contract_id=$1 AND s.cutover_attestation_run_id=$2 FOR UPDATE OF s,c`,[QWEN_CONTRACT_ID,runId])).rows[0];
  const steady=(envelope.manifest as any).steadyState;
  if(!run||!control||!['paused','complete'].includes(run.status)||run.release_sha!==envelope.manifest.source.releaseSha
    ||hashOperationalManifest(run.manifest)!==envelope.manifestSha256||!steady||steady.runtime?.expectedRuntimeMode!=='cpu'
    ||control.contract_id!==QWEN_CONTRACT_ID||control.capture_required!==true||control.capture_enabled!==true||control.cutover_attestation_run_id!==runId)
    throw new Error('embedding.steady_fence');
  return run;
}

export async function enableSteadyWorker(client:pg.PoolClient,expectedDatabase:string,runId:string,envelope:ManifestEnvelope){
  await client.query('BEGIN');try{await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'");await lock(client,expectedDatabase,runId,envelope);
    const result=await client.query(`UPDATE embedding_serving_settings SET steady_worker_enabled=true,steady_worker_last_error=NULL,
      updated_at=statement_timestamp() WHERE singleton AND contract_id=$1 AND cutover_attestation_run_id=$2
      RETURNING steady_worker_enabled,steady_worker_last_error`,[QWEN_CONTRACT_ID,runId]);
    if(result.rowCount!==1)throw new Error('embedding.steady_fence');await client.query('COMMIT');return result.rows[0];
  }catch(error){await client.query('ROLLBACK');throw error;}
}

export async function pauseSteadyWorker(client:pg.PoolClient,expectedDatabase:string,runId:string,envelope:ManifestEnvelope,errorCode='embedding.operator_paused'){
  if(!/^[a-z0-9_.]{1,96}$/u.test(errorCode))throw new Error('embedding.invalid_error_state');
  await client.query('BEGIN');try{await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'");await lock(client,expectedDatabase,runId,envelope);const result=await client.query(`UPDATE embedding_serving_settings
      SET steady_worker_enabled=false,steady_worker_last_error=$3,updated_at=statement_timestamp()
      WHERE singleton AND contract_id=$1 AND cutover_attestation_run_id=$2 RETURNING steady_worker_enabled,steady_worker_last_error`,
    [QWEN_CONTRACT_ID,runId,errorCode]);if(result.rowCount!==1)throw new Error('embedding.steady_fence');await client.query('COMMIT');return result.rows[0];
  }catch(error){await client.query('ROLLBACK');throw error;}
}
