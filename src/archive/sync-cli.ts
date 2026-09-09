import dotenv from 'dotenv';
import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {archiveIdSchema} from './sync-format.js';
import {embedBatchWithProfile,type EmbeddingResult} from '../embedding.js';
import {archiveSyncStatus,assertSafeSyncRole,embedArchiveBatch,receiveArchive,syncAuth} from './sync-store.js';
import {provisionArchiveSync} from './sync-admin.js';

dotenv.config({quiet:true} as dotenv.DotenvConfigOptions);
const log=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');

/** Provider responses and PostgreSQL details may contain source text or secrets. */
export function safeFailureDetails(error:unknown):{http_status?:number;database_code?:string}{
  if(!(error instanceof Error))return {};
  const status=/^(?:Gemini (?:batchEmbedContents|embedContent)|Ollama embed) failed \(([45]\d{2})\):/.exec(error.message);
  const code=(error as Error&{code?:unknown}).code;
  return {...status?{http_status:Number(status[1])}:{},
    ...typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code)?{database_code:code}:{}};
}

/** Serialize request starts across partitions, including retries already waiting. */
export function createEmbeddingPacer(intervalMs:number,now:()=>number=()=>performance.now(),sleep:(ms:number)=>Promise<unknown>=delay){
  if(!Number.isInteger(intervalMs)||intervalMs<0||intervalMs>120000)throw new Error('archive_sync.embedding_interval_limit');
  let nextStart=0,interval=intervalMs,cooldownUntil=0,tail=Promise.resolve();
  return {
    wait(){
      const pending=tail.then(async()=>{
        // A throttled in-flight request can extend the deadline during this wait.
        while(nextStart>now())await sleep(nextStart-now());
        nextStart=now()+interval;
      });
      tail=pending.catch(()=>{});return pending;
    },
    throttle(waitMs:number){
      const time=now();
      // One burst can produce several 429s. Reduce the rate once per cooldown.
      if(time>=cooldownUntil)interval=Math.min(120000,Math.ceil(Math.max(1000,interval)*1.5));
      cooldownUntil=Math.max(cooldownUntil,time+Math.max(60000,waitMs));
      nextStart=Math.max(nextStart,cooldownUntil);
      return {request_interval_ms:interval,cooldown_ms:Math.ceil(cooldownUntil-time)};
    },
  };
}

export function parseSyncArgs(args:string[]){
  const [command,...rest]=args;
  if(!['provision','receive','embed','status'].includes(command))throw new Error('archive_sync.command_required');
  const options=new Map<string,string>();
  const allowed=command==='provision'?['--archive-id','--reader-keys']:command==='embed'
    ?['--archive-id','--key-id','--batch-size','--concurrency','--request-interval-ms']:['--archive-id','--key-id'];
  for(let i=0;i<rest.length;i+=2){
    if(!allowed.includes(rest[i])||!rest[i+1]||rest[i+1].startsWith('--')||options.has(rest[i]))throw new Error('archive_sync.invalid_option');
    options.set(rest[i],rest[i+1]);
  }
  const archiveId=archiveIdSchema.parse(options.get('--archive-id'));
  const keyId=options.get('--key-id')??'';
  if(command!=='provision'&&!/^[-a-f0-9]{36}$/i.test(keyId))throw new Error('archive_sync.key_id_required');
  const batchSize=Number(options.get('--batch-size')??64);
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>100)throw new Error('archive_sync.embedding_batch_limit');
  const concurrency=Number(options.get('--concurrency')??1);embeddingRanges(concurrency);
  const requestIntervalMs=Number(options.get('--request-interval-ms')??1000);createEmbeddingPacer(requestIntervalMs);
  return {command,archiveId,keyId,batchSize,concurrency,requestIntervalMs,readerIds:(options.get('--reader-keys')??'').split(',').filter(Boolean)};
}

export function embeddingRanges(concurrency:number){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('archive_sync.embedding_concurrency_limit');
  const boundary=(n:number)=>Math.floor(n*2**32/concurrency).toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000';
  return Array.from({length:concurrency},(_,i)=>({lower:i===0?null:boundary(i),upper:i===concurrency-1?null:boundary(i+1)}));
}

