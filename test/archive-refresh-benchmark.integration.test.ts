import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {provisionArchiveSync} from '../src/archive/sync-admin.js';
import {receiveArchive} from '../src/archive/sync-store.js';
import {ACTIVE_EMBEDDING_PROFILE} from '../src/embedding.js';
import {fixtureManifest,fixtureRecord,fixtureStream} from './archive-sync.test.js';

test('large unchanged refresh preserves memory tuples and search index size',{
  skip:!process.env.ARCHIVE_SYNC_TEST_DATABASE_URL,timeout:240000,
},async t=>{
  const url=process.env.ARCHIVE_SYNC_TEST_DATABASE_URL!;
  assert.equal(new URL(url).pathname,'/total_recall_sync_test','disposable test database required');
  const owner=new pg.Pool({connectionString:url});let app:pg.Pool|undefined;
  try{
    await owner.query('drop schema public cascade; create schema public; create extension vector');
    await owner.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='total_recall_app')
      then create role total_recall_app login; end if; end $$`);
    const setupStarted=performance.now();
    for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort())
      await owner.query(await readFile('migrations/'+name,'utf8'));
    const appUrl=new URL(url);appUrl.username='total_recall_app';appUrl.password='';
    app=new pg.Pool({connectionString:appUrl.toString(),max:2});
    const home=randomUUID();
    await owner.query(`insert into api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      values($1::uuid,$1::text,'benchmark-home',array['personal'],array['read','write'],'secret')`,[home]);
    const key=(await provisionArchiveSync(app,'benchmark-archive',[home])).sync_key_id;
    const chunks=10000;
    const records=Array.from({length:chunks},(_,i)=>fixtureRecord(`benchmark-${i}`,`Synthetic benchmark ${i}`));
    const first=fixtureManifest('2026-02-01T00:00:00.000Z');
    first.archive_id='benchmark-archive';
    await receiveArchive(app,fixtureStream(first,records),key,first.archive_id);
    const firstCopyFinished=performance.now();
    const vector=`[1,${Array(767).fill(0).join(',')}]`;
    await owner.query(`update memories set embedding=$1::vector,embedding_provider=$2,embedding_model=$3,embedding_dimensions=$4
      where source='my-life' and namespace='my-life'`,[vector,ACTIVE_EMBEDDING_PROFILE.provider,
      ACTIVE_EMBEDDING_PROFILE.model,ACTIVE_EMBEDDING_PROFILE.dimensions]);
    const embeddingFinished=performance.now();
    const fingerprint=async()=>(await owner.query(`select md5(string_agg(id::text||ctid::text||revision::text||
      updated_at::text||md5(embedding::text),'' order by id)) fingerprint from memories
      where source='my-life' and namespace='my-life'`)).rows[0].fingerprint as string;
    const beforeFingerprint=await fingerprint();
    const beforeIndex=Number((await owner.query("select pg_relation_size('memories_embedding_idx') bytes")).rows[0].bytes);
    await owner.query("select pg_stat_reset_single_table_counters('memories'::regclass)");
    const second=fixtureManifest('2026-02-02T00:00:00.000Z');second.archive_id='benchmark-archive';
    const started=performance.now();
    const result=await receiveArchive(app,fixtureStream(second,records),key,second.archive_id);
    const elapsedMs=Math.round(performance.now()-started);
    await owner.query('select pg_stat_force_next_flush()');
    const updates=Number((await owner.query("select n_tup_upd from pg_stat_user_tables where relname='memories'")).rows[0].n_tup_upd);
    const afterIndex=Number((await owner.query("select pg_relation_size('memories_embedding_idx') bytes")).rows[0].bytes);
    assert.equal(result.written,chunks);assert.equal(result.protected,0);
    assert.equal(await fingerprint(),beforeFingerprint,'unchanged payload tuples, revisions, timestamps and vectors stay physical-identical');
    assert.ok(updates<=3,`only the sync-state row may update, observed ${updates}`);
    assert.equal(afterIndex,beforeIndex,'unchanged refresh does not grow the HNSW relation');
    assert.deepEqual((await owner.query(`select count(*)::int count,count(distinct membership_id)::int generations,
      bool_and(membership_id::text=(select metadata->>'membership_id' from memories where source='my-life:sync-state')) current
      from archive_sync_snapshot_memberships`)).rows[0],{count:chunks,generations:1,current:true});
    t.diagnostic(`archive_refresh_benchmark chunks=${chunks} setup_and_first_copy_ms=${Math.round(firstCopyFinished-setupStarted)}`+
      ` embedding_seed_ms=${Math.round(embeddingFinished-firstCopyFinished)} unchanged_refresh_ms=${elapsedMs}`+
      ` memory_updates=${updates} hnsw_bytes=${afterIndex}`);
  }finally{await app?.end();await owner.end();}
});
