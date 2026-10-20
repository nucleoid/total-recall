import type pg from 'pg';
import { QWEN_CONTRACT_ID } from './local-embedding-contract.js';
import { hashOperationalManifest, type ManifestEnvelope } from './shadow-embedding-control.js';
import { assertShadowOperator } from './shadow-embedding-audit.js';
import { inspectShadowIndex } from './shadow-embedding-index.js';

const SHA256=/^[a-f0-9]{64}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export interface CutoverPlan {
  version:1; contractId:string; runId:string; operationalManifestSha256:string; watermark:string;
  evidence:{auditReceiptSha256:string;qualityReceiptSha256:string;backupReceiptSha256:string};
  activation:{observationEndsAt:string;rollbackWritesEnabled:boolean;rollbackInputsPerMinute:number;rollbackUntil:string|null};
  approval:{reference:string;sha256:string;approvedBy:string;approvedAt:string};
}
export interface CutoverEnvelope { plan:CutoverPlan; planSha256:string }
function exact(value:Record<string,unknown>,keys:string[]){const a=Object.keys(value).sort(),b=[...keys].sort();if(a.length!==b.length||a.some((k,i)=>k!==b[i]))throw new Error('embedding.cutover_plan');}
function instant(value:unknown,code:string){if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw new Error(code);return Date.parse(value);}

export function validateCutoverPlan(value:unknown, expectedHash:string, operational:ManifestEnvelope):CutoverEnvelope {
  if(!SHA256.test(expectedHash)||!value||typeof value!=='object'||Array.isArray(value))throw new Error('embedding.cutover_plan');
  const p=value as CutoverPlan;
  exact(p as unknown as Record<string,unknown>,['version','contractId','runId','operationalManifestSha256','watermark','evidence','activation','approval']);
  if(!p.evidence||!p.activation||!p.approval)throw new Error('embedding.cutover_plan');
  exact(p.evidence as unknown as Record<string,unknown>,['auditReceiptSha256','qualityReceiptSha256','backupReceiptSha256']);
  exact(p.activation as unknown as Record<string,unknown>,['observationEndsAt','rollbackWritesEnabled','rollbackInputsPerMinute','rollbackUntil']);
  exact(p.approval as unknown as Record<string,unknown>,['reference','sha256','approvedBy','approvedAt']);
  if(p.version!==1||p.contractId!==QWEN_CONTRACT_ID||!UUID.test(p.runId)||p.operationalManifestSha256!==operational.manifestSha256
    || Object.values(p.evidence).some(v=>!SHA256.test(v))||typeof p.activation.rollbackWritesEnabled!=='boolean'||!Number.isSafeInteger(p.activation.rollbackInputsPerMinute)
    || p.activation.rollbackInputsPerMinute<1||p.activation.rollbackInputsPerMinute>1000)throw new Error('embedding.cutover_plan');
  const watermark=instant(p.watermark,'embedding.cutover_watermark'), observation=instant(p.activation.observationEndsAt,'embedding.observation_end');
  if(observation<=watermark||observation-watermark>30*24*60*60*1000)throw new Error('embedding.observation_end');
  if(p.activation.rollbackWritesEnabled){const until=instant(p.activation.rollbackUntil,'embedding.rollback_until');if(until<=watermark||until>observation||until-watermark>7*24*60*60*1000)throw new Error('embedding.rollback_until');}
  else if(p.activation.rollbackUntil!==null)throw new Error('embedding.rollback_until');
  const approval=operational.manifest.approval;
  if(p.approval.reference!==approval.reference||p.approval.sha256!==approval.sha256||p.approval.approvedBy!==approval.approvedBy
    || p.approval.approvedAt!==approval.approvedAt)throw new Error('embedding.cutover_approval_binding');
  if(hashOperationalManifest(p)!==expectedHash)throw new Error('embedding.cutover_plan_hash_mismatch');
  return {plan:p,planSha256:expectedHash};
}

