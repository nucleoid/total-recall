import {createHash} from 'node:crypto';
import type {Readable} from 'node:stream';
import type {Pool,PoolClient} from 'pg';
import {authContextFromRow} from '../auth.js';
import type {AuthContext} from '../types.js';
import {ACTIVE_EMBEDDING_PROFILE,embedBatchWithProfile,serializeEmbeddingVector,type EmbeddingResult} from '../embedding.js';
import {archivePrefix,recordKey,manifestSchema,recordSchema,completeSchema,protocolLines,SYNC_NAMESPACE,
  type SyncManifest,type SyncRecord,type SyncComplete} from './sync-format.js';

export type Progress=(value:Record<string,unknown>)=>void;
/** This operator CLI must retain the same RLS boundary as the running service. */
export async function assertSafeSyncRole(client:PoolClient):Promise<void>{
  const row=(await client.query(`select r.rolsuper,r.rolbypassrls,m.relowner=r.oid owns_memories,
    m.relrowsecurity from pg_roles r join pg_class m on m.oid='memories'::regclass where r.rolname=current_user`)).rows[0];
  if(!row||row.rolsuper||row.rolbypassrls||row.owns_memories||!row.relrowsecurity)
    throw new Error('archive_sync.unsafe_database_role');
}
export async function syncAuth(client:PoolClient,keyId:string):Promise<AuthContext>{
  const row=(await client.query(`select id,name,namespaces,permissions,max_access_level,requests_per_minute,requests_per_day,expires_at
    from api_keys where id=$1::uuid and enabled and revoked_at is null and (expires_at is null or expires_at>now())`,[keyId])).rows[0];
  const auth=authContextFromRow(row);
  if(!auth||auth.namespaces.length!==1||auth.namespaces[0]!==SYNC_NAMESPACE||!auth.permissions.includes('import')||
    !auth.permissions.includes('write')||!auth.permissions.includes('read')||auth.maxAccessLevel!=='sensitive')throw new Error('archive_sync.identity_denied');
  return auth;
}

