import assert from 'node:assert/strict';
import test from 'node:test';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {protocolLines,recordSchema,manifestSchema,digest,recordKey,type SyncRecord,type SyncManifest} from '../src/archive/sync-format.js';
import {parseSyncArgs,embeddingRanges,safeFailureDetails,createEmbeddingPacer} from '../src/archive/sync-cli.js';
import {searchNamespaces} from '../src/tools/search.js';

export const fixtureRecord=(id='one',content='Synthetic historical evidence'):SyncRecord=>({
  type:'record',record_id:digest(id),chunk_index:0,origin:'evidence',kind:'email',title:'Synthetic email',content,
  content_sha256:digest(content),record_sha256:digest(content),event_at:'2024-01-01T00:00:00Z',precision:'day',
  source_ids:[digest('source')],evidence_sha256:null,original_bytes_rechecked:false,
});
export const fixtureManifest=(asOf='2026-01-01T00:00:00.000Z'):SyncManifest=>({type:'manifest',format:'my-life-evidence-v1',
  archive_id:'synthetic-archive',snapshot_id:randomUUID(),as_of:asOf,scope:'published_parsed_archive',raw_exports_included:false});
export function fixtureStream(manifest:SyncManifest,rows:SyncRecord[],mutate?:(complete:any)=>void){
  const body=[manifest,...rows].map(row=>JSON.stringify(row)+'\n').join('');
  const complete={type:'complete',records:new Set(rows.map(row=>row.record_id)).size,chunks:rows.length,sha256:digest(body),
    coverage:{evidence:{status:'exported',records:new Set(rows.map(row=>row.record_id)).size},
      calendar_occurrence:{status:'exported',records:0},photo_media:{status:'exported',records:0},
      photo_sidecar:{status:'exported',records:0},timeline_event:{status:'exported',records:0},structured_record:{status:'not_installed',records:0}},
    exclusions:['raw_export_files','binary_media','attachment_bytes','unparsed_files','unpublished_or_removed_sources']};
  mutate?.(complete);return Readable.from([body+JSON.stringify(complete)+'\n']);
}

test('wire format rejects raw locators, invalid hashes and overlong UTF-8 payloads',()=>{
  const row=fixtureRecord();assert.ok(recordSchema.safeParse(row).success);
  for(const bad of [{...row,locator:{path:'raw'}},{...row,content:'changed'},{...row,original_bytes_rechecked:true},
    fixtureRecord('big','🌏'.repeat(1501)),{...row,source_ids:['raw/path']}])assert.ok(!recordSchema.safeParse(bad).success);
  assert.ok(!manifestSchema.safeParse({...fixtureManifest(),raw_exports_included:true}).success);
  assert.notEqual(recordKey(fixtureManifest(),row),recordKey({...fixtureManifest(),archive_id:'different'},row));
});

