import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {provisionArchiveSync} from '../src/archive/sync-admin.js';
import {archiveSyncStatus,receiveArchive,embedArchiveBatch} from '../src/archive/sync-store.js';
import {ACTIVE_EMBEDDING_PROFILE} from '../src/embedding.js';
import {authContextFromRow} from '../src/auth.js';
import {memoryRecall} from '../src/tools/recall.js';
import {memoryList} from '../src/tools/list.js';
import {setPoolForTesting} from '../src/db.js';
import {fixtureManifest,fixtureRecord,fixtureStream} from './archive-sync.test.js';

test('real RLS: private copy, retries, tombstones, stale streams and detached embedding',{
  skip:!process.env.ARCHIVE_SYNC_TEST_DATABASE_URL,timeout:120000,
},async()=>{
  const url=process.env.ARCHIVE_SYNC_TEST_DATABASE_URL!;
  assert.equal(new URL(url).pathname,'/total_recall_sync_test','disposable test database required');
  const owner=new pg.Pool({connectionString:url});
  let app:pg.Pool|undefined;
  try{
    await owner.query('drop schema public cascade; create schema public; create extension vector');
    await owner.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='total_recall_app') then create role total_recall_app login; end if; end $$`);
    for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort())await owner.query(await readFile('migrations/'+name,'utf8'));
    const appUrl=new URL(url);appUrl.username='total_recall_app';appUrl.password='';
    app=new pg.Pool({connectionString:appUrl.toString(),max:4});setPoolForTesting(app);
    const home=randomUUID(),work=randomUUID();
    await owner.query(`insert into api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      values($1::uuid,$1::text,'home',array['personal'],array['read','write'],'secret'),
        ($2::uuid,$2::text,'work',array['work'],array['read','write'],'secret')`,[home,work]);
    await assert.rejects(provisionArchiveSync(owner,'synthetic-archive',[home]),/unsafe_database_role/);
    await assert.rejects(provisionArchiveSync(app,'synthetic-archive',[work]),/reader_not_personal/);
    const provisioned=await provisionArchiveSync(app,'synthetic-archive',[home]);const key=provisioned.sync_key_id;
    assert.equal((await provisionArchiveSync(app,'synthetic-archive',[home])).sync_key_id,key);
    assert.deepEqual((await owner.query('select namespaces from api_keys where id=$1',[work])).rows[0].namespaces,['work']);
    const homeAuth=authContextFromRow((await owner.query('select * from api_keys where id=$1',[home])).rows[0])!;
    const workAuth=authContextFromRow((await owner.query('select * from api_keys where id=$1',[work])).rows[0])!;
    const a=fixtureRecord('one'),b=fixtureRecord('two','Calendar planning discussed a synthetic project');
    const m1=fixtureManifest();await receiveArchive(app,fixtureStream(m1,[a,b]),key,m1.archive_id);
    const list=await memoryList({namespace:'my-life',source:'my-life',limit:100,offset:0},homeAuth);
    assert.equal(list.total,2);const id=list.memories.find(row=>row.content===a.content)!.id;
    assert.equal((await memoryRecall({id},homeAuth)).content,a.content);
    await assert.rejects(memoryRecall({id},workAuth),/access denied/);
    await assert.rejects(memoryRecall({id},{...homeAuth,maxAccessLevel:'normal'}),/access denied/);
    assert.equal((await memoryList({namespace:'my-life',limit:100,offset:0},workAuth)).total,0);
    assert.equal((await archiveSyncStatus(app,key,m1.archive_id)).pending,2);
    const embed=async(texts:string[])=>texts.map(()=>({...ACTIVE_EMBEDDING_PROFILE,vector:Array.from({length:768},(_,i)=>i===0?1:0)}));
    await assert.rejects(embedArchiveBatch(app,key,m1.archive_id,64,async texts=>(await embed(texts)).map(r=>({...r,model:'wrong'}))),/embedding_profile/);
    assert.equal((await archiveSyncStatus(app,key,m1.archive_id)).pending,2);
    assert.equal((await embedArchiveBatch(app,key,m1.archive_id,64,embed)).written,2);
    const m2=fixtureManifest('2026-01-02T00:00:00.000Z');await receiveArchive(app,fixtureStream(m2,[a,b]),key,m2.archive_id);
    assert.equal((await archiveSyncStatus(app,key,m2.archive_id)).pending,0,'unchanged data keeps vectors');
    await assert.rejects(receiveArchive(app,fixtureStream(m1,[a]),key,m1.archive_id),/stale_snapshot/);
    const m3=fixtureManifest('2026-01-03T00:00:00.000Z'),changed=fixtureRecord('one','Changed parsed text');
    await receiveArchive(app,fixtureStream(m3,[changed,b]),key,m3.archive_id);
    assert.equal((await archiveSyncStatus(app,key,m3.archive_id)).pending,1);
    const stale=await embedArchiveBatch(app,key,m3.archive_id,64,async texts=>{
      await owner.query('update memories set content=$2 where id=$1',[id,'Manual edit during embedding']);return embed(texts);
    });assert.equal(stale.written,0,'concurrent edits cannot receive a stale vector');
    await owner.query('update memories set deleted_at=now() where id=$1',[id]);
    const m4=fixtureManifest('2026-01-04T00:00:00.000Z');
    const retry=await receiveArchive(app,fixtureStream(m4,[changed,b]),key,m4.archive_id);assert.equal(retry.protected,1,'manual deletion never resurrects');
    const many=Array.from({length:500},(_,i)=>fixtureRecord('partial-'+i,'Synthetic '+i));
    const broken=fixtureManifest('2026-01-05T00:00:00.000Z');
    await assert.rejects(receiveArchive(app,fixtureStream(broken,many,c=>c.sha256='0'.repeat(64)),key,broken.archive_id),/incomplete_snapshot/);
    assert.equal((await owner.query("select count(*)::int n from memories where source='my-life' and deleted_at is null")).rows[0].n,501,'partial writes do not prune old records');
    await assert.rejects(receiveArchive(app,fixtureStream(m4,[b]),key,m4.archive_id),/stale_snapshot/,'an interrupted newer snapshot also prevents rollback');
    const m6=fixtureManifest('2026-01-06T00:00:00.000Z');
    const done=await receiveArchive(app,fixtureStream(m6,[b]),key,m6.archive_id);assert.equal(done.removed,500);
    const m7=fixtureManifest('2026-01-07T00:00:00.000Z');await receiveArchive(app,fixtureStream(m7,[b,many[0]]),key,m7.archive_id);
    assert.equal((await archiveSyncStatus(app,key,m7.archive_id)).chunks,2,'sync removals can return on the next completed snapshot');
    const lock=await app.connect();try{
      await lock.query('select pg_advisory_lock(hashtextextended($1,0))',[`my-life-sync:${key}:${m7.archive_id}`]);
      await assert.rejects(receiveArchive(app,fixtureStream(m7,[b]),key,m7.archive_id),/already_running/);
    }finally{await lock.query('select pg_advisory_unlock_all()');lock.release();}
    const m8=fixtureManifest('2026-01-08T00:00:00.000Z');
    await assert.rejects(receiveArchive(app,fixtureStream(m8,[],c=>delete c.coverage.photo_media),key,m8.archive_id));
    assert.equal((await archiveSyncStatus(app,key,m8.archive_id)).chunks,2,'incomplete coverage must not erase a source');
    const empty=await receiveArchive(app,fixtureStream(m8,[]),key,m8.archive_id);
    assert.equal(empty.removed,2,'a verified empty snapshot propagates removal of every source');
    await owner.query('update api_keys set revoked_at=now() where id=$1',[key]);
    await assert.rejects(embedArchiveBatch(app,key,m7.archive_id,64,embed),/identity_denied/);
    assert.equal((await owner.query("select count(*)::int n from memories where namespace='my-life' and access_level<>'sensitive'")).rows[0].n,0);
  }finally{setPoolForTesting(null);await app?.end();await owner.end();}
});
