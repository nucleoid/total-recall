import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { hashKey, validateKeyReadOnly } from '../src/auth.js';
import { dbScopeFromAuth, setPoolForTesting, withScopedClient } from '../src/db.js';
import { getMemory } from '../src/memories.js';
import { mediaMonthPeriod, runTasteProfile } from '../src/taste-profile.js';
import { QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';

const WORKER='10000000-0000-4000-8000-000000000058';
const EVENT_OWNER='20000000-0000-4000-8000-000000000058';
const LINKED_OWNER='30000000-0000-4000-8000-000000000058';
const MEMORY='40000000-0000-4000-8000-000000000058';
const SECRET_MEMORY='40000000-0000-4000-8000-000000000059';
const EVENT_NORMAL='50000000-0000-4000-8000-000000000058';
const EVENT_SENSITIVE='50000000-0000-4000-8000-000000000059';
const EVENT_SECRET='50000000-0000-4000-8000-000000000060';
const EVENT_SECRET_VIEWING='50000000-0000-4000-8000-000000000061';
const NORMAL_READER='60000000-0000-4000-8000-000000000058';
const SECRET='tr_taste_profile_worker_integration';
const NORMAL_READER_SECRET='tr_taste_profile_normal_reader_integration';

function dockerAvailable():boolean{try{execFileSync('docker',['version'],{stdio:'ignore'});return true;}catch{return false;}}
async function wait(url:string):Promise<pg.Client>{
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){const client=new pg.Client({connectionString:url});try{await client.connect();return client;}
    catch{await client.end().catch(()=>undefined);await new Promise(resolve=>setTimeout(resolve,200));}}
  throw new Error('PostgreSQL did not become ready');
}