test('archive search is explicit and cannot add an unauthorized namespace',()=>{
  assert.deepEqual(searchNamespaces(undefined,['personal','my-life']),['personal']);
  assert.deepEqual(searchNamespaces([],['personal','my-life']),['personal']);
  assert.deepEqual(searchNamespaces(['personal','my-life'],['personal','my-life']),['personal','my-life']);
  assert.deepEqual(searchNamespaces(['my-life'],['work']),[]);
});
test('bounded parser preserves multi-byte boundaries and rejects incomplete lines',async()=>{
  const bytes=Buffer.from('{"text":"🌏"}\n');const parts=[bytes.subarray(0,11),bytes.subarray(11,12),bytes.subarray(12)];
  assert.deepEqual(await Array.fromAsync(protocolLines(Readable.from(parts))),['{"text":"🌏"}']);
  for(const bytes of [Buffer.from('unfinished'),Buffer.from('\n'),Buffer.alloc(65538,65),Buffer.from([0xff,10])]){
    await assert.rejects(async()=>{for await(const _line of protocolLines(Readable.from([bytes]))){};});
  }
});
test('CLI requires explicit operation, archive and key; no default access grants',()=>{
  assert.equal(parseSyncArgs(['status','--archive-id','test','--key-id',randomUUID()]).command,'status');
  for(const args of [[],['receive'],['embed','--archive-id','a','--key-id',randomUUID(),'--batch-size','1000'],
    ['provision','--archive-id','a','--key-id',randomUUID()]])assert.throws(()=>parseSyncArgs(args));
});
test('parallel embedding partitions cover the UUID space without gaps or overlap',()=>{
  for(let concurrency=1;concurrency<=8;concurrency++){
    const ranges=embeddingRanges(concurrency);assert.equal(ranges[0].lower,null);assert.equal(ranges.at(-1)!.upper,null);
    for(let i=1;i<ranges.length;i++)assert.equal(ranges[i-1].upper,ranges[i].lower);
  }
  for(const value of [0,9,1.5,NaN])assert.throws(()=>embeddingRanges(value));
  assert.throws(()=>parseSyncArgs(['embed','--archive-id','test','--key-id',randomUUID(),'--concurrency','9']));
});
test('failure diagnostics retain codes without exposing provider responses or database details',()=>{
  assert.deepEqual(safeFailureDetails(new Error('Gemini batchEmbedContents failed (429): {"private":"DO_NOT_LOG"}')),{http_status:429});
  assert.deepEqual(safeFailureDetails(Object.assign(new Error('private source text'),{code:'23514',detail:'DO_NOT_LOG'})),{database_code:'23514'});
  assert.deepEqual(safeFailureDetails(new Error('unclassified private response')),{});
  assert.deepEqual(safeFailureDetails('DO_NOT_LOG'),{});
});

test('shared pacer spaces concurrent requests and applies one slowdown per throttled burst',async()=>{
  let time=0;const waits:number[]=[];
  const pacer=createEmbeddingPacer(4000,()=>time,async ms=>{waits.push(ms);time+=ms;});
  await Promise.all([pacer.wait(),pacer.wait(),pacer.wait()]);
  assert.deepEqual(waits,[4000,4000]);
  assert.deepEqual(pacer.throttle(2000),{request_interval_ms:6000,cooldown_ms:60000});
  assert.deepEqual(pacer.throttle(3000),{request_interval_ms:6000,cooldown_ms:60000});
  await pacer.wait();assert.equal(time,68000);
  await pacer.wait();assert.equal(time,74000);
  assert.equal(pacer.throttle(2000).request_interval_ms,9000);
  for(const value of [-1,120001,0.1,NaN])assert.throws(()=>createEmbeddingPacer(value));
});

test('a cooldown extends requests that were already queued',async()=>{
  let time=0;const waits:number[]=[];
  const pacer=createEmbeddingPacer(1000,()=>time,async ms=>{
    waits.push(ms);if(waits.length===1)pacer.throttle(2000);time+=ms;
  });
  await pacer.wait();await pacer.wait();
  assert.deepEqual(waits,[1000,59000]);assert.equal(time,60000);
});

test('pacing recovers after sustained success but ignores stale requests and never exceeds configured rate',async()=>{
  let time=0;const pacer=createEmbeddingPacer(4000,()=>time,async ms=>{time+=ms;});
  const oldGeneration=await pacer.wait();pacer.throttle(2000);
  time=60000;
  for(let i=0;i<20;i++)pacer.succeeded(oldGeneration);
  assert.equal(pacer.intervalMs(),6000,'pre-throttle requests cannot prove recovery');
  for(let i=0;i<8;i++)pacer.succeeded(await pacer.wait());
  assert.equal(pacer.intervalMs(),4800);
  time+=60000;
  for(let i=0;i<8;i++)pacer.succeeded(await pacer.wait());
  assert.equal(pacer.intervalMs(),4000);
  for(let i=0;i<40;i++)pacer.succeeded(await pacer.wait());
  assert.equal(pacer.intervalMs(),4000);
});
