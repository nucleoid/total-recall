import assert from 'node:assert/strict';import test from 'node:test';import pg from 'pg';import {randomUUID} from 'node:crypto';
import {QWEN_CHUNK_CONTRACT,QWEN_CONTRACT_ID,sha256} from '../src/local-embedding-contract.js';
const url=process.env.SHADOW_EMBEDDING_TEST_DATABASE_URL,vector=`[1,${Array(767).fill(0).join(',')}]`;
test('attested serving uses queue readiness and chunk corruption invalidates coverage',{skip:!url},async()=>{
  const pool=new pg.Pool({connectionString:url,max:1}),db=await pool.connect(),run=randomUUID(),key=randomUUID(),parent=randomUUID(),text='integrity fixture';
  try{await db.query('BEGIN');
    await db.query(`INSERT INTO embedding_contracts(id,canonical_json,capture_enabled) VALUES($1,$2,true) ON CONFLICT(id) DO UPDATE SET capture_enabled=true`,[QWEN_CONTRACT_ID,JSON.stringify(QWEN_CHUNK_CONTRACT)]);
    await db.query(`DO $b$ DECLARE part regclass; BEGIN SELECT i.inhrelid::regclass INTO part FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
      WHERE i.inhparent='memory_embedding_chunks'::regclass AND pg_get_expr(c.relpartbound,c.oid) LIKE '%${QWEN_CONTRACT_ID}%' LIMIT 1;
      IF part IS NULL THEN CREATE TABLE memory_embedding_chunks_integrity_test PARTITION OF memory_embedding_chunks FOR VALUES IN ('${QWEN_CONTRACT_ID}');part:='memory_embedding_chunks_integrity_test';END IF;
      EXECUTE format('CREATE INDEX shadow_integrity_hnsw ON %s USING hnsw (embedding vector_cosine_ops)',part);END $b$`);
    await db.query(`INSERT INTO embedding_runs(id,contract_id,release_sha,manifest,status,inventory_complete,source_watermark)
      VALUES($1,$2,$3,'{}','paused',true,statement_timestamp())`,[run,QWEN_CONTRACT_ID,'a'.repeat(40)]);
    await db.query(`INSERT INTO embedding_cutover_attestations(run_id,contract_id,watermark,memory_census,subscription_census,
      audit_receipt_sha256,quality_receipt_sha256,backup_receipt_sha256,approval_sha256)
      VALUES($1,$2,statement_timestamp(),0,0,$3,$3,$3,$3)`,[run,QWEN_CONTRACT_ID,'b'.repeat(64)]);
    await db.query(`INSERT INTO embedding_serving_settings(singleton,contract_id,cutover_attestation_run_id) VALUES(true,$1,$2)`,[QWEN_CONTRACT_ID,run]);
    await db.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level) VALUES($1::uuid,($1::uuid)::text,'integrity',ARRAY['personal'],ARRAY['read','write'],'normal')`,[key]);
    await db.query(`INSERT INTO memories(id,content,source,namespace,client_id,access_level) VALUES($1,$2,'integrity','personal',$3::text,'normal')`,[parent,text,key]);
    await db.query(`INSERT INTO memory_embedding_manifests(contract_id,parent_id,source_sha256,source_revision,source_bytes,chunk_count,total_tokens,is_current)
      SELECT $1,id,$3,revision,octet_length(content),1,1,false FROM memories WHERE id=$2`,[QWEN_CONTRACT_ID,parent,sha256(text)]);
    await db.query(`INSERT INTO memory_embedding_chunks VALUES($1,$2,0,0,$3,$4,1,$5::vector)`,[QWEN_CONTRACT_ID,parent,Buffer.byteLength(text),sha256(text),vector]);
    await db.query('UPDATE memory_embedding_manifests SET is_current=true WHERE contract_id=$1 AND parent_id=$2',[QWEN_CONTRACT_ID,parent]);
    await db.query(`UPDATE embedding_work_items SET state='complete',source_sha256=$3,source_revision=(SELECT revision FROM memories WHERE id=$2) WHERE contract_id=$1 AND parent_id=$2`,[QWEN_CONTRACT_ID,parent,sha256(text)]);
    await db.query('SET LOCAL ROLE total_recall_app');await db.query("SELECT set_config('app.current_key_id',$1,true),set_config('app.allowed_namespaces','[\"personal\"]',true)",[key]);
    assert.equal((await db.query("SELECT shadow_embedding_scope_ready(ARRAY['personal'],'normal') ready")).rows[0].ready,true);await db.query('RESET ROLE');
    await db.query('UPDATE memory_embedding_chunks SET formatted_tokens=2 WHERE contract_id=$1 AND parent_id=$2',[QWEN_CONTRACT_ID,parent]);
    assert.deepEqual((await db.query(`SELECT f.is_current,w.state FROM memory_embedding_manifests f JOIN embedding_work_items w ON w.contract_id=f.contract_id AND w.parent_id=f.parent_id WHERE f.contract_id=$1 AND f.parent_id=$2`,[QWEN_CONTRACT_ID,parent])).rows[0],{is_current:false,state:'pending'});
    await db.query('SET LOCAL ROLE total_recall_app');await db.query("SELECT set_config('app.current_key_id',$1,true),set_config('app.allowed_namespaces','[\"personal\"]',true)",[key]);
    assert.equal((await db.query("SELECT shadow_embedding_scope_ready(ARRAY['personal'],'normal') ready")).rows[0].ready,false);
    await db.query('RESET ROLE');const owner=randomUUID();
    const claimed=(await db.query(`UPDATE embedding_work_items SET state='claimed',generation=generation+1,claimed_by=$3,lease_until=statement_timestamp()+interval '1 minute'
      WHERE contract_id=$1 AND parent_id=$2 RETURNING generation`,[QWEN_CONTRACT_ID,parent,owner])).rows[0];
    await db.query('UPDATE memory_embedding_manifests SET is_current=false,total_tokens=1 WHERE contract_id=$1 AND parent_id=$2',[QWEN_CONTRACT_ID,parent]);
    await db.query('DELETE FROM memory_embedding_chunks WHERE contract_id=$1 AND parent_id=$2',[QWEN_CONTRACT_ID,parent]);
    await db.query(`INSERT INTO memory_embedding_chunks VALUES($1,$2,0,0,$3,$4,1,$5::vector)`,[QWEN_CONTRACT_ID,parent,Buffer.byteLength(text),sha256(text),vector]);
    assert.deepEqual((await db.query('SELECT state,generation,claimed_by FROM embedding_work_items WHERE contract_id=$1 AND parent_id=$2',[QWEN_CONTRACT_ID,parent])).rows[0],
      {state:'claimed',generation:claimed.generation,claimed_by:owner},'derived rebuild does not fence its live claim');
    await db.query('UPDATE memory_embedding_manifests SET is_current=true WHERE contract_id=$1 AND parent_id=$2',[QWEN_CONTRACT_ID,parent]);
    assert.equal((await db.query(`UPDATE embedding_work_items SET state='complete',claimed_by=NULL,lease_until=NULL WHERE contract_id=$1 AND parent_id=$2 AND generation=$3 AND claimed_by=$4 RETURNING 1`,
      [QWEN_CONTRACT_ID,parent,claimed.generation,owner])).rowCount,1);
    await db.query('ROLLBACK');
  }finally{try{await db.query('ROLLBACK');}catch{}db.release();await pool.end();}
});