async function startSnapshot(client:PoolClient,keyId:string,manifest:SyncManifest):Promise<void>{
  if(Date.parse(manifest.as_of)>Date.now()+300000)throw new Error('archive_sync.future_snapshot');
  await scoped(client,keyId,async()=>{
    const stateRow=(await client.query(`select access_level,source,namespace,deleted_at,
      case when access_level='sensitive' and source='my-life:sync-state' and namespace='my-life' then metadata else null end metadata
      from memories where client_id=$1 and source_key=$2`,[keyId,`mylife:state:${manifest.archive_id}`])).rows[0];
    if(stateRow&&(stateRow.access_level!=='sensitive'||stateRow.source!=='my-life:sync-state'||stateRow.namespace!=='my-life'||stateRow.deleted_at))throw new Error('archive_sync.state_protected');
    const state=stateRow?.metadata;
    const prior=state?.started_manifest??state?.manifest;
    if(state?.pending_finalization)throw new Error('archive_sync.finalization_required');
    if(prior&&(Date.parse(prior.as_of)>Date.parse(manifest.as_of)||
      (prior.as_of===manifest.as_of&&prior.snapshot_id!==manifest.snapshot_id)))throw new Error('archive_sync.stale_snapshot');
    const saved=await client.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,memory_kind,valid_from,decay_rate)
      values('My Life archive synchronization status','my-life:sync-state','my-life',array['my-life','sync-status'],$1,'sensitive',$2,$3,'synced',statement_timestamp(),0)
      on conflict(client_id,source_key) do update set metadata=memories.metadata||excluded.metadata,updated_at=statement_timestamp()
      where memories.namespace='my-life' and memories.source='my-life:sync-state' and memories.access_level='sensitive' and memories.deleted_at is null`,
      [JSON.stringify({started_manifest:manifest,copy_in_progress:true}),keyId,`mylife:state:${manifest.archive_id}`]);
    if(saved.rowCount!==1)throw new Error('archive_sync.state_protected');
    await retirePrivateEnrichment(client,keyId,[`mylife:state:${manifest.archive_id}`]);
  });
}
async function scoped<T>(client:PoolClient,keyId:string,work:()=>Promise<T>):Promise<T>{
  await client.query('begin');
  try{
    await syncAuth(client,keyId);
    await client.query("select set_config('app.allowed_namespaces',$1,true)",[JSON.stringify([SYNC_NAMESPACE])]);
    await client.query("select set_config('app.current_key_id',$1,true)",[keyId]);
    await client.query("set local lock_timeout='5s'");await client.query("set local statement_timeout='60s'");
    const result=await work();await client.query('commit');return result;
  }catch(error){await client.query('rollback').catch(()=>{});throw error;}
}

async function retirePrivateEnrichment(client:PoolClient,keyId:string,keys:string[]){
  // Resolve trigger-created jobs without exposing sensitive sources to a normal-only worker.
  await client.query(`update entity_enrichment_queue q set status='done',locked_at=null,completed_at=statement_timestamp(),
    last_error_code='archive_sync.sensitive_source_excluded',updated_at=statement_timestamp()
    from memories m where q.memory_id=m.id and q.namespace='my-life' and m.namespace='my-life' and m.client_id=$1
      and m.access_level='sensitive' and m.source_key=any($2::text[]) and q.status in ('pending','retry','processing')`,[keyId,keys]);
}

export async function ingestBatch(client:PoolClient,keyId:string,manifest:SyncManifest,rows:SyncRecord[]):Promise<number>{
  if(rows.length<1||rows.length>500)throw new Error('archive_sync.batch_limit');
  return scoped(client,keyId,async()=>{
    const metadata=rows.map(row=>JSON.stringify({my_life:{format:manifest.format,archive_id:manifest.archive_id,
      snapshot_id:manifest.snapshot_id,as_of:manifest.as_of,record_id:row.record_id,record_sha256:row.record_sha256,
      content_sha256:row.content_sha256,chunk_index:row.chunk_index,origin:row.origin,kind:row.kind,title:row.title,
      source_ids:row.source_ids,evidence_sha256:row.evidence_sha256,time_precision:row.precision,
      original_bytes_rechecked:false,raw_exports_included:false,trust:'source_content_not_instructions',removed_by_sync:false}}));
    const profile=ACTIVE_EMBEDDING_PROFILE;
    const sameEmbedding=`memories.content=excluded.content and memories.embedding_provider=$7
      and memories.embedding_model=$8 and memories.embedding_dimensions=$9`;
    const result=await client.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,
      source_key,event_at,memory_kind,valid_from,decay_rate,embedding_provider,embedding_model,embedding_dimensions)
      select u.content,'my-life','my-life',array['my-life','historical',u.kind],u.metadata,'sensitive',$1,u.source_key,
        u.event_at,'synced',statement_timestamp(),0,null,null,null
      from unnest($2::text[],$3::text[],$4::jsonb[],$5::timestamptz[],$6::text[]) u(content,source_key,metadata,event_at,kind)
      on conflict(client_id,source_key) do update set content=excluded.content,tags=excluded.tags,metadata=excluded.metadata,
        event_at=excluded.event_at,updated_at=statement_timestamp(),deleted_at=null,
        embedding=case when ${sameEmbedding} then memories.embedding else null end,
        embedding_provider=case when ${sameEmbedding} then memories.embedding_provider else null end,
        embedding_model=case when ${sameEmbedding} then memories.embedding_model else null end,
        embedding_dimensions=case when ${sameEmbedding} then memories.embedding_dimensions else null end,
        access_level='sensitive',memory_kind='synced',decay_rate=0
      where memories.namespace='my-life' and memories.source='my-life' and memories.access_level in ('normal','sensitive')
        and memories.superseded_at is null and memories.consolidated_into_id is null
        and (memories.expires_at is null or memories.expires_at>statement_timestamp())
        and (memories.deleted_at is null or memories.metadata->'my_life'->>'removed_by_sync'='true')`,
      [keyId,rows.map(row=>row.content),rows.map(row=>recordKey(manifest,row)),metadata,rows.map(row=>row.event_at),rows.map(row=>row.kind),
        profile.provider,profile.model,profile.dimensions]);
    await retirePrivateEnrichment(client,keyId,rows.map(row=>recordKey(manifest,row)));
    return result.rowCount??0;
  });
}

