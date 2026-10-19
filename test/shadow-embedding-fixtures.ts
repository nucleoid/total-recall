import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {QWEN_CHUNK_CONTRACT,QWEN_CONTRACT_ID} from '../src/local-embedding-contract.js';

/** Operator-only synthetic cutover proof for the disposable integration database. */
export async function activateAttestedServing(db:pg.PoolClient|pg.Pool):Promise<string>{
  const run=randomUUID();
  await db.query(`INSERT INTO embedding_contracts(id,canonical_json,capture_enabled) VALUES($1,$2,true)
    ON CONFLICT(id) DO UPDATE SET capture_enabled=true`,[QWEN_CONTRACT_ID,JSON.stringify(QWEN_CHUNK_CONTRACT)]);
  await db.query(`DO $b$ DECLARE part regclass;BEGIN SELECT i.inhrelid::regclass INTO part FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
    WHERE i.inhparent='memory_embedding_chunks'::regclass AND pg_get_expr(c.relpartbound,c.oid) LIKE '%${QWEN_CONTRACT_ID}%' LIMIT 1;
    IF part IS NULL THEN CREATE TABLE memory_embedding_chunks_qwen_fixture PARTITION OF memory_embedding_chunks FOR VALUES IN ('${QWEN_CONTRACT_ID}');part:='memory_embedding_chunks_qwen_fixture';END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=part AND pg_get_indexdef(i.indexrelid) LIKE '%USING hnsw%') THEN
      EXECUTE format('CREATE INDEX %I ON %s USING hnsw (embedding vector_cosine_ops)','shadow_fixture_hnsw_'||substr(md5(part::text),1,12),part);END IF;END $b$`);
  await db.query(`INSERT INTO embedding_runs(id,contract_id,release_sha,manifest,status,inventory_complete,source_watermark)
    VALUES($1,$2,$3,'{"syntheticAttestation":true}','paused',true,statement_timestamp())`,[run,QWEN_CONTRACT_ID,'f'.repeat(40)]);
  const census=(await db.query(`SELECT
    (SELECT count(*)::bigint FROM memories m WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
      AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp()) AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())) memory_census,
    (SELECT count(*)::bigint FROM memory_subscriptions s JOIN api_keys k ON k.id=s.api_key_id
      WHERE s.status='active' AND k.enabled AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp())) subscription_census`)).rows[0];
  await db.query(`INSERT INTO embedding_cutover_attestations(run_id,contract_id,watermark,memory_census,subscription_census,
    audit_receipt_sha256,quality_receipt_sha256,backup_receipt_sha256,approval_sha256) VALUES($1,$2,statement_timestamp(),$3,$4,$5,$5,$5,$5)`,[run,QWEN_CONTRACT_ID,census.memory_census,census.subscription_census,'e'.repeat(64)]);
  await db.query(`INSERT INTO embedding_serving_settings(singleton,contract_id,capture_required,cutover_attestation_run_id)
    VALUES(true,$1,true,$2) ON CONFLICT(singleton) DO UPDATE SET contract_id=EXCLUDED.contract_id,capture_required=true,cutover_attestation_run_id=EXCLUDED.cutover_attestation_run_id`,[QWEN_CONTRACT_ID,run]);
  return run;
}
