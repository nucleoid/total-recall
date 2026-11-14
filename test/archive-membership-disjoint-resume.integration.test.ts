import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {finalizeArchive} from '../src/archive/sync-store.js';
import {archivePrefix,digest,REQUIRED_EXCLUSIONS,SYNC_FORMAT,type SyncManifest,type SyncComplete} from '../src/archive/sync-format.js';

test('e886 membership-aware finalization ignores its stale UUID cursor and resumes from remaining old memberships',{
  skip:!process.env.ARCHIVE_SYNC_SCALE_TEST_DATABASE_URL,timeout:60000,
},async t=>{
  const url=process.env.ARCHIVE_SYNC_SCALE_TEST_DATABASE_URL!;
  assert.equal(new URL(url).pathname,'/total_recall_sync_test','disposable test database required');
  const owner=new pg.Pool({connectionString:url,max:2});let app:pg.Pool|undefined;
  const key='11111111-1111-4111-8111-111111111111';
  const old='10000000-0000-4000-8000-000000000001';
  const current='20000000-0000-4000-8000-000000000002';
  const archiveId='synthetic-legacy-cursor',prefix=archivePrefix(archiveId);
  const stateKey=`mylife:state:${archiveId}`;
  const priorCursor='00000000-0000-4000-8000-0000000001f4'; // row 500
  try{
    await owner.query('drop schema public cascade; create schema public; create extension vector');
    await owner.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='total_recall_app')
      then create role total_recall_app login; end if; end $$`);
    for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort())
      await owner.query(await readFile('migrations/'+name,'utf8'));
    const manifest:SyncManifest={type:'manifest',format:SYNC_FORMAT,archive_id:archiveId,
      snapshot_id:randomUUID(),as_of:'2026-01-01T00:00:00.000Z',scope:'published_parsed_archive',raw_exports_included:false};
    // This test starts after the verified trailer was persisted. It exercises
    // membership finalization, not stream hashing or receiver coverage checks.
    const complete:SyncComplete={type:'complete',records:10,chunks:10,sha256:digest('synthetic-verified-trailer'),
      coverage:{evidence:{status:'exported',records:10},calendar_occurrence:{status:'exported',records:0},
        photo_media:{status:'exported',records:0},photo_sidecar:{status:'exported',records:0},
        timeline_event:{status:'exported',records:0},structured_record:{status:'not_installed',records:0}},
      exclusions:[...REQUIRED_EXCLUSIONS]};
    // e886 persisted a UUID cursor after one committed 500-row prune. The new
    // finalizer intentionally ignores it and uses remaining old memberships.
    const pending={manifest,complete,removed:500,cursor:priorCursor,membership_id:current,reconciliation_complete:true};
    await owner.query(`insert into api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      values($1::uuid,$1::text,'legacy-cursor-sync',array['my-life'],array['read','write','import'],'sensitive')`,[key]);
    await owner.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,memory_kind,valid_from,decay_rate)
      values('Synthetic state','my-life:sync-state','my-life',array['my-life'],$1,'sensitive',$2,$3,'synced',now(),0)`,
      [JSON.stringify({started_manifest:manifest,copy_in_progress:true,membership_id:current,pending_finalization:pending}),key,stateKey]);
    const seed=await owner.connect();
    try{
      await seed.query("set session_replication_role='replica'");
      await seed.query(`insert into memories(id,content,source,namespace,tags,metadata,access_level,client_id,source_key,
        memory_kind,valid_from,decay_rate,deleted_at)
        select ('00000000-0000-4000-8000-'||lpad(to_hex(g),12,'0'))::uuid,
          'Synthetic old row','my-life','my-life',array['my-life'],
          jsonb_build_object('my_life',jsonb_build_object('archive_id',$2::text)),
          case when g>545 then 'secret' else 'sensitive' end,$1::text,
          $3||'old:'||lpad(g::text,7,'0'),'synced',now(),0,
          case when g<=500 then now() else null end
        from generate_series(1,550) g`,[key,archiveId,prefix]);
      await seed.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,
        memory_kind,valid_from,decay_rate)
        select 'Synthetic current row','my-life','my-life',array['my-life'],
          jsonb_build_object('my_life',jsonb_build_object('archive_id',$2::text)),
          'sensitive',$1::text,$3||'current:'||lpad(g::text,7,'0'),'synced',now(),0
        from generate_series(1,10) g`,[key,archiveId,prefix]);
      for(const [generation,label,first,last] of [[old,'old',501,550],[current,'current',1,10]] as const)
        await seed.query(`insert into archive_sync_snapshot_memberships(sync_key_id,archive_id,membership_id,source_key)
          select $1::uuid,$2,$3::uuid,$4||$5||':'||lpad(g::text,7,'0') from generate_series($6::int,$7::int) g`,
          [key,archiveId,generation,prefix,label,first,last]);
    }finally{seed.release(true);}
    await owner.query('analyze memories');await owner.query('analyze archive_sync_snapshot_memberships');
    const before=(await owner.query(`select metadata->'pending_finalization' pending from memories
      where client_id=$1 and source_key=$2`,[key,stateKey])).rows[0].pending;
    assert.equal(before.cursor,priorCursor);
    assert.equal(before.removed,500);
    assert.equal(before.prune_generation,undefined);
    assert.equal(before.prune_source_key,undefined);
    const appUrl=new URL(url);appUrl.username='total_recall_app';appUrl.password='';
    app=new pg.Pool({connectionString:appUrl.toString(),max:2});
    const started=performance.now();
    assert.equal((await finalizeArchive(app,key,archiveId)).removed,545);
    const resumeMs=Math.round(performance.now()-started);
    assert.equal((await finalizeArchive(app,key,archiveId)).removed,545,'terminal retry is idempotent');
    assert.deepEqual((await owner.query(`select
      count(*) filter(where source_key like $2 and deleted_at is null and access_level='sensitive')::int active_old,
      count(*) filter(where source_key like $2 and deleted_at is not null and access_level='sensitive')::int tombstoned_old,
      count(*) filter(where source_key like $2 and access_level='secret' and deleted_at is null)::int promoted_old,
      count(*) filter(where source_key like $2 and access_level='secret' and deleted_at is not null)::int tombstoned_promoted,
      count(*) filter(where source_key like $3 and deleted_at is null)::int active_current
      from memories where client_id=$1 and source='my-life'`,[key,`${prefix}old:%`,`${prefix}current:%`])).rows[0],
      {active_old:0,tombstoned_old:545,promoted_old:5,tombstoned_promoted:0,active_current:10});
    assert.deepEqual((await owner.query(`select count(*)::int n,count(distinct membership_id)::int generations
      from archive_sync_snapshot_memberships where sync_key_id=$1 and archive_id=$2`,[key,archiveId])).rows[0],
      {n:10,generations:1});
    const final=(await owner.query(`select metadata from memories where client_id=$1 and source_key=$2`,[key,stateKey])).rows[0].metadata;
    assert.equal(final.copy_in_progress,false);
    assert.equal(final.pending_finalization,undefined);
    t.diagnostic(`archive_membership_legacy_cursor_resume from_removed=500 final_removed=545 resume_ms=${resumeMs}`);
  }finally{await app?.end();await owner.end();}
});