async function lockBoundRun(client:pg.PoolClient, expectedDatabase:string, operational:ManifestEnvelope, cutover:CutoverEnvelope){
  await assertShadowOperator(client,expectedDatabase);
  const result=await client.query(`SELECT status,inventory_complete,source_watermark,release_sha,manifest FROM embedding_runs
    WHERE id=$1 AND contract_id=$2 FOR UPDATE`,[cutover.plan.runId,QWEN_CONTRACT_ID]);
  const run=result.rows[0];
  if(!run||run.status!=='paused'||run.inventory_complete!==true||run.release_sha!==operational.manifest.source.releaseSha
    ||hashOperationalManifest(run.manifest)!==operational.manifestSha256)throw new Error('embedding.run_manifest_identity');
  if(!run.source_watermark||Date.parse(run.source_watermark)>Date.parse(cutover.plan.watermark))throw new Error('embedding.cutover_watermark');
}

export async function attestCutover(client:pg.PoolClient,expectedDatabase:string,operational:ManifestEnvelope,cutover:CutoverEnvelope){
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30min'; SET LOCAL work_mem='8MB'; SET LOCAL max_parallel_workers_per_gather=0");
    await lockBoundRun(client,expectedDatabase,operational,cutover);
    if(Date.parse(cutover.plan.watermark)>Date.now())throw new Error('embedding.cutover_watermark');
    const index=await inspectShadowIndex(client,expectedDatabase);if(!index.valid||!index.ready)throw new Error('embedding.index_not_ready');
    const result=await client.query(`INSERT INTO embedding_cutover_attestations(run_id,contract_id,watermark,memory_census,subscription_census,
      audit_receipt_sha256,quality_receipt_sha256,backup_receipt_sha256,approval_sha256)
      SELECT $1,$2,$3::timestamptz,
        (SELECT count(*) FROM memories m WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
          AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp()) AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())),
        (SELECT count(*) FROM memory_subscriptions s JOIN api_keys k ON k.id=s.api_key_id WHERE s.status='active' AND k.enabled
          AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp())), $4,$5,$6,$7
      RETURNING run_id,contract_id,watermark,memory_census,subscription_census`,[cutover.plan.runId,QWEN_CONTRACT_ID,cutover.plan.watermark,
      cutover.plan.evidence.auditReceiptSha256,cutover.plan.evidence.qualityReceiptSha256,cutover.plan.evidence.backupReceiptSha256,cutover.plan.approval.sha256]);
    await client.query('COMMIT');return result.rows[0];
  }catch(error){await client.query('ROLLBACK');throw error;}
}

