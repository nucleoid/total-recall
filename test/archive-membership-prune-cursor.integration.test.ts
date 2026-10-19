import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {readFile,readdir} from 'node:fs/promises';
import {archivePrefix} from '../src/archive/sync-format.js';
import {finalizeArchive} from '../src/archive/sync-store.js';
import {fixtureManifest,fixtureStream} from './archive-sync.test.js';

test('bounded prune advances past protected-only keys, rolls back a blocked batch, and counts duplicate old keys once',{
  skip:!process.env.ARCHIVE_SYNC_TEST_DATABASE_URL,timeout:60000,
},async()=>{
  const url=process.env.ARCHIVE_SYNC_TEST_DATABASE_URL!;
  assert.equal(new URL(url).pathname,'/total_recall_sync_test','disposable test database required');
  const owner=new pg.Pool({connectionString:url,max:2});let app:pg.Pool|undefined;
  try{
    await owner.query('drop schema public cascade; create schema public; create extension vector');
    await owner.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='total_recall_app')
      then create role total_recall_app login; end if; end $$`);
    for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort())
      await owner.query(await readFile('migrations/'+name,'utf8'));
    const key='11111111-1111-4111-8111-111111111111';
    const early='10000000-0000-4000-8000-000000000001';
    const current='20000000-0000-4000-8000-000000000002';
    const late='30000000-0000-4000-8000-000000000003';
    const archiveId='synthetic-prune-cursor',prefix=archivePrefix(archiveId);
    const stateKey=`mylife:state:${archiveId}`;
    const earlyOnly=`${prefix}a:0000501`,shared=`${prefix}a:0000502`,overlap=`${prefix}a:0000503`;
    const lateOnly=`${prefix}b:late`,currentOnly=`${prefix}c:current`;
    const manifest={...fixtureManifest(),archive_id:archiveId};
    let complete:Record<string,unknown>|undefined;
    for await(const part of fixtureStream(manifest,[]))complete=JSON.parse(String(part).trim().split('\n').at(-1)!);
    complete!.chunks=1;complete!.records=1;
    const pending={manifest,complete,removed:0,cursor:null,membership_id:current,reconciliation_complete:true};
    await owner.query(`insert into api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      values($1::uuid,$1::text,'prune-sync',array['my-life'],array['read','write','import'],'sensitive')`,[key]);
    await owner.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,memory_kind,valid_from,decay_rate)
      values('Synthetic state','my-life:sync-state','my-life',array['my-life'],$1,'sensitive',$2,$3,'synced',now(),0)`,
      [JSON.stringify({started_manifest:manifest,copy_in_progress:true,membership_id:current,pending_finalization:pending}),key,stateKey]);
    await owner.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,
      memory_kind,valid_from,decay_rate,deleted_at)
      select 'Synthetic protected','my-life','my-life',array['my-life'],
        jsonb_build_object('my_life',jsonb_build_object('archive_id',$2::text)),
        case when g>250 then 'secret' else 'sensitive' end,$1::text,
        $3||'a:'||lpad(g::text,7,'0'),'synced',now(),0,
        case when g<=250 then now() else null end from generate_series(1,500) g`,[key,archiveId,prefix]);
    for(const sourceKey of [earlyOnly,shared,overlap,lateOnly,currentOnly])
      await owner.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,
        memory_kind,valid_from,decay_rate) values('Synthetic eligible','my-life','my-life',array['my-life'],
        jsonb_build_object('my_life',jsonb_build_object('archive_id',$3::text)),'sensitive',$1,$2,'synced',now(),0)`,
        [key,sourceKey,archiveId]);
    await owner.query(`insert into archive_sync_snapshot_memberships(sync_key_id,archive_id,membership_id,source_key)
      select $1::uuid,$2,$3::uuid,$4||'a:'||lpad(g::text,7,'0') from generate_series(1,500) g`,
      [key,archiveId,early,prefix]);
    await owner.query(`insert into archive_sync_snapshot_memberships(sync_key_id,archive_id,membership_id,source_key)
      values($1,$2,$3,$4),($1,$2,$3,$5),($1,$2,$6,$5),($1,$2,$6,$7),($1,$2,$8,$9)`,
      [key,archiveId,early,earlyOnly,shared,late,lateOnly,current,currentOnly]);
    await owner.query(`insert into archive_sync_snapshot_memberships(sync_key_id,archive_id,membership_id,source_key)
      values($1,$2,$3,$4),($1,$2,$5,$4)`,[key,archiveId,early,overlap,current]);
    const appUrl=new URL(url);appUrl.username='total_recall_app';appUrl.password='';
    app=new pg.Pool({connectionString:appUrl.toString(),max:2});
    const blocker=await owner.connect();
    const progress:Record<string,unknown>[]=[];
    try{
      await blocker.query('begin');
      await blocker.query('select id from memories where client_id=$1 and source_key=$2 for update',[key,earlyOnly]);
      const first=finalizeArchive(app,key,archiveId,event=>progress.push(event));void first.catch(()=>{});
      let advanced=false;
      for(let attempt=0;attempt<100;attempt++){
        const state=(await owner.query(`select metadata->'pending_finalization' pending from memories
          where client_id=$1 and source_key=$2`,[key,stateKey])).rows[0].pending;
        if(state.prune_source_key===`${prefix}a:0000500`){
          assert.equal(state.removed,0,'protected-only batch advances cursor without counting rows');
          advanced=true;break;
        }
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.equal(advanced,true);
      await assert.rejects(first,error=>typeof error==='object'&&error!==null&&'code' in error&&error.code==='55P03',
        'blocked eligible batch rolls back before changing its cursor or rows');
      assert.ok(progress.some(event=>event.event==='archive_sync.prune_progress'&&event.scanned===500&&event.removed===0),
        'protected-only batch emits a heartbeat even with no removals');
      const failed=(await owner.query(`select metadata->'pending_finalization' pending from memories
        where client_id=$1 and source_key=$2`,[key,stateKey])).rows[0].pending;
      assert.equal(failed.prune_source_key,`${prefix}a:0000500`);
      assert.equal(failed.removed,0);
      assert.equal((await owner.query(`select count(*)::int n from archive_sync_snapshot_memberships
        where sync_key_id=$1 and archive_id=$2 and membership_id=$3 and source_key=$4`,
        [key,archiveId,early,earlyOnly])).rows[0].n,1);
    }finally{await blocker.query('rollback').catch(()=>{});blocker.release();}
    assert.equal((await finalizeArchive(app,key,archiveId)).removed,3,
      'two old generations containing the same source key count that memory once');
    assert.deepEqual((await owner.query(`select
      count(*) filter(where source_key like $2 and source_key<$5 and deleted_at is not null and access_level='sensitive')::int protected_tombstones,
      count(*) filter(where source_key like $2 and source_key<$5 and deleted_at is null and access_level='secret')::int protected_promotions,
      count(*) filter(where source_key like $2 and source_key<$5 and deleted_at is not null and access_level='secret')::int bad_promotions,
      count(*) filter(where source_key=any($3::text[]) and deleted_at is not null)::int pruned,
      count(*) filter(where source_key=any($4::text[]) and deleted_at is null)::int current_active
      from memories where client_id=$1 and source='my-life'`,[key,`${prefix}a:0000%`,[earlyOnly,shared,lateOnly],[currentOnly,overlap],earlyOnly])).rows[0],
      {protected_tombstones:250,protected_promotions:250,bad_promotions:0,pruned:3,current_active:2});
    assert.deepEqual((await owner.query(`select count(*)::int n,count(distinct membership_id)::int generations
      from archive_sync_snapshot_memberships where sync_key_id=$1 and archive_id=$2`,[key,archiveId])).rows[0],
      {n:2,generations:1});
  }finally{await app?.end();await owner.end();}
});