async function commitSnapshot(client:PoolClient,keyId:string,manifest:SyncManifest,complete:SyncComplete,removed:number):Promise<number>{
  return scoped(client,keyId,async()=>{
    const saved=await client.query(`insert into memories(content,source,namespace,tags,metadata,access_level,client_id,source_key,memory_kind,valid_from,decay_rate)
      values('My Life archive synchronization status','my-life:sync-state','my-life',array['my-life','sync-status'],$1,'sensitive',$2,$3,'synced',statement_timestamp(),0)
      on conflict(client_id,source_key) do update set metadata=excluded.metadata,updated_at=statement_timestamp()
      where memories.namespace='my-life' and memories.source='my-life:sync-state' and memories.access_level='sensitive' and memories.deleted_at is null`,
      [JSON.stringify({manifest,started_manifest:manifest,complete,removed,copy_in_progress:false,finished_at:new Date().toISOString()}),keyId,`mylife:state:${manifest.archive_id}`]);
    if(saved.rowCount!==1)throw new Error('archive_sync.state_protected');
    await client.query(`insert into audit_log(client_id,action,namespace,resource_type,resource_id,details)
      values($1,'archive.sync_complete','my-life','archive',$2,$3)`,[keyId,manifest.archive_id,
      JSON.stringify({snapshot_id:manifest.snapshot_id,records:complete.records,chunks:complete.chunks,removed})]);
    await retirePrivateEnrichment(client,keyId,[`mylife:state:${manifest.archive_id}`]);
    return removed;
  });
}

async function finishSnapshot(client:PoolClient,keyId:string,archiveId:string,progress:Progress):Promise<number>{
  for(;;){
    const batch=await scoped(client,keyId,async()=>{
      const key=`mylife:state:${archiveId}`;
      const state=(await client.query("select metadata from memories where client_id=$1 and source_key=$2 and namespace='my-life' and source='my-life:sync-state' and access_level='sensitive' and deleted_at is null for update",[keyId,key])).rows[0]?.metadata;
      const pending=state?.pending_finalization;
      if(!pending&&state?.copy_in_progress===false&&state.manifest?.archive_id===archiveId){
        return {manifest:manifestSchema.parse(state.manifest),complete:completeSchema.parse(state.complete),removed:Number(state.removed??0),count:0,alreadyComplete:true};
      }
      if(!pending)throw new Error('archive_sync.verified_trailer_required');
      const manifest=manifestSchema.parse(pending.manifest),complete=completeSchema.parse(pending.complete);
      if(manifest.archive_id!==archiveId||state.started_manifest?.snapshot_id!==manifest.snapshot_id)throw new Error('archive_sync.finalization_state_mismatch');
      const rows=(await client.query(`select id,source_key from memories where client_id=$1 and namespace='my-life' and source='my-life' and access_level='sensitive'
        and source_key like $2 and metadata->'my_life'->>'archive_id'=$3 and metadata->'my_life'->>'snapshot_id' is distinct from $4
        and deleted_at is null and superseded_at is null and consolidated_into_id is null
        and (expires_at is null or expires_at>statement_timestamp()) and ($5::uuid is null or id>$5::uuid)
        order by id limit 500 for update`,[keyId,archivePrefix(archiveId)+'%',archiveId,manifest.snapshot_id,pending.cursor??null])).rows;
      if(rows.length){
        await client.query(`update memories set deleted_at=statement_timestamp(),updated_at=statement_timestamp(),
          metadata=jsonb_set(metadata,'{my_life,removed_by_sync}','true') where id=any($1::uuid[])`,[rows.map(row=>row.id)]);
        await retirePrivateEnrichment(client,keyId,rows.map(row=>row.source_key));
        pending.cursor=rows.at(-1)!.id;pending.removed+=rows.length;
        await client.query("update memories set metadata=jsonb_set(metadata,'{pending_finalization}',$3::jsonb) where client_id=$1 and source_key=$2",[keyId,key,JSON.stringify(pending)]);
      }
      return {manifest,complete,removed:pending.removed as number,count:rows.length,alreadyComplete:false};
    });
    if(batch.alreadyComplete)return batch.removed;
    if(!batch.count)return commitSnapshot(client,keyId,batch.manifest,batch.complete,batch.removed);
    progress({event:'archive_sync.prune_progress',removed:batch.removed});
  }
}

