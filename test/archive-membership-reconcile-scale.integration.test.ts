import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {readFile,readdir} from 'node:fs/promises';
import {archivePrefix} from '../src/archive/sync-format.js';
import {finalizeArchive} from '../src/archive/sync-store.js';
import {fixtureManifest,fixtureStream} from './archive-sync.test.js';

test('finalization reconciles 1.3 million synthetic memberships under RLS and resumes at a generation boundary',{
  skip:!process.env.ARCHIVE_SYNC_SCALE_TEST_DATABASE_URL,timeout:1_200_000,
},async t=>{
  const url=process.env.ARCHIVE_SYNC_SCALE_TEST_DATABASE_URL!;
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
    const archiveId='synthetic-scale-archive',prefix=archivePrefix(archiveId);
    const manifest={...fixtureManifest(),archive_id:archiveId};
    let complete:Record<string,unknown>|undefined;
    for await(const part of fixtureStream(manifest,[]))complete=JSON.parse(String(part).trim().split('\n').at(-1)!);
    complete!.chunks=600000;complete!.records=600000;
    const pending={manifest,complete,removed:0,cursor:null,membership_id:current};
    await owner.query(`insert into api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      values($1::uuid,$1::text,'scale-sync',array['my-life'],array['read','write','import'],'sensitive')`,[key]);
    await owner.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,memory_kind,valid_from,decay_rate)
      values('Synthetic state','my-life:sync-state','my-life',array['my-life'],$1,'sensitive',$2,$3,'synced',now(),0)`,
      [JSON.stringify({started_manifest:manifest,copy_in_progress:true,membership_id:current,pending_finalization:pending}),key,`mylife:state:${archiveId}`]);
    const stale=`${prefix}stale:0`,protectedKey=`${prefix}protected:0`;
    for(const [sourceKey,deleted] of [[stale,false],[protectedKey,true]] as const){
      await owner.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,memory_kind,
        valid_from,decay_rate,deleted_at) values('Synthetic row','my-life','my-life',array['my-life'],
        jsonb_build_object('my_life',jsonb_build_object('archive_id',$3::text)),'sensitive',$1,$2,'synced',now(),0,
        case when $4::boolean then now() else null end)`,[key,sourceKey,archiveId,deleted]);
    }
    const seeded=performance.now();
    for(const [generation,count] of [[early,600000],[current,600000],[late,100000]] as const){
      await owner.query(`insert into archive_sync_snapshot_memberships(sync_key_id,archive_id,membership_id,source_key)
        select $1::uuid,$2,$3::uuid,$4||lpad(g::text,7,'0') from generate_series(1,$5::int) g`,
        [key,archiveId,generation,prefix,count]);
    }
    await owner.query(`insert into archive_sync_snapshot_memberships(sync_key_id,archive_id,membership_id,source_key)
      values($1,$2,$3,$4),($1,$2,$3,$5)`,[key,archiveId,early,stale,protectedKey]);
    await owner.query('analyze archive_sync_snapshot_memberships');
    const seedMs=Math.round(performance.now()-seeded);
    const appUrl=new URL(url);appUrl.username='total_recall_app';appUrl.password='';
    app=new pg.Pool({connectionString:appUrl.toString(),max:2});
    const blocker=await owner.connect();
    try{
      await blocker.query('begin');
      await blocker.query(`select source_key from archive_sync_snapshot_memberships
        where sync_key_id=$1 and archive_id=$2 and membership_id=$3 and source_key=$4 for update`,
        [key,archiveId,early,`${prefix}0000001`]);
      await assert.rejects(finalizeArchive(app,key,archiveId),error=>
        typeof error==='object'&&error!==null&&'code' in error&&error.code==='55P03',
      'a locked delete aborts the entire reconciliation transaction');
      const failed=(await owner.query(`select metadata->'pending_finalization' pending from memories
        where client_id=$1 and source_key=$2`,[key,`mylife:state:${archiveId}`])).rows[0].pending;
      assert.equal(failed.reconcile_source_key,undefined,'failed transaction cannot advance the cursor');
      assert.equal((await owner.query(`select count(*)::int n from archive_sync_snapshot_memberships
        where sync_key_id=$1 and archive_id=$2 and membership_id=$3`,[key,archiveId,early])).rows[0].n,600002,
      'failed transaction cannot partially delete an old generation');
    }finally{await blocker.query('rollback').catch(()=>{});blocker.release();}
    let progress=0;
    await assert.rejects(finalizeArchive(app,key,archiveId,value=>{
      if(value.event==='archive_sync.membership_reconcile_progress'&&++progress===1)
        throw new Error('synthetic_reconciliation_interruption');
    }),/synthetic_reconciliation_interruption/);
    const interrupted=(await owner.query(`select metadata->'pending_finalization' pending from memories
      where client_id=$1 and source_key=$2`,[key,`mylife:state:${archiveId}`])).rows[0].pending;
    assert.equal(interrupted.reconcile_generation,early);
    assert.ok(interrupted.reconcile_source_key,'cursor committed with the first bounded deletion');
    assert.equal(interrupted.reconciliation_complete,undefined);
    const started=performance.now();
    const result=await finalizeArchive(app,key,archiveId);
    const finalizationMs=Math.round(performance.now()-started);
    assert.equal(result.removed,1,'stale row pruned, manual tombstone preserved');
    assert.equal((await owner.query(`select count(*)::int n from archive_sync_snapshot_memberships
      where sync_key_id=$1 and archive_id=$2`,[key,archiveId])).rows[0].n,600000);
    assert.equal((await owner.query(`select count(distinct membership_id)::int n from archive_sync_snapshot_memberships
      where sync_key_id=$1 and archive_id=$2`,[key,archiveId])).rows[0].n,1);
    assert.equal((await owner.query(`select deleted_at is not null deleted from memories where client_id=$1 and source_key=$2`,
      [key,stale])).rows[0].deleted,true);
    assert.equal((await finalizeArchive(app,key,archiveId)).removed,1,'committed finalization is idempotent');
    t.diagnostic(`archive_membership_reconcile_scale rows=1300002 seed_ms=${seedMs} resume_finalization_ms=${finalizationMs}`);
  }finally{await app?.end();await owner.end();}
});
