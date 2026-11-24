import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { hashKey, validateKeyReadOnly } from '../src/auth.js';
import { dbScopeFromAuth, setPoolForTesting, withScopedClient } from '../src/db.js';

const WORKER='10000000-0000-4000-8000-000000000058';
const EVENT_OWNER='20000000-0000-4000-8000-000000000058';
const LINKED_OWNER='30000000-0000-4000-8000-000000000058';
const MEMORY='40000000-0000-4000-8000-000000000058';
const EVENT_NORMAL='50000000-0000-4000-8000-000000000058';
const EVENT_SENSITIVE='50000000-0000-4000-8000-000000000059';
const SECRET='tr_taste_profile_worker_integration';

function dockerAvailable():boolean{try{execFileSync('docker',['version'],{stdio:'ignore'});return true;}catch{return false;}}
async function wait(url:string):Promise<pg.Client>{
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){const client=new pg.Client({connectionString:url});try{await client.connect();return client;}
    catch{await client.end().catch(()=>undefined);await new Promise(resolve=>setTimeout(resolve,200));}}
  throw new Error('PostgreSQL did not become ready');
}

test('taste worker performs scoped cross-owner synthesis without raw table authority',{timeout:180000},async t=>{
  if(!dockerAvailable()){t.skip('Docker is unavailable');return;}
  const container=execFileSync('docker',['run','--rm','-d','-e','POSTGRES_PASSWORD=postgres','-p','127.0.0.1::5432',
    process.env.CONSOLIDATION_TEST_IMAGE||'pgvector/pgvector:pg16'],{encoding:'utf8'}).trim();
  t.after(()=>{try{execFileSync('docker',['rm','-f',container],{stdio:'ignore'});}catch{}});
  const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8'}).trim().split(':').at(-1)!;
  const owner=await wait(`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`);
  let pool:pg.Pool|undefined;
  try{
    await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
    await owner.query("CREATE ROLE total_recall_app LOGIN PASSWORD 'app-password'");
    for(const file of readdirSync(join(process.cwd(),'migrations')).filter(name=>/^\d{3}_.*\.sql$/.test(name)).sort())
      await owner.query(readFileSync(join(process.cwd(),'migrations',file),'utf8'));
    await owner.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level,enabled,expires_at) VALUES
      ($1,$2,'taste-worker',ARRAY['media','personal'],ARRAY['read','taste_profile'],'secret',true,statement_timestamp()+interval '1 hour'),
      ($3,'event-owner','plex-owner',ARRAY['media'],ARRAY['read','write'],'secret',true,statement_timestamp()+interval '1 hour'),
      ($4,'linked-owner','rollup-owner',ARRAY['media'],ARRAY['read','write'],'secret',true,statement_timestamp()+interval '1 hour')`,
      [WORKER,hashKey(SECRET),EVENT_OWNER,LINKED_OWNER]);
    await owner.query(`INSERT INTO memories(id,content,source,namespace,access_level,client_id,memory_kind,valid_from)
      VALUES($1,'linked sensitive source','media-rollup','media','sensitive',$2,'semantic',statement_timestamp())`,[MEMORY,LINKED_OWNER]);
    await owner.query(`INSERT INTO media_events
      (id,service,source_id,event_key,event_type,title,artist,played_at,client_id,namespace,memory_id) VALUES
      ($1,'plex','server-a','normal-event','play','Normal Album','Artist A','2026-06-02T00:00:00Z',$3,'media',NULL),
      ($2,'ytmusic','account-b','sensitive-event','play','Sensitive Track','Artist B','2026-06-03T00:00:00Z',$3,'media',$4)`,
      [EVENT_NORMAL,EVENT_SENSITIVE,EVENT_OWNER,MEMORY]);
    pool=new pg.Pool({connectionString:`postgresql://total_recall_app:app-password@127.0.0.1:${port}/postgres`,max:2});
    setPoolForTesting(pool);
    const auth=await validateKeyReadOnly(SECRET);assert.ok(auth);
    assert.deepEqual(auth.permissions,['read','taste_profile']);
    const scope=dbScopeFromAuth(auth);
    for(const table of ['media_events','memories','agents','audit_log']){
      const hidden=await withScopedClient(scope,client=>client.query(`SELECT * FROM ${table}`));
      assert.equal(hidden.rowCount,0,`${table} must have no raw worker lane`);
    }
    await assert.rejects(withScopedClient(scope,client=>client.query(
      `INSERT INTO memories(content,source,namespace,access_level,client_id,memory_kind,valid_from)
       VALUES('forged','manual','personal','normal',$1,'semantic',statement_timestamp())`,[WORKER])),
      error=>(error as {code?:string}).code==='42501');

    const normal=await withScopedClient(scope,client=>client.query<{snapshot:any[];source_fingerprint:string;event_count:number}>(
      "SELECT * FROM taste_profile_load_snapshot('media','music','normal','2026-07-01T00:00:00Z',10)"));
    assert.equal(normal.rows[0].event_count,1);
    assert.equal(normal.rows[0].snapshot[0].id,EVENT_NORMAL);
    assert.equal(normal.rows[0].snapshot[0].event_owner_key_id,EVENT_OWNER);
    const sensitive=await withScopedClient(scope,client=>client.query<{snapshot:any[];source_fingerprint:string;event_count:number}>(
      "SELECT snapshot,source_fingerprint,event_count FROM taste_profile_load_snapshot('media','music','sensitive','2026-07-01T00:00:00Z',10)"));
    assert.equal(sensitive.rows[0].event_count,1);
    assert.equal(sensitive.rows[0].snapshot[0].memory_revision,0);
    assert.equal(sensitive.rows[0].snapshot[0].linked_memory_owner_key_id,LINKED_OWNER);

    const args=[normal.rows[0].source_fingerprint,'media-taste:v2:normal:music:2026-06'];
    const apply=()=>withScopedClient(scope,client=>client.query<{id:string;outcome:string}>(`
      SELECT id,outcome FROM taste_profile_apply_revision(
        'media','personal','music','normal','2026-07-01T00:00:00Z',10,$1,$2,
        'Music taste profile',array_fill(0::real,ARRAY[768])::vector,ARRAY['profile','taste'],
        '{"aggregate_hash":"aggregate-a","generation_model":"openclaw/total-recall-synthesis","period":"2026-06","series":"normal:music"}',
        'llama.cpp','qwen-test',768,'normal:music','2026-06',false)`,args));
    const created=await apply();assert.equal(created.rows[0].outcome,'created');
    const replay=await apply();assert.equal(replay.rows[0].outcome,'unchanged');
    const stored=await owner.query(`SELECT client_id,access_level,metadata,revision FROM memories WHERE id=$1`,[created.rows[0].id]);
    assert.equal(stored.rows[0].client_id,WORKER);assert.equal(stored.rows[0].access_level,'normal');
    assert.deepEqual(stored.rows[0].metadata.source_owner_key_ids,[EVENT_OWNER]);
    assert.equal(stored.rows[0].metadata.worker_key_id,WORKER);

    await owner.query('UPDATE media_events SET title=title||\' changed\' WHERE id=$1',[EVENT_NORMAL]);
    await assert.rejects(apply(),/taste_source_changed/);
    await owner.query('UPDATE media_events SET title=\'Normal Album\' WHERE id=$1',[EVENT_NORMAL]);
    await owner.query("UPDATE memories SET content=content||' revised' WHERE id=$1",[MEMORY]);
    await assert.rejects(withScopedClient(scope,client=>client.query(`
      SELECT * FROM taste_profile_apply_revision(
        'media','personal','music','sensitive','2026-07-01T00:00:00Z',10,$1,'media-taste:v2:sensitive:music:2026-06',
        'Sensitive profile',array_fill(0::real,ARRAY[768])::vector,ARRAY['profile'],
        '{"aggregate_hash":"aggregate-sensitive","generation_model":"openclaw/total-recall-synthesis","period":"2026-06","series":"sensitive:music"}',
        'llama.cpp','qwen-test',768,'sensitive:music','2026-06',false)`,[sensitive.rows[0].source_fingerprint])),/taste_source_changed/);
    await owner.query("UPDATE api_keys SET permissions=ARRAY['write'] WHERE id=$1",[EVENT_OWNER]);
    await assert.rejects(withScopedClient(scope,client=>client.query(
      "SELECT * FROM taste_profile_load_snapshot('media','music','normal','2026-07-01T00:00:00Z',10)")),/expired_or_revoked/);
    await owner.query("UPDATE api_keys SET permissions=ARRAY['read','write'] WHERE id=$1",[EVENT_OWNER]);
    await owner.query("UPDATE api_keys SET expires_at=statement_timestamp()-interval '1 second' WHERE id=$1",[LINKED_OWNER]);
    await assert.rejects(withScopedClient(scope,client=>client.query(
      "SELECT * FROM taste_profile_load_snapshot('media','music','sensitive','2026-07-01T00:00:00Z',10)")),/expired_or_revoked/);
    await owner.query("UPDATE api_keys SET permissions=ARRAY['read'] WHERE id=$1",[WORKER]);
    await assert.rejects(withScopedClient(scope,client=>client.query(
      "SELECT * FROM taste_profile_load_snapshot('media','music','normal','2026-07-01T00:00:00Z',10)")),
      error=>(error as {code?:string}).code==='42501');
  }finally{setPoolForTesting(null);await pool?.end().catch(()=>undefined);await owner.end().catch(()=>undefined);}
});