/** Resume a hash-verified trailer without the source drive or another stream. */
export async function finalizeArchive(pool:Pool,keyId:string,archiveId:string,progress:Progress=()=>{}){
  const client=await pool.connect();let locked=false;const lockName=`my-life-sync:${keyId}:${archiveId}`;
  try{
    await assertSafeSyncRole(client);await syncAuth(client,keyId);
    locked=(await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) acquired',[lockName])).rows[0].acquired;
    if(!locked)throw new Error('archive_sync.already_running');
    const removed=await finishSnapshot(client,keyId,archiveId,progress);
    return {event:'archive_sync.finalized',archive_id:archiveId,removed};
  }finally{if(locked)await client.query('select pg_advisory_unlock(hashtextextended($1,0))',[lockName]).catch(()=>{});client.release();}
}

/** A wrong/empty source must never silently remove a substantial destination archive. */
export function assertSnapshotSize(previous:SyncComplete|undefined,next:SyncComplete,allowShrink=false){
  if(allowShrink||!previous)return;
  if(Object.entries(previous.coverage).some(([origin,value])=>value.records>=100&&
    (next.coverage[origin as keyof SyncComplete['coverage']]?.records??0)<value.records*0.9))
    throw new Error('archive_sync.shrink_requires_override');
}

export async function receiveArchive(pool:Pool,input:Readable,keyId:string,archiveId:string,progress:Progress=()=>{},options:{allowShrink?:boolean}={}):Promise<Record<string,unknown>>{
  const client=await pool.connect();const hash=createHash('sha256');
  let manifest:SyncManifest|undefined,complete:SyncComplete|undefined;
  let rows:SyncRecord[]=[],received=0,records=0,written=0,lastId='',lastIndex=-1,locked=false,lastRecordHash='';
  const origins:Record<string,number>={};
  const seen=new Set<string>(); // Record identities only, never source content.
  try{
    await assertSafeSyncRole(client);await syncAuth(client,keyId);
    const lock=(await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) acquired',[`my-life-sync:${keyId}:${archiveId}`])).rows[0];
    if(!lock.acquired)throw new Error('archive_sync.already_running');
    locked=true;
    for await(const line of protocolLines(input)){
      if(complete)throw new Error('archive_sync.data_after_complete');
      const raw=JSON.parse(line);
      if(!manifest){manifest=manifestSchema.parse(raw);if(manifest.archive_id!==archiveId)throw new Error('archive_sync.archive_mismatch');
        await startSnapshot(client,keyId,manifest);}
      else if(raw.type==='complete'){complete=completeSchema.parse(raw);continue;}
      else{
        const row=recordSchema.parse(raw);
        if(row.record_id!==lastId){
          if(seen.has(row.record_id)||row.chunk_index!==0)throw new Error('archive_sync.record_order');
          seen.add(row.record_id);records++;lastId=row.record_id;lastIndex=-1;
          lastRecordHash=row.record_sha256;origins[row.origin]=(origins[row.origin]??0)+1;
        }
        if(row.record_sha256!==lastRecordHash)throw new Error('archive_sync.inconsistent_record');
        if(row.chunk_index!==lastIndex+1)throw new Error('archive_sync.chunk_order');lastIndex=row.chunk_index;
        rows.push(row);received++;
        if(rows.length===500){written+=await ingestBatch(client,keyId,manifest,rows);rows=[];progress({event:'archive_sync.copy_progress',received,written});}
      }
      hash.update(line+'\n','utf8');
    }
    if(!manifest||!complete||complete.chunks!==received||complete.records!==records||complete.sha256!==hash.digest('hex'))
      throw new Error('archive_sync.incomplete_snapshot');
    if(Object.values(complete.coverage).reduce((sum,value)=>sum+value.records,0)!==records||
      Object.entries(complete.coverage).some(([origin,value])=>value.records!==(origins[origin]??0)))throw new Error('archive_sync.coverage_mismatch');
    if(rows.length)written+=await ingestBatch(client,keyId,manifest,rows);
    await scoped(client,keyId,async()=>{
      const previous=(await client.query("select metadata->'complete' complete from memories where client_id=$1 and source_key=$2",[keyId,`mylife:state:${archiveId}`])).rows[0]?.complete;
      assertSnapshotSize(previous,complete!,options.allowShrink===true);
    });
    await scoped(client,keyId,async()=>{
      const saved=await client.query(`update memories set metadata=jsonb_set(metadata,'{pending_finalization}',$3::jsonb)
        where client_id=$1 and source_key=$2 and namespace='my-life' and source='my-life:sync-state' and access_level='sensitive'`,
        [keyId,`mylife:state:${archiveId}`,JSON.stringify({manifest,complete,cursor:null,removed:0})]);
      if(saved.rowCount!==1)throw new Error('archive_sync.state_protected');
    });
    const removed=await finishSnapshot(client,keyId,archiveId,progress);
    const result={event:'archive_sync.copy_complete',archive_id:archiveId,snapshot_id:manifest.snapshot_id,records,received,written,
      protected:received-written,removed,coverage:complete.coverage};progress(result);return result;
  }finally{
    if(locked)await client.query('select pg_advisory_unlock(hashtextextended($1,0))',[`my-life-sync:${keyId}:${archiveId}`]).catch(()=>{});
    client.release();
  }
}