export async function activateCutover(client:pg.PoolClient,expectedDatabase:string,operational:ManifestEnvelope,cutover:CutoverEnvelope){
  if(!operational.manifest.steadyState||operational.manifest.steadyState.runtime.expectedRuntimeMode!=='cpu') {
    throw new Error('embedding.steady_plan_required');
  }
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30min'; SET LOCAL work_mem='8MB'; SET LOCAL max_parallel_workers_per_gather=0");
    await lockBoundRun(client,expectedDatabase,operational,cutover);
    const index=await inspectShadowIndex(client,expectedDatabase);if(!index.valid||!index.ready)throw new Error('embedding.index_not_ready');
    const clock=await client.query(`SELECT statement_timestamp() AS now,EXISTS(SELECT 1 FROM embedding_serving_settings WHERE singleton) AS active`);
    if(clock.rows[0]?.active)throw new Error('embedding.serving_already_active');
    const databaseNow=Date.parse(clock.rows[0]?.now);
    if(Date.parse(cutover.plan.activation.observationEndsAt)<=databaseNow
      || (cutover.plan.activation.rollbackWritesEnabled && Date.parse(cutover.plan.activation.rollbackUntil!)<=databaseNow)) {
      throw new Error('embedding.cutover_window_expired');
    }
    const proof=await client.query(`SELECT a.run_id FROM embedding_cutover_attestations a WHERE a.run_id=$1 AND a.contract_id=$2
      AND a.watermark=$3::timestamptz AND a.audit_receipt_sha256=$4 AND a.quality_receipt_sha256=$5
      AND a.backup_receipt_sha256=$6 AND a.approval_sha256=$7
      AND a.memory_census=(SELECT count(*) FROM memories m WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
        AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp()) AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp()))
      AND a.subscription_census=(SELECT count(*) FROM memory_subscriptions s JOIN api_keys k ON k.id=s.api_key_id WHERE s.status='active' AND k.enabled
        AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp()))
      AND EXISTS(SELECT 1 FROM embedding_contracts c WHERE c.id=$2 AND c.capture_enabled)
      AND NOT EXISTS(SELECT 1 FROM embedding_work_items w WHERE w.contract_id=$2 AND (w.state IN('pending','claimed','failed') OR
        (w.state='retry' AND (w.error_code IS DISTINCT FROM 'embedding.valid_from_deferred' OR w.next_attempt_at<=statement_timestamp()
          OR NOT EXISTS(SELECT 1 FROM memories d WHERE d.id=w.parent_id AND d.valid_from>statement_timestamp() AND w.next_attempt_at>=d.valid_from)))))
      AND NOT EXISTS(SELECT 1 FROM memories m LEFT JOIN memory_embedding_manifests f ON f.contract_id=$2 AND f.parent_id=m.id
        WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
          AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp()) AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())
          AND (f.parent_id IS NULL OR NOT f.is_current OR f.source_revision<>m.revision OR f.source_sha256<>encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex')
            OR f.source_bytes<>octet_length(convert_to(m.content,'UTF8')) OR f.chunk_count<>(SELECT count(*) FROM memory_embedding_chunks c WHERE c.contract_id=$2 AND c.parent_id=m.id)
            OR f.total_tokens<>(SELECT COALESCE(sum(c.formatted_tokens),0) FROM memory_embedding_chunks c WHERE c.contract_id=$2 AND c.parent_id=m.id)
            OR NOT COALESCE((SELECT min(c.ordinal)=0 AND max(c.ordinal)=f.chunk_count-1 FROM memory_embedding_chunks c WHERE c.contract_id=$2 AND c.parent_id=m.id),false)))
      AND NOT EXISTS(SELECT 1 FROM memories m JOIN memory_embedding_manifests f ON f.contract_id=$2 AND f.parent_id=m.id
        JOIN (SELECT c.*,lag(c.core_end) OVER(PARTITION BY c.parent_id ORDER BY c.ordinal) prior_end FROM memory_embedding_chunks c WHERE c.contract_id=$2) c ON c.parent_id=m.id
        WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
          AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp()) AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())
          AND ((c.ordinal=0 AND c.core_start<>0) OR (c.ordinal>0 AND c.core_start IS DISTINCT FROM c.prior_end) OR (c.ordinal=f.chunk_count-1 AND c.core_end<>f.source_bytes)
            OR c.chunk_sha256<>encode(digest(substring(convert_to(m.content,'UTF8') FROM c.core_start+1 FOR c.core_end-c.core_start),'sha256'),'hex')
            OR vector_dims(c.embedding)<>768 OR abs(vector_norm(c.embedding)-1)>=0.00001 OR c.formatted_tokens NOT BETWEEN 0 AND 256))
      AND NOT EXISTS(SELECT 1 FROM memory_subscriptions s JOIN api_keys k ON k.id=s.api_key_id LEFT JOIN subscription_embedding_targets t ON t.contract_id=$2 AND t.subscription_id=s.id
        WHERE s.status='active' AND k.enabled AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp())
          AND (t.subscription_id IS NULL OR t.source_sha256<>encode(digest(convert_to(s.query_text,'UTF8'),'sha256'),'hex') OR t.formatted_tokens NOT BETWEEN 0 AND 2000
            OR vector_dims(t.embedding)<>768 OR abs(vector_norm(t.embedding)-1)>=0.00001))
      AND NOT EXISTS(SELECT 1 FROM shadow_subscription_insert_events e JOIN memories m ON m.id=e.memory_id
        WHERE e.contract_id=$2 AND e.processed_at IS NULL AND COALESCE(m.access_level,'normal')='normal'
          AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
          AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp()) AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp()))`,[cutover.plan.runId,QWEN_CONTRACT_ID,cutover.plan.watermark,
      cutover.plan.evidence.auditReceiptSha256,cutover.plan.evidence.qualityReceiptSha256,cutover.plan.evidence.backupReceiptSha256,cutover.plan.approval.sha256]);
    if(proof.rowCount!==1)throw new Error('embedding.cutover_readiness');
    const a=cutover.plan.activation;
    const result=await client.query(`INSERT INTO embedding_serving_settings(singleton,contract_id,capture_required,rollback_writes_enabled,
      rollback_inputs_per_minute,rollback_until,observation_ends_at,cutover_attestation_run_id)
      VALUES(true,$1,true,$2,$3,$4::timestamptz,$5::timestamptz,$6) RETURNING contract_id,rollback_writes_enabled,
      rollback_inputs_per_minute,rollback_until,observation_ends_at,cutover_attestation_run_id`,[QWEN_CONTRACT_ID,a.rollbackWritesEnabled,
      a.rollbackInputsPerMinute,a.rollbackUntil,a.observationEndsAt,cutover.plan.runId]);
    await client.query('COMMIT');return result.rows[0];
  }catch(error){await client.query('ROLLBACK');throw error;}
}

