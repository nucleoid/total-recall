import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { LocalEmbeddingClient } from '../src/local-embedding-client.js';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import { setLocalServingClientForTesting } from '../src/local-embedding-runtime.js';
import { setPoolForTesting } from '../src/db.js';
import type { AuthContext } from '../src/types.js';
import {activateAttestedServing} from './shadow-embedding-fixtures.js';

const url = process.env.SHADOW_EMBEDDING_TEST_DATABASE_URL;
const sha = (value:string) => createHash('sha256').update(value).digest('hex');
const nativeVector = (axis:number) => Array.from({length:1024},(_,i)=>i===axis?1:0);

function fakeClient(onEmbed?:()=>Promise<void>) {
  let notified=false;
  return new LocalEmbeddingClient({baseUrl:'http://localhost:1234',bearerToken:'synthetic',
    runtime:{contractId:QWEN_CONTRACT_ID,artifactSha256:QWEN_CHUNK_CONTRACT.artifactSha256,
      runtimeContract:QWEN_CHUNK_CONTRACT.runtimeContract,acceptanceReceiptSha256:'e'.repeat(64)},
    beforeInference:async()=>{},fetch:(async (target:string|URL|Request,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body));
      if(String(target).endsWith('/tokenize')) return Response.json({tokens:Array(Math.max(1,Math.ceil(Buffer.byteLength(body.content)/8))).fill(1)});
      if(onEmbed&&!notified){notified=true;await onEmbed();}
      const inputs=body.input as string[];
      return Response.json({data:inputs.map((input,index)=>({index,embedding:nativeVector(input.includes('MATCH-LATER')?1:0)})),
        usage:{prompt_tokens:inputs.reduce((sum,input)=>sum+Math.max(1,Math.ceil(Buffer.byteLength(input)/8)),0)}});
    }) as typeof fetch});
}

test('application writers publish complete local chunks, dedupe across later chunks, and fence stale authority',
  {skip:!url},async()=>{
  assert.equal(new URL(url!).pathname,'/total_recall_reembedding_test','dedicated test database required');
  const pool=new pg.Pool({connectionString:url,max:4});
  const key=randomUUID(),prefix=`writer-${randomUUID()}`;
  let attestationRun:string|undefined;
  const auth:AuthContext={keyId:key,name:prefix,namespaces:['personal'],permissions:['read','write'],maxAccessLevel:'normal'};
  const originalEnv={...process.env};
  process.env.NODE_ENV='test';process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT=QWEN_CONTRACT_ID;
  delete process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
  try{
    attestationRun=await activateAttestedServing(pool);
    await pool.query(`DO $b$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
      WHERE i.inhparent='memory_embedding_chunks'::regclass AND pg_get_expr(c.relpartbound,c.oid) LIKE '%${QWEN_CONTRACT_ID}%') THEN
      CREATE TABLE memory_embedding_chunks_writers_test PARTITION OF memory_embedding_chunks FOR VALUES IN ('${QWEN_CONTRACT_ID}'); END IF; END $b$`);
    await pool.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      VALUES($1::uuid,($1::uuid)::text,$2,ARRAY['personal'],ARRAY['read','write'],'normal')`,[key,prefix]);
    setPoolForTesting(pool);setLocalServingClientForTesting(fakeClient());
    const {memoryStore,storeSchema}=await import(`../src/tools/store.js?writers=${Date.now()}`);

    const content=`${'a'.repeat(1600)}\n\nMATCH-LATER`;
    const first=await memoryStore(storeSchema.parse({content,namespace:'personal',source:prefix,dedupe:true}),auth);
    assert.equal(first.created,true);
    const chunks=await pool.query(`SELECT ordinal,core_start,core_end,chunk_sha256 FROM memory_embedding_chunks
      WHERE contract_id=$1 AND parent_id=$2 ORDER BY ordinal`,[QWEN_CONTRACT_ID,first.id]);
    assert.ok(chunks.rowCount!>1,'long input produced multiple target chunks');
    const bytes=Buffer.from(content);let cursor=0;
    for(const row of chunks.rows){assert.equal(row.ordinal,chunks.rows.indexOf(row));assert.equal(row.core_start,cursor);
      assert.equal(row.chunk_sha256,sha(bytes.subarray(row.core_start,row.core_end).toString()));cursor=row.core_end;}
    assert.equal(cursor,bytes.length);
    const manifest=(await pool.query(`SELECT is_current,source_bytes,chunk_count FROM memory_embedding_manifests
      WHERE contract_id=$1 AND parent_id=$2`,[QWEN_CONTRACT_ID,first.id])).rows[0];
    assert.deepEqual(manifest,{is_current:true,source_bytes:bytes.length,chunk_count:chunks.rowCount});

    const duplicate=await memoryStore(storeSchema.parse({content:'MATCH-LATER',namespace:'personal',source:prefix,dedupe:true}),auth);
    assert.equal(duplicate.id,first.id);assert.equal(duplicate.deduplicated,true);

    const incomplete=randomUUID();
    await pool.query(`INSERT INTO memories(id,content,source,namespace,client_id,access_level,memory_kind,valid_from)
      VALUES($1,'pending target',$2,'personal',$3::text,'normal','semantic',statement_timestamp())`,[incomplete,prefix,key]);
    await assert.rejects(memoryStore(storeSchema.parse({content:'orthogonal',namespace:'personal',source:prefix,dedupe:true}),auth),
      /shadow_embedding\.dedupe_scope_incomplete/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM memories WHERE source=$1',[prefix])).rows[0].n,2);
    await pool.query('DELETE FROM memories WHERE id=$1',[incomplete]);

    setLocalServingClientForTesting(fakeClient(async()=>{await pool.query('UPDATE api_keys SET revoked_at=statement_timestamp() WHERE id=$1',[key]);}));
    await assert.rejects(memoryStore(storeSchema.parse({content:'revocation race',namespace:'personal',source:prefix,dedupe:false}),auth));
    assert.equal((await pool.query("SELECT count(*)::int n FROM memories WHERE source=$1 AND content='revocation race'",[prefix])).rows[0].n,0);
  }finally{
    setLocalServingClientForTesting(undefined);setPoolForTesting(null);process.env=originalEnv;
    await pool.query('DELETE FROM memories WHERE source=$1',[prefix]).catch(()=>{});
    await pool.query('DELETE FROM agents WHERE api_key_id=$1',[key]).catch(()=>{});
    await pool.query('DELETE FROM api_keys WHERE id=$1',[key]).catch(()=>{});
    await pool.query('DELETE FROM embedding_serving_settings WHERE cutover_attestation_run_id=$1',[attestationRun]).catch(()=>{});
    await pool.query('DELETE FROM embedding_cutover_attestations WHERE run_id=$1',[attestationRun]).catch(()=>{});
    await pool.query('DELETE FROM embedding_runs WHERE id=$1',[attestationRun]).catch(()=>{});
    await pool.end();
  }
});