test('taste worker performs scoped cross-owner synthesis without raw table authority',{timeout:180000},async t=>{
  if(!dockerAvailable()){t.skip('Docker is unavailable');return;}
  const previousEmbeddingContract=process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  const previousRollbackWrites=process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
  process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT=QWEN_CONTRACT_ID;
  delete process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
  t.after(()=>{
    if(previousEmbeddingContract===undefined)delete process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
    else process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT=previousEmbeddingContract;
    if(previousRollbackWrites===undefined)delete process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
    else process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES=previousRollbackWrites;
  });
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
      ($4,'linked-owner','rollup-owner',ARRAY['media'],ARRAY['read','write'],'secret',true,statement_timestamp()+interval '1 hour'),
      ($5,$6,'normal-reader',ARRAY['personal'],ARRAY['read'],'normal',true,statement_timestamp()+interval '1 hour')`,
      [WORKER,hashKey(SECRET),EVENT_OWNER,LINKED_OWNER,NORMAL_READER,hashKey(NORMAL_READER_SECRET)]);
    await owner.query(`INSERT INTO memories(id,content,source,namespace,access_level,client_id,memory_kind,valid_from)
      VALUES($1,'linked sensitive source','media-rollup','media','sensitive',$3,'semantic',statement_timestamp()),
      ($2,'linked secret source','media-rollup','media','secret',$3,'semantic',statement_timestamp())`,
      [MEMORY,SECRET_MEMORY,LINKED_OWNER]);
    await owner.query(`INSERT INTO media_events
      (id,service,source_id,event_key,event_type,title,artist,played_at,client_id,namespace,memory_id) VALUES
      ($1,'plex','server-a','normal-event','play','Normal Album','Artist A','2026-06-02T00:00:00Z',$3,'media',NULL),
      ($2,'ytmusic','account-b','sensitive-event','play','Sensitive Track','Artist B','2026-06-03T00:00:00Z',$3,'media',$4),
      ($5,'ytmusic','account-b','secret-event','play','Secret Track','Artist C','2026-06-04T00:00:00Z',$3,'media',$6),
      ($7,'plex','server-a','secret-viewing-event','watch','Secret Film',NULL,'2026-06-05T00:00:00Z',$3,'media',$6)`,
      [EVENT_NORMAL,EVENT_SENSITIVE,EVENT_OWNER,MEMORY,EVENT_SECRET,SECRET_MEMORY,EVENT_SECRET_VIEWING]);
    pool=new pg.Pool({connectionString:`postgresql://total_recall_app:app-password@127.0.0.1:${port}/postgres`,max:2});
    setPoolForTesting(pool);
    const auth=await validateKeyReadOnly(SECRET);assert.ok(auth);
    assert.deepEqual(auth.permissions,['read','taste_profile']);
    assert.equal(auth.maxAccessLevel,'secret');
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
    const secret=await withScopedClient(scope,client=>client.query<{snapshot:any[];source_fingerprint:string;event_count:number}>(
      "SELECT snapshot,source_fingerprint,event_count FROM taste_profile_load_snapshot('media','music','secret','2026-07-01T00:00:00Z',10)"));
    assert.equal(secret.rows[0].event_count,1);
    assert.equal(secret.rows[0].snapshot[0].id,EVENT_SECRET);
    assert.equal(secret.rows[0].snapshot[0].event_owner_key_id,EVENT_OWNER);
    assert.equal(secret.rows[0].snapshot[0].linked_memory_owner_key_id,LINKED_OWNER);

    const apply=(accessLevel:'normal'|'sensitive'|'secret',sourceFingerprint:string)=>
      withScopedClient(scope,client=>client.query<{id:string;outcome:string}>(`
      SELECT id,outcome FROM taste_profile_apply_revision(
        'media','personal','music',$1,'2026-07-01T00:00:00Z',10,$2,$3,
        $4,array_fill(0::real,ARRAY[768])::vector,ARRAY['profile','taste'],
        jsonb_build_object('aggregate_hash',$5::text,'generation_model','openclaw/total-recall-synthesis','period','2026-06','series',$6::text),
        'llama.cpp','qwen-test',768,$6::text,'2026-06',false)`,[
        accessLevel,sourceFingerprint,`media-taste:v2:${accessLevel}:music:2026-06`,
        `${accessLevel} music taste profile`,`aggregate-${accessLevel}`,`${accessLevel}:music`,
      ]));
    const created=await apply('normal',normal.rows[0].source_fingerprint);
    const sensitiveCreated=await apply('sensitive',sensitive.rows[0].source_fingerprint);
    const secretCreated=await apply('secret',secret.rows[0].source_fingerprint);
    assert.equal(created.rows[0].outcome,'created');
    assert.equal(sensitiveCreated.rows[0].outcome,'created');
    assert.equal(secretCreated.rows[0].outcome,'created');
    const replay=await apply('normal',normal.rows[0].source_fingerprint);assert.equal(replay.rows[0].outcome,'unchanged');
    const stored=await owner.query(`SELECT id,client_id,access_level,metadata,revision FROM memories WHERE id=ANY($1::uuid[]) ORDER BY access_level`,
      [[created.rows[0].id,sensitiveCreated.rows[0].id,secretCreated.rows[0].id]]);
    assert.equal(stored.rowCount,3);
    for(const row of stored.rows){
      assert.equal(row.client_id,WORKER);
      assert.deepEqual(row.metadata.source_owner_key_ids,[EVENT_OWNER]);
      assert.equal(row.metadata.worker_key_id,WORKER);
      assert.deepEqual(row.metadata.linked_memory_owner_key_ids,row.access_level==='normal'?[]:[LINKED_OWNER]);
    }
    const sourceOwnership=await owner.query(`SELECT
      (SELECT bool_and(client_id=$1) FROM media_events WHERE id=ANY($2::uuid[])) AS events_unchanged,
      (SELECT bool_and(client_id=$3) FROM memories WHERE id=ANY($4::uuid[])) AS linked_unchanged`,
      [EVENT_OWNER,[EVENT_NORMAL,EVENT_SENSITIVE,EVENT_SECRET,EVENT_SECRET_VIEWING],LINKED_OWNER,[MEMORY,SECRET_MEMORY]]);
    assert.equal(sourceOwnership.rows[0].events_unchanged,true);
    assert.equal(sourceOwnership.rows[0].linked_unchanged,true);

    const reader=await validateKeyReadOnly(NORMAL_READER_SECRET);assert.ok(reader);
    assert.equal(reader.keyId,NORMAL_READER);assert.equal(reader.maxAccessLevel,'normal');
    assert.equal((await getMemory(reader,created.rows[0].id))?.id,created.rows[0].id);
    assert.equal(await getMemory(reader,sensitiveCreated.rows[0].id),null);
    assert.equal(await getMemory(reader,secretCreated.rows[0].id),null);
    for(const table of ['media_events','memories','agents','audit_log']){
      const hidden=await withScopedClient(scope,client=>client.query(`SELECT * FROM ${table}`));
      assert.equal(hidden.rowCount,0,`${table} must remain unavailable after protected-lane apply`);
    }

    const approval={approved:true as const,approvedBy:'policy-owner-record',approvedAt:'2026-01-01T00:00:00Z',expiresAt:'2027-01-01T00:00:00Z'};
    const recurringPolicy={version:2 as const,feature:'media-taste-profile' as const,enabled:true as const,environment:'test',
      generation:{provider:'openclaw-adapter' as const,model:'openclaw/total-recall-synthesis' as const,
        endpoint:'https://example.invalid/generate',credentialEnv:'TASTE_TEST_KEY',timeoutMs:1000},
      terms:{reference:'terms-record',privacyApproved:true as const,retentionApproved:true as const,trainingApproved:true as const},
      scope:{namespaces:['media','personal'],sourceNamespace:'media',targetNamespace:'personal',
        accessLevels:['normal' as const,'sensitive' as const,'secret' as const]},
      aggregation:{minimumEvents:1,topLimit:10,trendMinimumAbsoluteChange:3,trendMinimumShareChange:0.1},
      budget:{mode:'subscription' as const,maxCallsPerRun:2 as const,maxOutputBytesPerRun:8192 as const,
        usageControlReference:'private-subscription-control'},
      selection:{previewTtlMinutes:60,maxMaterializedEvents:10},providerModelApproval:approval,termsApproval:approval,
      scopeApproval:approval,budgetApproval:approval,standingAutomation:{enabled:true as const,
        ownerInstruction:{reference:'owner-instruction:recurring-taste',effectiveAt:'2026-06-01T00:00:00Z'},
        operator:{identity:'service:taste-profile-recurring',authorizationReference:'operator-authorization:90-day',
          authorizedAt:'2026-06-15T00:00:00Z',expiresAt:'2026-09-13T00:00:00Z'}}};
    let recurringProviderCalls=0;
    let providerMutation:(()=>Promise<void>)|undefined;
    const recurringProvider={name:'openclaw-adapter',generate:async(request:any)=>{
      recurringProviderCalls+=1;
      assert.equal(request.input.includes(EVENT_SECRET_VIEWING),false);
      assert.equal(request.input.includes(SECRET_MEMORY),false);
      assert.equal(request.input.includes(EVENT_OWNER),false);
      assert.equal(request.input.includes(LINKED_OWNER),false);
      assert.equal(request.input.includes('owner-instruction:recurring-taste'),false);
      await providerMutation?.();
      const evidence=JSON.parse(request.input).evidence as Array<{id:string;kind:string}>;
      const selected=evidence.find(fact=>fact.kind==='entity') ?? evidence.find(fact=>fact.kind!=='quality');
      assert.ok(selected);
      return JSON.stringify({profile_style:'focused',evidence_ids:[selected.id]});
    }};
    const recurringOptions={auth,category:'viewing' as const,period:mediaMonthPeriod('2026-06','UTC'),timeZone:'UTC',
      environment:'test',policy:recurringPolicy,mode:'run-reviewed' as const,accessLevel:'secret' as const,
      now:new Date('2026-07-01T00:00:00Z'),provider:recurringProvider,embedProfile:async()=>Array(768).fill(0)};
    const recurring=await runTasteProfile(recurringOptions);
    assert.equal(recurring.status,'created');assert.equal(recurring.providerCalls,1);assert.equal(recurringProviderCalls,1);
    assert.ok(recurring.memoryId);
    const recurringStored=await owner.query('SELECT metadata FROM memories WHERE id=$1',[recurring.memoryId]);
    assert.equal(recurringStored.rows[0].metadata.approval_mode,'standing-automation');
    assert.equal(recurringStored.rows[0].metadata.approval_reference,'operator-authorization:90-day');
    assert.equal(recurringStored.rows[0].metadata.owner_instruction_reference,'owner-instruction:recurring-taste');
    assert.equal(recurringStored.rows[0].metadata.selection_approved_by,'service:taste-profile-recurring');
    assert.deepEqual(recurringStored.rows[0].metadata.source_owner_key_ids,[EVENT_OWNER]);
    assert.deepEqual(recurringStored.rows[0].metadata.linked_memory_owner_key_ids,[LINKED_OWNER]);
    const beforeChanged=await owner.query(`SELECT content,metadata,client_id,agent_id,access_level,
      embedding_provider,embedding_model FROM memories WHERE id=$1`,[recurring.memoryId]);

    await owner.query("UPDATE media_events SET title='Secret Film changed before review' WHERE id=$1",[EVENT_SECRET_VIEWING]);
    providerMutation=async()=>{await owner.query("UPDATE media_events SET title='Secret Film drifted' WHERE id=$1",[EVENT_SECRET_VIEWING]);};
    await assert.rejects(runTasteProfile({...recurringOptions,now:new Date('2026-07-01T00:01:00Z')}),/source_changed/);
    providerMutation=undefined;
    const afterStale=await owner.query(`SELECT content,metadata,client_id,agent_id,access_level,
      embedding_provider,embedding_model FROM memories WHERE id=$1`,[recurring.memoryId]);
    assert.deepEqual(afterStale.rows[0],beforeChanged.rows[0]);

    providerMutation=async()=>{await owner.query("UPDATE api_keys SET permissions=ARRAY['write'] WHERE id=$1",[EVENT_OWNER]);};
    try{
      await assert.rejects(runTasteProfile({...recurringOptions,now:new Date('2026-07-01T00:02:00Z')}),/expired_or_revoked/);
    }finally{
      providerMutation=undefined;
      await owner.query("UPDATE api_keys SET permissions=ARRAY['read','write'] WHERE id=$1",[EVENT_OWNER]);
    }
    const afterAuthority=await owner.query(`SELECT content,metadata,client_id,agent_id,access_level,
      embedding_provider,embedding_model FROM memories WHERE id=$1`,[recurring.memoryId]);
    assert.deepEqual(afterAuthority.rows[0],beforeChanged.rows[0]);

    const changed=await runTasteProfile({...recurringOptions,now:new Date('2026-07-01T00:03:00Z')});
    assert.equal(changed.status,'updated');assert.equal(changed.memoryId,recurring.memoryId);assert.equal(changed.providerCalls,1);
    const afterChanged=await owner.query(`SELECT content,metadata,client_id,agent_id,access_level,
      embedding_provider,embedding_model FROM memories WHERE id=$1`,[recurring.memoryId]);
    assert.match(afterChanged.rows[0].content,/Secret Film drifted/);
    assert.notEqual(afterChanged.rows[0].metadata.aggregate_hash,beforeChanged.rows[0].metadata.aggregate_hash);
    assert.notEqual(afterChanged.rows[0].metadata.source_fingerprint,beforeChanged.rows[0].metadata.source_fingerprint);
    assert.equal(afterChanged.rows[0].client_id,WORKER);assert.equal(afterChanged.rows[0].access_level,'secret');
    assert.equal(afterChanged.rows[0].embedding_provider,'llama.cpp');
    assert.equal(afterChanged.rows[0].embedding_model,QWEN_CONTRACT_ID);
    assert.equal((await owner.query('SELECT api_key_id FROM agents WHERE id=$1',[afterChanged.rows[0].agent_id])).rows[0].api_key_id,WORKER);
    assert.deepEqual(afterChanged.rows[0].metadata.source_owner_key_ids,[EVENT_OWNER]);
    assert.deepEqual(afterChanged.rows[0].metadata.linked_memory_owner_key_ids,[LINKED_OWNER]);
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM audit_log WHERE memory_id=$1 AND action='memory.taste-profile'",
      [recurring.memoryId])).rows[0].count,2);
    const recurringReplay=await runTasteProfile({...recurringOptions,now:new Date('2026-07-01T00:04:00Z')});
    assert.equal(recurringReplay.status,'unchanged');assert.equal(recurringReplay.providerCalls,0);
    assert.equal(recurringProviderCalls,4);

    await owner.query('UPDATE media_events SET title=title||\' changed\' WHERE id=$1',[EVENT_NORMAL]);
    await assert.rejects(apply('normal',normal.rows[0].source_fingerprint),/taste_source_changed/);
    await owner.query('UPDATE media_events SET title=\'Normal Album\' WHERE id=$1',[EVENT_NORMAL]);
    await owner.query("UPDATE memories SET content=content||' revised' WHERE id=$1",[MEMORY]);
    await assert.rejects(apply('sensitive',sensitive.rows[0].source_fingerprint),/taste_source_changed/);
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