export async function runEmbeddingWorker(pool:pg.Pool,keyId:string,archiveId:string,batchSize:number,concurrency=1,
  embedder:(texts:string[])=>Promise<EmbeddingResult[]>=embedBatchWithProfile,progress:(value:unknown)=>void=log,requestIntervalMs=1000){
  const ranges=embeddingRanges(concurrency);
  const pacer=createEmbeddingPacer(requestIntervalMs);
  // A separate session lock prevents duplicate provider charges from two workers.
  const lockClient=await pool.connect();let locked=false;
  const lockName=`my-life-embed:${keyId}:${archiveId}`;
  try{
    await assertSafeSyncRole(lockClient);await syncAuth(lockClient,keyId);
    locked=(await lockClient.query('select pg_try_advisory_lock(hashtextextended($1,0)) acquired',[lockName])).rows[0].acquired;
    if(!locked)throw new Error('archive_sync.embedding_already_running');
    const initial=await archiveSyncStatus(pool,keyId,archiveId);
    if(!initial.sync?.manifest||initial.sync.copy_in_progress)throw new Error('archive_sync.completed_copy_required');
    let processed=0,stopped=false;
    for(let pass=0;pass<4;pass++){
      // Disjoint UUID intervals prevent duplicate provider work. Each interval
      // advances by keyset cursor, with no long transaction or database lease.
      const outcomes=await Promise.allSettled(ranges.map(async(range,partition)=>{
        let cursor:string|null=null,attempt=0;
        while(!stopped){
          try{
            const batch=await embedArchiveBatch(pool,keyId,archiveId,batchSize,async texts=>{
              await pacer.wait();
              if(stopped)throw new Error('archive_sync.embedding_stopped');
              return embedder(texts);
            },cursor,range);
            attempt=0;
            if(!batch.selected)return;
            cursor=batch.cursor;processed+=batch.written;
            progress({event:'archive_sync.embedding_progress',processed,partition,cursor});
          }catch(error){
            // Never log provider response bodies, SQL parameters or source text.
            const details=safeFailureDetails(error);
            const permanentHttp=details.http_status!==undefined&&details.http_status<500&&details.http_status!==429&&details.http_status!==408;
            if(permanentHttp||(error instanceof Error&&error.message.startsWith('archive_sync.'))||++attempt>8){
              progress({event:'archive_sync.embedding_failed',partition,...details});
              stopped=true;throw new Error(error instanceof Error&&/^archive_sync\.[a-z_]+$/.test(error.message)
                ?error.message:'archive_sync.embedding_retry_exhausted');
            }
            const waitMs=Math.min(120000,1000*2**attempt)+Math.floor(Math.random()*1000);
            const pacing=details.http_status===429?pacer.throttle(waitMs):{};
            progress({event:'archive_sync.embedding_retry',partition,attempt,wait_ms:waitMs,...details,...pacing});await delay(waitMs);
          }
        }
      }));
      const failure=outcomes.find((outcome):outcome is PromiseRejectedResult=>outcome.status==='rejected');
      if(failure)throw failure.reason;
      const status=await archiveSyncStatus(pool,keyId,archiveId);
      if(!status.sync?.manifest||status.sync.copy_in_progress)throw new Error('archive_sync.completed_copy_required');
      if(status.pending===0){progress({event:'archive_sync.embedding_complete',...status});return;}
      if(pass===3)throw new Error('archive_sync.embedding_nonconvergent');
    }
  }finally{
    if(locked)await lockClient.query('select pg_advisory_unlock(hashtextextended($1,0))',[lockName]).catch(()=>{});
    lockClient.release();
  }
}

async function main(){
  const options=parseSyncArgs(process.argv.slice(2));
  if(!process.env.DATABASE_URL)throw new Error('archive_sync.database_required');
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:Math.max(3,options.concurrency+1)});
  try{
    if(options.command==='provision')log(await provisionArchiveSync(pool,options.archiveId,options.readerIds));
    else if(options.command==='receive')await receiveArchive(pool,process.stdin,options.keyId,options.archiveId,log);
    else if(options.command==='status')log(await archiveSyncStatus(pool,options.keyId,options.archiveId));
    else await runEmbeddingWorker(pool,options.keyId,options.archiveId,options.batchSize,options.concurrency,embedBatchWithProfile,log,options.requestIntervalMs);
  }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{
  const code=error instanceof Error&&/^archive_sync\.[a-z_]+$/.test(error.message)?error.message:'archive_sync.failed';
  process.stderr.write(JSON.stringify({event:code})+'\n');process.exitCode=1;
});