export async function rollbackCutover(client:pg.PoolClient,expectedDatabase:string,operational:ManifestEnvelope,
  cutover:CutoverEnvelope,reason:string,evidenceReceiptSha256:string){
  if(!reason.trim()||reason!==reason.trim()||reason.length>512||!SHA256.test(evidenceReceiptSha256))throw new Error('embedding.rollback_evidence');
  if(!cutover.plan.activation.rollbackWritesEnabled||!cutover.plan.activation.rollbackUntil)throw new Error('embedding.rollback_not_approved');
  const rollbackUntil=cutover.plan.activation.rollbackUntil;
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30min'");
    const a=cutover.plan.activation;
    // Global order is run -> serving settings/contract -> queue rows. Steady
    // claims and controls use the same order, avoiding a run/settings cycle.
    await lockBoundRun(client,expectedDatabase,operational,cutover);
    const setting=await client.query(`SELECT *,statement_timestamp() AS database_now FROM embedding_serving_settings WHERE singleton FOR UPDATE`);
    const s=setting.rows[0];
    if(!s||s.contract_id!==QWEN_CONTRACT_ID||s.cutover_attestation_run_id!==cutover.plan.runId||s.rollback_writes_enabled!==true
      ||Number(s.rollback_inputs_per_minute)!==a.rollbackInputsPerMinute||new Date(s.rollback_until).getTime()!==Date.parse(rollbackUntil)
      ||new Date(s.observation_ends_at).getTime()!==Date.parse(a.observationEndsAt))throw new Error('embedding.rollback_setting_mismatch');
    if(new Date(s.database_now).getTime()>=Date.parse(rollbackUntil))throw new Error('embedding.rollback_window_expired');
    const proof=await client.query(`SELECT count(*)::bigint AS mutation_count,
      encode(digest(convert_to(COALESCE(string_agg(l.parent_id::text||':'||l.source_sha256||':'||COALESCE(l.vector_sha256,''),E'\\n' ORDER BY l.parent_id),''),'UTF8'),'sha256'),'hex') AS mutation_digest_sha256,
      count(*) FILTER(WHERE NOT l.verified OR l.source_sha256<>encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex')
        OR l.vector_sha256 IS DISTINCT FROM encode(digest(convert_to(m.embedding::text,'UTF8'),'sha256'),'hex') OR m.embedding IS NULL
        OR m.embedding_provider<>'gemini' OR m.embedding_model<>'gemini-embedding-2-preview' OR m.embedding_dimensions<>768)::bigint AS invalid
      FROM embedding_rollback_mutations l JOIN memories m ON m.id=l.parent_id WHERE l.contract_id=$1
        AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
        AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp())
        AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())`,[QWEN_CONTRACT_ID]);
    if(Number(proof.rows[0]?.invalid)!==0)throw new Error('embedding.rollback_mutations_stale');
    const result=await client.query(`INSERT INTO embedding_serving_rollbacks(contract_id,cutover_attestation_run_id,cutover_plan_sha256,
      operational_manifest_sha256,approval_sha256,evidence_receipt_sha256,reason,mutation_count,mutation_digest_sha256,prior_settings)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING id,mutation_count,mutation_digest_sha256,rolled_back_at`,
    [QWEN_CONTRACT_ID,cutover.plan.runId,cutover.planSha256,operational.manifestSha256,cutover.plan.approval.sha256,
      evidenceReceiptSha256,reason,proof.rows[0].mutation_count,proof.rows[0].mutation_digest_sha256,JSON.stringify(s)]);
    await client.query('DELETE FROM embedding_serving_settings WHERE singleton');
    await client.query('COMMIT');return result.rows[0];
  }catch(error){await client.query('ROLLBACK');throw error;}
}