export async function embedArchiveBatch(pool:Pool,keyId:string,archiveId:string,limit=64,
  embedder:(texts:string[])=>Promise<EmbeddingResult[]>=embedBatchWithProfile,afterId:string|null=null,
  range:{lower:string|null;upper:string|null}={lower:null,upper:null}):Promise<{selected:number;written:number;failed:number;cursor:string|null}>{
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('archive_sync.embedding_batch_limit');
  const client=await pool.connect();
  try{
    await assertSafeSyncRole(client);
    const rows=await scoped(client,keyId,async()=>(await client.query(`select id,content,metadata->'my_life'->>'content_sha256' content_sha256
      from memories where client_id=$1 and namespace='my-life' and source='my-life' and access_level='sensitive'
        and source_key like $2 and embedding is null and deleted_at is null and superseded_at is null and consolidated_into_id is null
        and (expires_at is null or expires_at>statement_timestamp())
        and metadata->'my_life'->'embedding_failure' is null
        and ($4::uuid is null or id>$4::uuid)
        and ($5::uuid is null or id>=$5::uuid) and ($6::uuid is null or id<$6::uuid)
      order by id limit $3`,[keyId,archivePrefix(archiveId)+'%',limit,afterId,range.lower,range.upper])).rows);
    if(!rows.length)return {selected:0,written:0,failed:0,cursor:afterId};
    let written=0,failed=0;
    // External provider work never holds a database transaction or source-drive connection.
    const processRows=async(group:typeof rows):Promise<void>=>{
    let embedded:EmbeddingResult[];
    try{embedded=await embedder(group.map(row=>row.content));}
    catch(error){
      const code=error instanceof Error?/^(?:Gemini (?:batchEmbedContents|embedContent)|Ollama embed) failed \((400|413|422)\):/.exec(error.message)?.[1]:undefined;
      if(!code)throw error; // Authentication, quotas and service failures are never poison records.
      if(group.length>1){const middle=Math.ceil(group.length/2);await processRows(group.slice(0,middle));await processRows(group.slice(middle));return;}
      const row=group[0];
      failed+=await scoped(client,keyId,async()=>{
        const result=await client.query(`update memories set metadata=jsonb_set(metadata,'{my_life,embedding_failure}',$5::jsonb)
          where id=$1 and client_id=$2 and namespace='my-life' and source='my-life' and access_level='sensitive'
            and content=$3 and metadata->'my_life'->>'content_sha256'=$4 and embedding is null
            and deleted_at is null and superseded_at is null and consolidated_into_id is null
            and (expires_at is null or expires_at>statement_timestamp())`,
          [row.id,keyId,row.content,row.content_sha256,JSON.stringify({code:`http_${code}`,model:ACTIVE_EMBEDDING_PROFILE.model})]);
        return result.rowCount??0;
      });
      // A widespread request/configuration problem must not generate a whole-corpus bisect storm.
      if(failed>=8)throw new Error('archive_sync.embedding_records_failed');
      return;
    }
    if(embedded.length!==group.length)throw new Error('archive_sync.embedding_count');
    const profile=ACTIVE_EMBEDDING_PROFILE;
    const vectors=embedded.map(result=>{
      if(result.provider!==profile.provider||result.model!==profile.model||result.dimensions!==profile.dimensions)
        throw new Error('archive_sync.embedding_profile');
      return serializeEmbeddingVector(result.vector);
    });
    written+=await scoped(client,keyId,async()=>{
      const result=await client.query(`update memories m set embedding=u.vector::vector,
        embedding_provider=$5,embedding_model=$6,embedding_dimensions=$7
        from unnest($2::uuid[],$3::text[],$4::text[],$8::text[]) u(id,vector,content_sha256,content)
        where m.id=u.id and m.client_id=$1 and m.namespace='my-life' and m.source='my-life' and m.access_level='sensitive'
          and m.metadata->'my_life'->>'content_sha256'=u.content_sha256 and m.content=u.content and m.embedding is null
          and m.deleted_at is null and m.superseded_at is null and m.consolidated_into_id is null
          and (m.expires_at is null or m.expires_at>statement_timestamp())
          and m.embedding_provider is null and m.embedding_model is null and m.embedding_dimensions is null`,
        [keyId,group.map(row=>row.id),vectors,group.map(row=>row.content_sha256),profile.provider,profile.model,profile.dimensions,group.map(row=>row.content)]);
      return result.rowCount??0;
    });
    };
    await processRows(rows);
    return {selected:rows.length,written,failed,cursor:rows.at(-1)!.id};
  }finally{client.release();}
}

