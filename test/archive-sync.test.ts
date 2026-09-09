import assert from 'node:assert/strict';
import test from 'node:test';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {protocolLines,recordSchema,manifestSchema,digest,recordKey,type SyncRecord,type SyncManifest} from '../src/archive/sync-format.js';
import {parseSyncArgs,embeddingRanges} from '../src/archive/sync-cli.js';

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
