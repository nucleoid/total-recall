import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {readFile,readdir} from 'node:fs/promises';
import {archivePrefix} from '../src/archive/sync-format.js';
import {finalizeArchive} from '../src/archive/sync-store.js';
import {fixtureManifest,fixtureStream} from './archive-sync.test.js';

test('finalize resumes pruning 100000 disjoint old keys and preserves protected rows under RLS',{
  skip:!process.env.ARCHIVE_SYNC_SCALE_TEST_DATABASE_URL,timeout:3_600_000,
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
    const old='10000000-0000-4000-8000-000000000001';
    const current='20000000-0000-4000-8000-000000000002';
    const archiveId='synthetic-disjoint-archive',prefix=archivePrefix(archiveId);
    const manifest={...fixtureManifest(),archive_id:archiveId};
    let complete:Record<string,unknown>|undefined;
    for await(const part of fixtureStream(manifest,[]))complete=JSON.parse(String(part).trim().split('\n').at(-1)!);
    complete!.chunks=100000;complete!.records=100000;
    const pending={manifest,complete,removed:0,cursor:null,membership_id:current};
    await owner.query(`insert into api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      values($1::uuid,$1::text,'disjoint-sync',array['my-life'],array['read','write','import'],'sensitive')`,[key]);
    await owner.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,memory_kind,valid_from,decay_rate)
      values('Synthetic state','my-life:sync-state','my-life',array['my-life'],$1,'sensitive',$2,$3,'synced',now(),0)`,
      [JSON.stringify({started_manifest:manifest,copy_in_progress:true,membership_id:current,pending_finalization:pending}),key,`mylife:state:${archiveId}`]);
    const seeded=performance.now();
    const seedClient=await owner.connect();
    try{
      await seedClient.query("set session_replication_role='replica'");
      await seedClient.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,
        memory_kind,valid_from,decay_rate,deleted_at)
        select 'Synthetic disjoint row','my-life','my-life',array['my-life'],
          jsonb_build_object('my_life',jsonb_build_object('archive_id',$2::text)),
          case when g between 51 and 100 then 'secret' else 'sensitive' end,$1::text,
          $3||'old:'||lpad(g::text,7,'0'),'synced',now(),0,
          case when g<=50 then now() else null end
        from generate_series(1,100000) g`,[key,archiveId,prefix]);
      await seedClient.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,
        memory_kind,valid_from,decay_rate)
        select 'Synthetic current row','my-life','my-life',array['my-life'],
          jsonb_build_object('my_life',jsonb_build_object('archive_id',$2::text)),
          'sensitive',$1::text,$3||'current:'||lpad(g::text,7,'0'),'synced',now(),0
        from generate_series(1,100000) g`,[key,archiveId,prefix]);
      for(const [generation,label] of [[old,'old'],[current,'current']] as const)
        await seedClient.query(`insert into archive_sync_snapshot_memberships(sync_key_id,archive_id,membership_id,source_key)
          select $1::uuid,$2,$3::uuid,$4||$5||':'||lpad(g::text,7,'0') from generate_series(1,100000) g`,
          [key,archiveId,generation,prefix,label]);
    }finally{await seedClient.query("set session_replication_role='origin'").catch(()=>{});seedClient.release();}
    await owner.query('analyze memories');await owner.query('analyze archive_sync_snapshot_memberships');
    const seedMs=Math.round(performance.now()-seeded);
    const appUrl=new URL(url);appUrl.username='total_recall_app';appUrl.password='';
    app=new pg.Pool({connectionString:appUrl.toString(),max:2});
    let interrupted=false;
    await assert.rejects(finalizeArchive(app,key,archiveId,value=>{
      if(value.event==='archive_sync.prune_progress'&&!interrupted){interrupted=true;throw new Error('synthetic_prune_interruption');}
    }),/synthetic_prune_interruption/);
    assert.equal(interrupted,true);
    const state=(await owner.query(`select metadata->'pending_finalization' pending from memories
      where client_id=$1 and source_key=$2`,[key,`mylife:state:${archiveId}`])).rows[0].pending;
    assert.equal(state.reconciliation_complete,true,'disjoint keys survive reconciliation and reach prune');
    assert.equal(state.removed,400,'first 500 keys include 100 protected rows and cursor still commits');
    assert.ok(state.prune_source_key,'bounded source-key cursor commits with the first prune batch');
    const started=performance.now();
    const final=await finalizeArchive(app,key,archiveId);
    const resumeMs=Math.round(performance.now()-started);
    assert.equal(final.removed,99900,'only active eligible old rows are tombstoned');
    assert.equal((await finalizeArchive(app,key,archiveId)).removed,99900,'finalize is idempotent');
    assert.deepEqual((await owner.query(`select
      count(*) filter(where source_key like $2 and deleted_at is null and access_level='sensitive')::int active_old,
      count(*) filter(where source_key like $2 and deleted_at is not null and access_level='sensitive')::int tombstoned_old,
      count(*) filter(where source_key like $2 and access_level='secret' and deleted_at is null)::int promoted_old,
      count(*) filter(where source_key like $2 and access_level='secret' and deleted_at is not null)::int tombstoned_promoted,
      count(*) filter(where source_key like $3 and deleted_at is null)::int active_current
      from memories where client_id=$1 and source='my-life'`,[key,`${prefix}old:%`,`${prefix}current:%`])).rows[0],
      {active_old:0,tombstoned_old:99950,promoted_old:50,tombstoned_promoted:0,active_current:100000});
    assert.deepEqual((await owner.query(`select count(*)::int n,count(distinct membership_id)::int generations
      from archive_sync_snapshot_memberships where sync_key_id=$1 and archive_id=$2`,[key,archiveId])).rows[0],
      {n:100000,generations:1});
    const terminal=(await owner.query(`select metadata from memories where client_id=$1 and source_key=$2`,
      [key,`mylife:state:${archiveId}`])).rows[0].metadata;
    assert.equal(terminal.copy_in_progress,false);
    assert.equal(terminal.pending_finalization,undefined);
    t.diagnostic(`archive_membership_disjoint_scale old=100000 current=100000 protected=100 seed_ms=${seedMs} resume_prune_ms=${resumeMs}`);
  }finally{await app?.end();await owner.end();}
});