/** Explicit operator retry after correcting a provider/input problem; no source drive needed. */
export async function retryArchiveFailures(pool:Pool,keyId:string,archiveId:string){
  const client=await pool.connect();const lockName=`my-life-embed:${keyId}:${archiveId}`;let locked=false,total=0;
  let cursor:string|null=null;
  try{
    await assertSafeSyncRole(client);await syncAuth(client,keyId);
    locked=(await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) acquired',[lockName])).rows[0].acquired;
    if(!locked)throw new Error('archive_sync.embedding_already_running');
    for(;;){
      const rows=await scoped(client,keyId,async()=>{
        const result=await client.query(`with targets as (select id from memories where client_id=$1 and namespace='my-life'
          and source='my-life' and source_key like $2 and access_level='sensitive' and embedding is null
          and deleted_at is null and superseded_at is null and consolidated_into_id is null
          and (expires_at is null or expires_at>statement_timestamp()) and metadata->'my_life'->'embedding_failure' is not null
          and ($3::uuid is null or id>$3::uuid)
          order by id limit 500 for update)
          update memories m set metadata=m.metadata #- '{my_life,embedding_failure}' from targets t where m.id=t.id returning m.id`,
          [keyId,archivePrefix(archiveId)+'%',cursor]);return result.rows as {id:string}[];
      });
      total+=rows.length;if(!rows.length)return {event:'archive_sync.failures_reset',records:total};
      cursor=rows.map(row=>row.id).sort().at(-1)!;
    }
  }finally{if(locked)await client.query('select pg_advisory_unlock(hashtextextended($1,0))',[lockName]).catch(()=>{});client.release();}
}

export async function archiveSyncStatus(pool:Pool,keyId:string,archiveId:string){
  const client=await pool.connect();
  try{await assertSafeSyncRole(client);return await scoped(client,keyId,async()=>{
    // Read-only aggregate over the complete archive needs more headroom than an ingest batch.
    await client.query("set local statement_timeout='300s'");
    return {archive_id:archiveId,...(await client.query(`select count(*)::int chunks,
    count(*) filter(where embedding is not null)::int embedded,
    count(*) filter(where embedding is null and access_level='sensitive' and metadata->'my_life'->'embedding_failure' is null)::int pending,
    count(*) filter(where embedding is null and access_level='sensitive' and metadata->'my_life'->'embedding_failure' is not null)::int failed,
    count(*) filter(where access_level<>'sensitive')::int protected,
    case when bool_or(access_level='normal') then 'normal' when bool_or(access_level='sensitive') then 'sensitive'
      when bool_or(access_level='secret') then 'secret' end minimum_access_level,
    count(distinct metadata->'my_life'->>'record_id')::int records
    from memories where client_id=$1 and namespace='my-life' and source='my-life' and source_key like $2 and deleted_at is null
      and superseded_at is null and consolidated_into_id is null and (expires_at is null or expires_at>statement_timestamp())`,
    [keyId,archivePrefix(archiveId)+'%'])).rows[0],sync:(await client.query('select metadata from memories where client_id=$1 and source_key=$2',
      [keyId,`mylife:state:${archiveId}`])).rows[0]?.metadata??null};});}finally{client.release();}
}
