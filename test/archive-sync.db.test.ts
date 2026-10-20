import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {provisionArchiveSync} from '../src/archive/sync-admin.js';
import {archiveSyncStatus,receiveArchive,embedArchiveBatch,finalizeArchive,retryArchiveFailures} from '../src/archive/sync-store.js';
import {runEmbeddingWorker} from '../src/archive/sync-cli.js';
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
    const staleFirstReceive=await app.connect();try{
      await staleFirstReceive.query('begin');
      await staleFirstReceive.query("select set_config('app.allowed_namespaces',$1,true)",[JSON.stringify(['my-life'])]);
      await staleFirstReceive.query("select set_config('app.current_key_id',$1,true)",[key]);
      await assert.rejects(staleFirstReceive.query(`insert into memories(content,source,namespace,tags,metadata,access_level,
        client_id,source_key,memory_kind,valid_from,decay_rate) values('Synthetic state','my-life:sync-state',
        'my-life',array['my-life','sync-status'],$1,'sensitive',$2,$3,'synced',statement_timestamp(),0)`,
        [JSON.stringify({started_manifest:fixtureManifest(),copy_in_progress:true}),key,'mylife:state:synthetic-archive']),
        /membership_schema_mismatch/,'old receiver cannot create a first sync state without membership generation');
    }finally{await staleFirstReceive.query('rollback');staleFirstReceive.release();}
    assert.deepEqual((await owner.query('select namespaces from api_keys where id=$1',[work])).rows[0].namespaces,['work']);
    const homeAuth=authContextFromRow((await owner.query('select * from api_keys where id=$1',[home])).rows[0])!;
    const workAuth=authContextFromRow((await owner.query('select * from api_keys where id=$1',[work])).rows[0])!;
    const a=fixtureRecord('one'),b=fixtureRecord('two','Calendar planning discussed a synthetic project');
    const m1=fixtureManifest();await receiveArchive(app,fixtureStream(m1,[a,b]),key,m1.archive_id);
    const list=await memoryList({namespace:'my-life',source:'my-life',limit:100,offset:0},homeAuth);
    assert.equal(list.total,2);const id=list.memories.find(row=>row.content===a.content)!.id;
    const bId=list.memories.find(row=>row.content===b.content)!.id;
    assert.equal((await memoryRecall({id},homeAuth)).content,a.content);
    await assert.rejects(memoryRecall({id},workAuth),/access denied/);
    await assert.rejects(memoryRecall({id},{...homeAuth,maxAccessLevel:'normal'}),/access denied/);
    assert.equal((await memoryList({namespace:'my-life',limit:100,offset:0},workAuth)).total,0);
    assert.equal((await archiveSyncStatus(app,key,m1.archive_id)).pending,2);
    const embed=async(texts:string[])=>texts.map(()=>({...ACTIVE_EMBEDDING_PROFILE,vector:Array.from({length:768},(_,i)=>i===0?1:0)}));
    await assert.rejects(embedArchiveBatch(app,key,m1.archive_id,64,async texts=>(await embed(texts)).map(r=>({...r,model:'wrong'}))),/embedding_profile/);
    assert.equal((await archiveSyncStatus(app,key,m1.archive_id)).pending,2);
    assert.equal((await embedArchiveBatch(app,key,m1.archive_id,64,embed)).written,2);
    const unchangedState=async()=>(await owner.query(`select id,ctid::text ctid,revision,updated_at,embedding::text embedding,
      embedding_provider,embedding_model,embedding_dimensions from memories
      where source='my-life' and namespace='my-life' order by id`)).rows;
    const beforeUnchanged=await unchangedState();
    const m2=fixtureManifest('2026-01-02T00:00:00.000Z');
    const unchanged=await receiveArchive(app,fixtureStream(m2,[a,b]),key,m2.archive_id);
    assert.equal(unchanged.written,2);assert.equal(unchanged.protected,0);
    assert.equal((await archiveSyncStatus(app,key,m2.archive_id)).pending,0,'unchanged data keeps vectors');
    assert.deepEqual(await unchangedState(),beforeUnchanged,'unchanged refresh preserves tuple, revision, timestamp and vector');
    await receiveArchive(app,fixtureStream(m2,[a,b]),key,m2.archive_id);
    assert.deepEqual(await unchangedState(),beforeUnchanged,'same-snapshot replay rebuilds membership without rewriting memories');
    assert.deepEqual((await owner.query(`select count(*)::int total,count(distinct membership_id)::int generations,
      bool_and(membership_id::text=(select metadata->>'membership_id' from memories where source='my-life:sync-state')) current
      from archive_sync_snapshot_memberships`)).rows[0],{total:2,generations:1,current:true});
    const staleReceiver=await app.connect();try{
      await staleReceiver.query('begin');
      await staleReceiver.query("select set_config('app.allowed_namespaces',$1,true)",[JSON.stringify(['my-life'])]);
      await staleReceiver.query("select set_config('app.current_key_id',$1,true)",[key]);
      await assert.rejects(staleReceiver.query(`update memories set metadata=metadata||$3::jsonb
        where client_id=$1 and source_key=$2`,[key,`mylife:state:${m2.archive_id}`,
        JSON.stringify({started_manifest:fixtureManifest('2026-01-02T06:00:00.000Z'),copy_in_progress:true})]),
        /membership_schema_mismatch/,'old receiver cannot begin without a new membership generation');
    }finally{await staleReceiver.query('rollback');staleReceiver.release();}
    const staleTrailer=await app.connect();try{
      await staleTrailer.query('begin');
      await staleTrailer.query("select set_config('app.allowed_namespaces',$1,true)",[JSON.stringify(['my-life'])]);
      await staleTrailer.query("select set_config('app.current_key_id',$1,true)",[key]);
      await assert.rejects(staleTrailer.query(`update memories set metadata=jsonb_set(metadata,
        '{pending_finalization}',$3::jsonb) where client_id=$1 and source_key=$2`,
        [key,`mylife:state:${m2.archive_id}`,JSON.stringify({manifest:m2,cursor:null,removed:0})]),
        /membership_schema_mismatch/,'legacy trailer cannot publish without the matching generation');
    }finally{await staleTrailer.query('rollback');staleTrailer.release();}
    const reader=await app.connect();try{
      await reader.query('begin');
      await reader.query("select set_config('app.allowed_namespaces',$1,true)",[JSON.stringify(['my-life'])]);
      await reader.query("select set_config('app.current_key_id',$1,true)",[home]);
      assert.equal((await reader.query('select count(*)::int count from archive_sync_snapshot_memberships')).rows[0].count,0,
        'a personal reader cannot read sync membership');
      await assert.rejects(reader.query(`insert into archive_sync_snapshot_memberships(sync_key_id,archive_id,membership_id,source_key)
        values($1,'synthetic-archive',$2,'unauthorized')`,[home,m2.snapshot_id]),/row-level security/i);
    }finally{await reader.query('rollback');reader.release();}
    await owner.query('alter table memories drop constraint embedding_identity_all_or_none');
    await owner.query('update memories set embedding=null where id=$1',[bId]);
    await owner.query(`alter table memories add constraint embedding_identity_all_or_none check (
      (embedding_provider is null and embedding_model is null and embedding_dimensions is null)
      or (embedding is not null and embedding_provider is not null and embedding_provider<>''
        and embedding_model is not null and embedding_model<>'' and embedding_dimensions is not null and embedding_dimensions>0)
    ) not valid`);
    const repairedProfile=fixtureManifest('2026-01-02T12:00:00.000Z');
    await receiveArchive(app,fixtureStream(repairedProfile,[a,b]),key,repairedProfile.archive_id);
    assert.deepEqual((await owner.query(`select embedding is null no_vector,embedding_provider,embedding_model,embedding_dimensions
      from memories where id=$1`,[bId])).rows[0],{no_vector:true,embedding_provider:null,embedding_model:null,embedding_dimensions:null},
      'malformed partial embedding identity is normalized to wholly-null pending');
    assert.equal((await embedArchiveBatch(app,key,repairedProfile.archive_id,64,embed)).written,1);
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
    await owner.query("update memories set access_level='secret' where id=$1",[bId]);
    const promoted=fixtureManifest('2026-01-04T12:00:00.000Z');
    const promotedRetry=await receiveArchive(app,fixtureStream(promoted,[changed,b]),key,promoted.archive_id);
    assert.equal(promotedRetry.protected,2,'manual tombstones and rows above the sync clearance remain protected');
    await owner.query("update memories set access_level='sensitive' where id=$1",[bId]);
    const many=Array.from({length:500},(_,i)=>fixtureRecord('partial-'+i,'Synthetic '+i));
    const broken=fixtureManifest('2026-01-05T00:00:00.000Z');
    await assert.rejects(receiveArchive(app,fixtureStream(broken,many,c=>c.sha256='0'.repeat(64)),key,broken.archive_id),/incomplete_snapshot/);
    assert.equal((await owner.query("select count(*)::int n from memories where source='my-life' and deleted_at is null")).rows[0].n,501,'partial writes do not prune old records');
    assert.equal((await owner.query(`select count(*)::int n from archive_sync_snapshot_memberships
      where membership_id::text=(select metadata->>'membership_id' from memories where source='my-life:sync-state')`)).rows[0].n,500);
    await assert.rejects(receiveArchive(app,fixtureStream(m4,[b]),key,m4.archive_id),/stale_snapshot/,'an interrupted newer snapshot also prevents rollback');
    const m6=fixtureManifest('2026-01-06T00:00:00.000Z');
    const done=await receiveArchive(app,fixtureStream(m6,[b]),key,m6.archive_id,()=>{},{allowShrink:true});assert.equal(done.removed,500);
    assert.deepEqual((await owner.query(`select count(*)::int n,count(distinct membership_id)::int generations,
      bool_and(membership_id::text=(select metadata->>'membership_id' from memories where source='my-life:sync-state')) current
      from archive_sync_snapshot_memberships`)).rows[0],{n:1,generations:1,current:true},
      'newer replay reconciles incomplete membership before retaining the completed generation');
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
    const m9=fixtureManifest('2026-01-09T00:00:00.000Z');
    const parallel=Array.from({length:64},(_,i)=>fixtureRecord('parallel-'+i,'Parallel synthetic '+i));
    await receiveArchive(app,fixtureStream(m9,parallel),key,m9.archive_id);
    const seen=new Set<string>();let active=0,peak=0;
    await runEmbeddingWorker(app,key,m9.archive_id,3,4,async texts=>{
      for(const text of texts){if(seen.has(text))throw new Error('archive_sync.duplicate_test_embedding');seen.add(text);}
      active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,20));active--;
      return embed(texts);
    },()=>{},0);
    assert.equal(seen.size,64);assert.ok(peak>=2&&peak<=4);
    assert.equal((await archiveSyncStatus(app,key,m9.archive_id)).pending,0);
    const m10=fixtureManifest('2026-01-10T00:00:00.000Z');
    const prunable=Array.from({length:1200},(_,i)=>fixtureRecord('prunable-'+i,'Synthetic prune '+i));
    await receiveArchive(app,fixtureStream(m10,prunable),key,m10.archive_id);
    await owner.query(`update memories set metadata=jsonb_set(metadata,'{my_life,embedding_failure}','{"code":"synthetic"}') where source='my-life' and deleted_at is null`);
    assert.equal((await retryArchiveFailures(app,key,m10.archive_id)).records,1200,'failure reset crosses multiple cursor batches');
    const m11=fixtureManifest('2026-01-11T00:00:00.000Z');
    await assert.rejects(receiveArchive(app,fixtureStream(m11,[]),key,m11.archive_id),/shrink_requires_override/);
    assert.equal((await archiveSyncStatus(app,key,m11.archive_id)).chunks,1200,'wrong empty source cannot prune');
    const racedId=(await owner.query(`select id from memories where source='my-life' and deleted_at is null
      and metadata->'my_life'->>'archive_id'=$1 order by source_key limit 1`,[m10.archive_id])).rows[0].id;
    const blocker=await owner.connect();let blockerCommitted=false;
    let racedReceive:ReturnType<typeof receiveArchive>|undefined;
    try{
      await blocker.query('begin');
      await blocker.query('select id from memories where id=$1 for update',[racedId]);
      racedReceive=receiveArchive(app,fixtureStream(m11,[]),key,m11.archive_id,value=>{
        if(value.event==='archive_sync.prune_progress')throw new Error('synthetic_finalization_interruption');
      },{allowShrink:true});
      void racedReceive.catch(()=>{}); // The bounded path can reject before the lock observer finishes polling.
      let waited=false;
      for(let attempt=0;attempt<100;attempt++){
        const waiting=Number((await owner.query(`select count(*)::int count from pg_stat_activity
          where usename='total_recall_app' and wait_event_type='Lock'`)).rows[0].count);
        if(waiting){waited=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.equal(waited,true,'finalization reaches the locked candidate');
      await blocker.query('update memories set deleted_at=statement_timestamp() where id=$1',[racedId]);
      await blocker.query('commit');blockerCommitted=true;
      await assert.rejects(racedReceive,/synthetic_finalization_interruption/);
    }finally{
      if(!blockerCommitted)await blocker.query('rollback').catch(()=>{});
      blocker.release();
      await racedReceive?.catch(()=>{});
    }
    const interrupted=await archiveSyncStatus(app,key,m11.archive_id);
    assert.equal(interrupted.chunks,700);assert.equal(interrupted.sync.copy_in_progress,true);
    assert.equal(interrupted.sync.pending_finalization.removed,499,'locked-row recheck does not count the concurrent tombstone');
    await owner.query(`update memories set metadata=jsonb_set(metadata,'{pending_finalization,reconcile_generation}',to_jsonb($3::text),true)
      where client_id=$1 and source_key=$2`,[key,`mylife:state:${m11.archive_id}`,
      interrupted.sync.pending_finalization.membership_id.toUpperCase()]);
    await assert.rejects(finalizeArchive(app,key,m11.archive_id),/finalization_state_mismatch/,
      'a malformed old-generation cursor cannot delete current membership');
    await owner.query(`update memories set metadata=metadata #- '{pending_finalization,reconcile_generation}'
      where client_id=$1 and source_key=$2`,[key,`mylife:state:${m11.archive_id}`]);
    await owner.query(`update memories set metadata=jsonb_set(metadata,'{pending_finalization,reconciliation_complete}','"true"'::jsonb,true)
      where client_id=$1 and source_key=$2`,[key,`mylife:state:${m11.archive_id}`]);
    await assert.rejects(finalizeArchive(app,key,m11.archive_id),/finalization_state_mismatch/,
      'a nonboolean completion marker cannot bypass reconciliation');
    await owner.query(`update memories set metadata=metadata #- '{pending_finalization,reconciliation_complete}'
      where client_id=$1 and source_key=$2`,[key,`mylife:state:${m11.archive_id}`]);
    for(const invalid of ['499',-1,1.5,null,Number.MAX_SAFE_INTEGER+1]){
      await owner.query(`update memories set metadata=jsonb_set(metadata,'{pending_finalization,removed}',$3::jsonb,true)
        where client_id=$1 and source_key=$2`,[key,`mylife:state:${m11.archive_id}`,JSON.stringify(invalid)]);
      await assert.rejects(finalizeArchive(app,key,m11.archive_id),/finalization_state_mismatch/,
        'malformed persisted removal count cannot corrupt finalization accounting');
    }
    await owner.query(`update memories set metadata=jsonb_set(metadata,'{pending_finalization,removed}','499'::jsonb,true)
      where client_id=$1 and source_key=$2`,[key,`mylife:state:${m11.archive_id}`]);
    await owner.query(`update memories set metadata=jsonb_set(metadata,'{pending_finalization,removed}',$3::jsonb,true)
      where client_id=$1 and source_key=$2`,[key,`mylife:state:${m11.archive_id}`,JSON.stringify(Number.MAX_SAFE_INTEGER)]);
    await assert.rejects(finalizeArchive(app,key,m11.archive_id),/finalization_state_mismatch/,
      'safe-integer removal count cannot overflow during the next prune batch');
    await owner.query(`update memories set metadata=jsonb_set(metadata,'{pending_finalization,removed}','499'::jsonb,true)
      where client_id=$1 and source_key=$2`,[key,`mylife:state:${m11.archive_id}`]);
    const staleFinalizer=await app.connect();try{
      await staleFinalizer.query('begin');
      await staleFinalizer.query("select set_config('app.allowed_namespaces',$1,true)",[JSON.stringify(['my-life'])]);
      await staleFinalizer.query("select set_config('app.current_key_id',$1,true)",[key]);
      assert.notEqual((await staleFinalizer.query("select current_setting('app.archive_membership_finalizer',true) marker")).rows[0].marker,
        interrupted.sync.pending_finalization.membership_id,'generation marker is transaction-local and not inherited by stale sessions');
      const candidate=(await owner.query(`select id from memories where source='my-life' and namespace='my-life'
        and deleted_at is null order by id limit 1`)).rows[0].id;
      await assert.rejects(staleFinalizer.query(`update memories set deleted_at=statement_timestamp(),
        metadata=jsonb_set(metadata,'{my_life,removed_by_sync}','true') where id=$1`,[candidate]),
        /membership_finalizer_required/,'old finalizer cannot tombstone during membership-aware pending state');
    }finally{await staleFinalizer.query('rollback');staleFinalizer.release();}
    const manual=await app.connect();try{
      await manual.query('begin');
      await manual.query("select set_config('app.allowed_namespaces',$1,true)",[JSON.stringify(['personal','my-life'])]);
      await manual.query("select set_config('app.current_key_id',$1,true)",[home]);
      const candidate=(await owner.query(`select id from memories where source='my-life' and namespace='my-life'
        and deleted_at is null order by id limit 1`)).rows[0].id;
      assert.equal((await manual.query('update memories set deleted_at=statement_timestamp() where id=$1',[candidate])).rowCount,1,
        'manual tombstone under a different authorized key remains permitted');
      await manual.query('commit');
    }finally{await manual.query('rollback').catch(()=>{});manual.release();}
    await assert.rejects(receiveArchive(app,fixtureStream(m11,[]),key,m11.archive_id),/finalization_required/);
    assert.equal((await finalizeArchive(app,key,m11.archive_id)).removed,1198);
    assert.equal((await finalizeArchive(app,key,m11.archive_id)).removed,1198,'completed finalization is idempotent');
    assert.equal((await archiveSyncStatus(app,key,m11.archive_id)).chunks,0);
    const m12=fixtureManifest('2026-01-12T00:00:00.000Z');
    const poison=fixtureRecord('poison','Synthetic rejected input'),good=fixtureRecord('good','Synthetic accepted input');
    await receiveArchive(app,fixtureStream(m12,[poison,good]),key,m12.archive_id);
    const rejecting=async(texts:string[])=>{
      if(texts.some(text=>text===poison.content))throw new Error('Gemini batchEmbedContents failed (400): PRIVATE_RESPONSE');
      return embed(texts);
    };
    const poisoned=await embedArchiveBatch(app,key,m12.archive_id,64,rejecting);
    assert.equal(poisoned.written,1);assert.equal(poisoned.failed,1);
    assert.equal((await archiveSyncStatus(app,key,m12.archive_id)).pending,0);
    assert.equal((await archiveSyncStatus(app,key,m12.archive_id)).failed,1);
    const logs:unknown[]=[];
    await assert.rejects(runEmbeddingWorker(app,key,m12.archive_id,64,1,rejecting,value=>logs.push(value),0),/embedding_records_failed/);
    assert.ok(!JSON.stringify(logs).includes('PRIVATE_RESPONSE'));
    assert.ok(!JSON.stringify(logs).includes('embedding_complete'));
    assert.equal((await retryArchiveFailures(app,key,m12.archive_id)).records,1);
    await runEmbeddingWorker(app,key,m12.archive_id,64,1,embed,()=>{},0);
    assert.equal((await archiveSyncStatus(app,key,m12.archive_id)).failed,0);
    assert.equal((await owner.query("select count(*)::int n from entity_enrichment_queue where namespace='my-life' and status in ('pending','retry','processing')")).rows[0].n,0);
    const m13=fixtureManifest('2026-01-13T00:00:00.000Z');
    await receiveArchive(app,fixtureStream(m13,Array.from({length:40},(_,i)=>fixtureRecord('budget-'+i,'Rejected synthetic '+i))),key,m13.archive_id);
    let requests=0;
    await assert.rejects(runEmbeddingWorker(app,key,m13.archive_id,1,1,async()=>{requests++;throw new Error('Gemini batchEmbedContents failed (400): PRIVATE');},()=>{},0),/embedding_input_failure_budget/);
    assert.equal(requests,32,'systemic failures stop across separate batches');
    await owner.query('update api_keys set revoked_at=now() where id=$1',[key]);
    await assert.rejects(embedArchiveBatch(app,key,m7.archive_id,64,embed),/identity_denied/);
    await assert.rejects(receiveArchive(app,fixtureStream(fixtureManifest('2026-01-14T00:00:00.000Z'),[]),key,m13.archive_id),/identity_denied/);
    const revoked=await app.connect();try{
      await revoked.query('begin');
      await revoked.query("select set_config('app.allowed_namespaces',$1,true)",[JSON.stringify(['my-life'])]);
      await revoked.query("select set_config('app.current_key_id',$1,true)",[key]);
      assert.equal((await revoked.query('select count(*)::int count from archive_sync_snapshot_memberships')).rows[0].count,0,
        'revoked sync identity cannot read membership');
    }finally{await revoked.query('rollback');revoked.release();}
    await assert.rejects(provisionArchiveSync(app,'synthetic-archive',[home]),/identity_requires_operator_recovery/);
    assert.equal((await owner.query("select count(*)::int n from memories where namespace='my-life' and access_level<>'sensitive'")).rows[0].n,0);
  }finally{setPoolForTesting(null);await app?.end();await owner.end();}
});
