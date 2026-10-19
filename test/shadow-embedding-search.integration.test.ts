import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import { setPoolForTesting } from '../src/db.js';
import type { SearchResult } from '../src/types.js';
import {activateAttestedServing} from './shadow-embedding-fixtures.js';

const url = process.env.SHADOW_EMBEDDING_TEST_DATABASE_URL;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const vec = (x: number) => `[${x},${Math.sqrt(1-x*x)},${Array(766).fill(0).join(',')}]`;

class SavepointPool {
  constructor(private readonly client: pg.PoolClient) {}
  async connect() {
    const client = this.client;
    return {
      query: async (text: string, values?: unknown[]) => {
        if (text === 'BEGIN') return client.query('SAVEPOINT local_search_scope');
        if (text === 'COMMIT') return client.query('RELEASE SAVEPOINT local_search_scope');
        if (text === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT local_search_scope');
        return client.query(text, values);
      },
      release() {},
    };
  }
}

test('local search aggregates chunks and excludes unauthorized, stale, incomplete and inactive parents',
  { skip: !url }, async () => {
  process.env.EMBEDDING_PROVIDER = 'gemini';
  process.env.EMBEDDING_MODEL = 'gemini-embedding-2-preview';
  process.env.EMBEDDING_DIMENSIONS = '768';
  process.env.GEMINI_API_KEY = 'synthetic-never-called';
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  const owner = randomUUID();
  const ids = {
    long: randomUUID(), second: randomUUID(), cross: randomUUID(), secret: randomUUID(),
    deleted: randomUUID(), expired: randomUUID(), stale: randomUUID(), incomplete: randomUUID(),
  };
  const rows: Array<[string,string,string,string,Date|null,Date|null]> = [
    [ids.long,'long parent','personal','normal',null,null],
    [ids.second,'second parent','personal','normal',null,null],
    [ids.cross,'cross namespace','my-life','normal',null,null],
    [ids.secret,'secret parent','personal','secret',null,null],
    [ids.deleted,'deleted parent','personal','normal',new Date(),null],
    [ids.expired,'expired parent','personal','normal',null,new Date(Date.now()-60_000)],
    [ids.stale,'current source','personal','normal',null,null],
    [ids.incomplete,'incomplete parent','personal','normal',null,null],
  ];
  const oldFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error('provider forbidden'); };
  try {
    await client.query('BEGIN');
    await activateAttestedServing(client);
    await client.query(`DO $b$ BEGIN IF NOT EXISTS (
      SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
      WHERE i.inhparent='memory_embedding_chunks'::regclass
        AND pg_get_expr(c.relpartbound,c.oid) LIKE '%${QWEN_CONTRACT_ID}%') THEN
      CREATE TABLE memory_embedding_chunks_search_test PARTITION OF memory_embedding_chunks
        FOR VALUES IN ('${QWEN_CONTRACT_ID}'); END IF; END $b$`);
    await client.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      VALUES($1::uuid,($1::uuid)::text,'search-owner',ARRAY['personal'],ARRAY['read','write'],'normal')`,[owner]);
    for(const [id,content,namespace,access,deleted,expires] of rows.slice(0,6)) await client.query(
      `INSERT INTO memories(id,content,source,namespace,client_id,access_level,deleted_at,expires_at)
       VALUES($1,$2,'test',$3,$4::text,$5,$6,$7)`,[id,content,namespace,owner,access,deleted,expires]);
    const revisionRows=await client.query('SELECT id,revision FROM memories WHERE id=ANY($1::uuid[])',[Object.values(ids)]);
    const revisions=new Map<string,number>(revisionRows.rows.map(r=>[r.id,r.revision]));
    const add=async(id:string,sourceSha:string,vectors:string[],declared=vectors.length)=>{
      const content=rows.find(r=>r[0]===id)![1];
      await client.query(`INSERT INTO memory_embedding_manifests(contract_id,parent_id,source_sha256,source_revision,
        source_bytes,chunk_count,total_tokens,is_current) VALUES($1,$2,$3,$4,$5,$6::integer,$6::bigint,false)
        ON CONFLICT(contract_id,parent_id) DO UPDATE SET source_sha256=EXCLUDED.source_sha256,
        source_revision=EXCLUDED.source_revision,source_bytes=EXCLUDED.source_bytes,
        chunk_count=EXCLUDED.chunk_count,total_tokens=EXCLUDED.total_tokens,is_current=false`,
      [QWEN_CONTRACT_ID,id,sourceSha,revisions.get(id),Buffer.byteLength(content),declared]);
      await client.query('DELETE FROM memory_embedding_chunks WHERE contract_id=$1 AND parent_id=$2',[QWEN_CONTRACT_ID,id]);
      const sourceBytes=Buffer.from(content);for(let ordinal=0;ordinal<vectors.length;ordinal++){const start=Math.floor(sourceBytes.length*ordinal/vectors.length),end=Math.floor(sourceBytes.length*(ordinal+1)/vectors.length);await client.query(
        `INSERT INTO memory_embedding_chunks(contract_id,parent_id,ordinal,core_start,core_end,chunk_sha256,formatted_tokens,embedding)
         VALUES($1,$2,$3,$4,$5,$6,1,$7::vector)`,[QWEN_CONTRACT_ID,id,ordinal,start,end,sha(sourceBytes.subarray(start,end).toString()),vectors[ordinal]]);}
      if(declared===vectors.length && sourceSha===sha(content)){await client.query('UPDATE memory_embedding_manifests SET is_current=true WHERE contract_id=$1 AND parent_id=$2',[QWEN_CONTRACT_ID,id]);
        await client.query(`UPDATE embedding_work_items SET state='complete',source_sha256=$3,source_revision=$4
          WHERE contract_id=$1 AND parent_id=$2`,[QWEN_CONTRACT_ID,id,sourceSha,revisions.get(id)]);}
    };
    await add(ids.long,sha('long parent'),[vec(0),vec(1)]);
    await add(ids.second,sha('second parent'),[vec(0.8)]);
    await add(ids.cross,sha('cross namespace'),[vec(1)]);
    await add(ids.secret,sha('secret parent'),[vec(1)]);
    await add(ids.deleted,sha('deleted parent'),[vec(1)]);
    await add(ids.expired,sha('expired parent'),[vec(1)]);

    setPoolForTesting(new SavepointPool(client) as unknown as pg.Pool);
    const {rankMemories}=await import(`../src/search.js?shadow-pg=${Date.now()}`);
    const found=await rankMemories({query:'zz-no-text-match',threshold:0,limit:20},['personal'],
      {namespaces:['personal'],keyId:owner,isAdmin:false},'normal',{queryVectors:[{
        profile:{name:'qwen',provider:'llama.cpp',model:QWEN_CONTRACT_ID,dimensions:768},vector:[1,...Array(767).fill(0)],
      }]});
    assert.deepEqual(found.map((row:SearchResult)=>row.id),[ids.long,ids.second]);
    assert.equal(found.filter((row:SearchResult)=>row.id===ids.long).length,1);
    assert.ok(Number(found[0].vec_score)>Number(found[1].vec_score));
    assert.equal(providerCalls,0);

    for(const [id,content,namespace,access,deleted,expires] of rows.slice(6)) await client.query(
      `INSERT INTO memories(id,content,source,namespace,client_id,access_level,deleted_at,expires_at)
       VALUES($1,$2,'test',$3,$4::text,$5,$6,$7)`,[id,content,namespace,owner,access,deleted,expires]);
    const late=await client.query('SELECT id,revision FROM memories WHERE id=ANY($1::uuid[])',[[ids.stale,ids.incomplete]]);
    for(const row of late.rows)revisions.set(row.id,row.revision);
    await add(ids.stale,sha('old source'),[vec(1)]);
    await add(ids.incomplete,sha('incomplete parent'),[vec(1)],2);
    const fallback=await rankMemories({query:'zz-no-text-match',threshold:0,limit:20},['personal'],
      {namespaces:['personal'],keyId:owner,isAdmin:false},'normal',{queryVectors:[{
        profile:{name:'qwen',provider:'llama.cpp',model:QWEN_CONTRACT_ID,dimensions:768},vector:[1,...Array(767).fill(0)],
      }]});
    assert.deepEqual(fallback,[],'an incomplete eligible target scope falls back to text-only results');
  } finally {
    setPoolForTesting(null);
    globalThis.fetch=oldFetch;
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    await pool.end();
  }
});
