import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {fixtureManifest} from './archive-sync.test.js';

test('migration 038 backfills 750000 synthetic managed rows within the bounded operator timeout',{
  skip:!process.env.ARCHIVE_SYNC_SCALE_TEST_DATABASE_URL,timeout:1_200_000,
},async t=>{
  const url=process.env.ARCHIVE_SYNC_SCALE_TEST_DATABASE_URL!;
  assert.equal(new URL(url).pathname,'/total_recall_sync_test','disposable test database required');
  const owner=new pg.Pool({connectionString:url,max:1});
  try{
    await owner.query('drop schema public cascade; create schema public; create extension vector');
    await owner.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='total_recall_app')
      then create role total_recall_app login; end if; end $$`);
    for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql')&&name<'038_').sort())
      await owner.query(await readFile('migrations/'+name,'utf8'));
    const key=randomUUID(),archiveId='synthetic-scale-archive',count=750000;
    const manifest={...fixtureManifest(),archive_id:archiveId};
    await owner.query(`insert into api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      values($1::uuid,$1::text,'scale-sync',array['my-life'],array['read','write','import'],'sensitive')`,[key]);
    await owner.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,memory_kind,valid_from,decay_rate)
      values('Synthetic state','my-life:sync-state','my-life',array['my-life'],$1,'sensitive',$2,$3,'synced',now(),0)`,
      [JSON.stringify({started_manifest:manifest,copy_in_progress:true}),key,`mylife:state:${archiveId}`]);
    const seedStarted=performance.now();
    await owner.query("set session_replication_role='replica'");
    try{
      await owner.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,memory_kind,valid_from,decay_rate)
        select 'Synthetic scale row','my-life','my-life',array['my-life','historical'],
          jsonb_build_object('my_life',jsonb_build_object('archive_id',$2::text)),
          'sensitive',$1::text,'mylife:v1:synthetic:'||lpad(g::text,7,'0'),'synced',now(),0
        from generate_series(1,$3::int) g`,[key,archiveId,count]);
    }finally{await owner.query("set session_replication_role='origin'");}
    const seedMs=Math.round(performance.now()-seedStarted);
    const oldTuple=(await owner.query(`select ctid::text tuple from memories where client_id=$1 and source_key=$2`,
      [key,'mylife:v1:synthetic:0000001'])).rows[0].tuple;
    const migrationStarted=performance.now();
    await owner.query("set lock_timeout='3s'; set statement_timeout='900s'");
    await owner.query(await readFile('migrations/038_archive_sync_snapshot_membership.sql','utf8'));
    const migrationMs=Math.round(performance.now()-migrationStarted);
    assert.ok(migrationMs<900_000,'backfill completes under the operator statement timeout');
    const linked=(await owner.query(`select metadata->>'membership_id' membership_id from memories
      where client_id=$1 and source_key=$2`,[key,`mylife:state:${archiveId}`])).rows[0].membership_id;
    assert.match(linked,/^[0-9a-f-]{36}$/i);
    assert.equal((await owner.query(`select count(*)::int count from archive_sync_snapshot_memberships
      where sync_key_id=$1 and archive_id=$2 and membership_id=$3`,[key,archiveId,linked])).rows[0].count,count);
    assert.equal((await owner.query(`select ctid::text tuple from memories where client_id=$1 and source_key=$2`,
      [key,'mylife:v1:synthetic:0000001'])).rows[0].tuple,oldTuple,'backfill does not rewrite archive tuples');
    t.diagnostic(`archive_membership_backfill_scale rows=${count} seed_ms=${seedMs} migration_ms=${migrationMs}`);
  }finally{await owner.end();}
});
