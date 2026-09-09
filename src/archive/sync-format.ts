import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Readable} from 'node:stream';

export const SYNC_NAMESPACE='my-life';
export const SYNC_FORMAT='my-life-evidence-v1';
export const digest=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const archiveIdSchema=z.string().regex(/^[-a-zA-Z0-9_:]{1,128}$/);
const originSchema=z.enum(['evidence','calendar_occurrence','photo_media','photo_sidecar','timeline_event','structured_record']);
export const manifestSchema=z.object({type:z.literal('manifest'),format:z.literal(SYNC_FORMAT),
  archive_id:archiveIdSchema,snapshot_id:z.string().uuid(),as_of:z.string().datetime(),
  scope:z.literal('published_parsed_archive'),raw_exports_included:z.literal(false)}).strict();
export const recordSchema=z.object({type:z.literal('record'),record_id:sha,chunk_index:z.number().int().min(0).max(1000000),
  origin:originSchema,kind:z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  title:z.string().max(1024),content:z.string().min(1).refine(value=>Buffer.byteLength(value,'utf8')<=6000),
  content_sha256:sha,record_sha256:sha,event_at:z.string().datetime().nullable(),
  precision:z.enum(['instant','day','month','year','unknown']),source_ids:z.array(sha).min(1).max(256),
  evidence_sha256:sha.nullable(),original_bytes_rechecked:z.literal(false),
}).strict().refine(value=>digest(value.content)===value.content_sha256);
const exported=z.object({status:z.literal('exported'),records:z.number().int().nonnegative()}).strict();
export const completeSchema=z.object({type:z.literal('complete'),records:z.number().int().nonnegative(),
  chunks:z.number().int().nonnegative(),sha256:sha,
  coverage:z.object({evidence:exported,calendar_occurrence:exported,photo_media:exported,photo_sidecar:exported,timeline_event:exported,
    structured_record:z.union([exported,z.object({status:z.literal('not_installed'),records:z.literal(0)}).strict()])}).strict(),
  exclusions:z.array(z.enum(['raw_export_files','binary_media','attachment_bytes','unparsed_files','unpublished_or_removed_sources'])),
}).strict();
export type SyncManifest=z.infer<typeof manifestSchema>;
export type SyncRecord=z.infer<typeof recordSchema>;
export type SyncComplete=z.infer<typeof completeSchema>;
export const archivePrefix=(id:string)=>`mylife:v1:${digest(id)}:`;
export const recordKey=(manifest:SyncManifest,record:SyncRecord)=>`${archivePrefix(manifest.archive_id)}${record.record_id}:${record.chunk_index}`;

/** Bounded line and UTF-8 validation before JSON parsing. No plaintext spool file. */
export async function* protocolLines(input:Readable):AsyncGenerator<string>{
  let pending=Buffer.alloc(0);
  const decoder=new TextDecoder('utf-8',{fatal:true});
  for await(const chunk of input){
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    let start=0;
    for(let i=0;i<bytes.length;i++)if(bytes[i]===10){
      const part=bytes.subarray(start,i);
      if(pending.length+part.length>65536)throw new Error('archive_sync.line_limit');
      const line=decoder.decode(Buffer.concat([pending,part]));pending=Buffer.alloc(0);start=i+1;
      if(!line)throw new Error('archive_sync.empty_line');
      yield line;
    }
    const rest=bytes.subarray(start);
    if(pending.length+rest.length>65536)throw new Error('archive_sync.line_limit');
    pending=Buffer.concat([pending,rest]);
  }
  if(pending.length)throw new Error('archive_sync.truncated_line');
}
