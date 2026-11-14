import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {receiveArchive} from '../src/archive/sync-store.js';
import {archivePrefix} from '../src/archive/sync-format.js';
import {fixtureManifest,fixtureStream} from './archive-sync.test.js';

test('migration 038 safely links a baseline for completed and first-copy states',{
  skip:!process.env.ARCHIVE_SYNC_TEST_DATABASE_URL,timeout:60000,
},async()=>{
  const url=process.env.ARCHIVE_SYNC_TEST_DATABASE_URL!;
  assert.equal(new URL(url).pathname,'/total_recall_sync_test','disposable test database required');
  const owner=new pg.Pool({connectionString:url});let app:pg.Pool|undefined;
  try{
    await owner.query('drop schema public cascade; create schema public; create extension vector');
    await owner.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='total_recall_app')
      then create role total_recall_app login; end if; end $$`);
    const migrations=(await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort();
    for(const name of migrations.filter(name=>name<'038_'))await owner.query(await readFile('migrations/'+name,'utf8'));
    const key=randomUUID(),revokedKey=randomUUID(),manifest=fixtureManifest();
    await owner.query(`insert into api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      values($1::uuid,$1::text,'migration-sync',array['my-life'],array['read','write','import'],'sensitive')`,[key]);
    await owner.query(`insert into api_keys(id,key_hash,name,namespaces,permissions,max_access_level,revoked_at)
      values($1::uuid,$1::text,'revoked-sync',array['my-life'],array['read','write','import'],'sensitive',now())`,[revokedKey]);
    await owner.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,memory_kind,valid_from,decay_rate)
      values('Synthetic state','my-life:sync-state','my-life',array['my-life'],$1,'sensitive',$2,'mylife:state:synthetic-archive','synced',now(),0),
        ('Synthetic sensitive','my-life','my-life',array['my-life'],$3,'sensitive',$2,'mylife:v1:synthetic:a','synced',now(),0),
        ('Synthetic promoted','my-life','my-life',array['my-life'],$3,'normal',$2,'mylife:v1:synthetic:b','synced',now(),0),
        ('Malformed unrelated state','my-life:sync-state','my-life',array['my-life'],$1,'sensitive','not-a-key','mylife:state:malformed','synced',now(),0)`,
      [JSON.stringify({started_manifest:manifest,copy_in_progress:true}),key,
        JSON.stringify({my_life:{archive_id:manifest.archive_id,record_id:'synthetic'}})]);
    await owner.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,memory_kind,valid_from,decay_rate)
      values('Revoked state','my-life:sync-state','my-life',array['my-life'],$1,'sensitive',$2,'mylife:state:revoked-archive','synced',now(),0)`,
      [JSON.stringify({started_manifest:{...manifest,archive_id:'revoked-archive'},copy_in_progress:true}),revokedKey]);
    const revokedOldKey=archivePrefix('revoked-archive')+'synthetic-old:0';
    await owner.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,memory_kind,valid_from,decay_rate)
      values('Old partial synthetic row','my-life','my-life',array['my-life'],
        $1,'sensitive',$2,$3,'synced',now(),0)`,
      [JSON.stringify({my_life:{archive_id:'revoked-archive',snapshot_id:manifest.snapshot_id}}),revokedKey,revokedOldKey]);
    await owner.query(await readFile('migrations/038_archive_sync_snapshot_membership.sql','utf8'));
    const state=(await owner.query(`select metadata->>'membership_id' membership_id from memories
      where client_id=$1 and source='my-life:sync-state'`,[key])).rows[0];
    assert.match(state.membership_id,/^[0-9a-f-]{36}$/i);
    const appUrl=new URL(url);appUrl.username='total_recall_app';appUrl.password='';
    const stale=new pg.Client({connectionString:appUrl.toString()});
    await stale.connect();try{
      await stale.query('begin');
      await stale.query("select set_config('app.allowed_namespaces',$1,true)",[JSON.stringify(['my-life'])]);
      await stale.query("select set_config('app.current_key_id',$1,true)",[key]);
      await assert.rejects(stale.query(`update memories set metadata=metadata||$3::jsonb
        where client_id=$1 and source_key=$2`,[key,'mylife:state:synthetic-archive',
        JSON.stringify({started_manifest:manifest,copy_in_progress:true})]),/membership_schema_mismatch/,
        'a stale receiver cannot restart migration-seeded copy_in_progress state');
    }finally{await stale.query('rollback');await stale.end();}
    assert.deepEqual((await owner.query(`select count(*)::int count,count(*) filter(where membership_id::text=$1)::int linked,
      count(*) filter(where source_key like 'mylife:v1:synthetic:%')::int managed
      from archive_sync_snapshot_memberships where sync_key_id=$2`,[state.membership_id,key])).rows[0],{count:2,linked:2,managed:2});
    assert.equal((await owner.query(`select metadata ? 'membership_id' linked from memories
      where client_id='not-a-key' and source='my-life:sync-state'`)).rows[0].linked,false,
      'malformed/unowned state is ignored without unsafe casts');
    const revokedState=(await owner.query(`select metadata->>'membership_id' membership_id from memories where client_id=$1
      and source='my-life:sync-state'`,[revokedKey])).rows[0];
    assert.match(revokedState.membership_id,/^[0-9a-f-]{36}$/i,
      'inactive exact-shaped identity retains its generation for future recovery');
    assert.equal((await owner.query(`select count(*)::int count from archive_sync_snapshot_memberships where sync_key_id=$1
      and membership_id=$2`,[revokedKey,revokedState.membership_id])).rows[0].count,1);
    app=new pg.Pool({connectionString:appUrl.toString(),max:2});
    const denied=await app.connect();try{
      await denied.query('begin');
      await denied.query("select set_config('app.allowed_namespaces',$1,true)",[JSON.stringify(['my-life'])]);
      await denied.query("select set_config('app.current_key_id',$1,true)",[revokedKey]);
      assert.equal((await denied.query('select count(*)::int count from archive_sync_snapshot_memberships')).rows[0].count,0,
        'revoked identity cannot see its retained baseline through RLS');
    }finally{await denied.query('rollback');denied.release();}
    await owner.query('update api_keys set revoked_at=null where id=$1',[revokedKey]);
    const oldReceiver=await app.connect();try{
      await oldReceiver.query('begin');
      await oldReceiver.query("select set_config('app.allowed_namespaces',$1,true)",[JSON.stringify(['my-life'])]);
      await oldReceiver.query("select set_config('app.current_key_id',$1,true)",[revokedKey]);
      await assert.rejects(oldReceiver.query(`update memories set metadata=metadata||$3::jsonb
        where client_id=$1 and source_key=$2`,[revokedKey,'mylife:state:revoked-archive',
        JSON.stringify({started_manifest:{...manifest,archive_id:'revoked-archive'},copy_in_progress:true})]),
        /membership_schema_mismatch/,'reactivated identity cannot run an old receiver');
    }finally{await oldReceiver.query('rollback');oldReceiver.release();}
    const next={...fixtureManifest('2026-01-02T00:00:00.000Z'),archive_id:'revoked-archive'};
    const refreshed=await receiveArchive(app,fixtureStream(next,[]),revokedKey,next.archive_id);
    assert.equal(refreshed.removed,1,'verified new empty snapshot reconciles absent preexisting partial row');
    assert.equal((await owner.query('select deleted_at is not null removed from memories where source_key=$1',[revokedOldKey])).rows[0].removed,true);
    assert.equal((await owner.query(`select count(*)::int count from archive_sync_snapshot_memberships where sync_key_id=$1`,
      [revokedKey])).rows[0].count,0,'old generation is cleaned after successful reconciliation');
  }finally{await app?.end();await owner.end();}
});
