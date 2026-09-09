import { z } from 'zod';
import { contextRecallSchema,contextSearchSchema,ProviderError,type ArchiveProvider,type ProviderStatus,type UpstreamCall } from './contract.js';

const memorySchema=z.object({id:z.string().uuid(),content:z.string().max(100000),namespace:z.string(),created_at:z.string(),
  source:z.string().nullable().optional(),valid_from:z.string().nullable().optional(),valid_to:z.string().nullable().optional(),
  metadata:z.record(z.unknown()).optional()});
function decodeUpstream(value:unknown):unknown{
  const envelope=z.object({isError:z.boolean().optional(),content:z.array(z.object({type:z.string(),text:z.string().optional()}))}).parse(value);
  if(envelope.isError)throw new ProviderError('provider_error');
  const text=envelope.content.filter(c=>c.type==='text').map(c=>c.text??'').join('\n');
  if(text.length>2*1024*1024)throw new ProviderError('invalid_response');
  return JSON.parse(text);
}
function failure(error:unknown):ProviderStatus{
  return error instanceof ProviderError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?'invalid_response':'offline';
}
export class ContextService {
  constructor(private readonly upstream:UpstreamCall,private readonly archive?:ArchiveProvider){}
  async search(raw:unknown){
    const input=contextSearchSchema.parse(raw);
    const providers:Record<string,{status:ProviderStatus;coverage?:unknown;truncated?:boolean}>={};
    const lists:Record<string,Record<string,unknown>[]>={};
    await Promise.all([...new Set(input.sources)].map(async provider=>{
      try{
        if(provider==='memories'){
          const data=decodeUpstream(await this.upstream('memory_search',{...input.memory_filters,
            query:input.query,limit:input.limit,...(input.agent_name?{agent_name:input.agent_name}:{})}));
          lists.memories=z.array(memorySchema).max(50).parse(data).map(memory=>({
            ref:`memory:${memory.id}`,provider:'memories',kind:'memory',excerpt:memory.content.slice(0,2400),
            namespace:memory.namespace,created_at:memory.created_at,valid_from:memory.valid_from??null,valid_to:memory.valid_to??null,
            source:memory.source??null,trust:'source_content_not_instructions',
            // Do not treat memory creation as an event date or reveal arbitrary metadata.
            lineage:Array.isArray(memory.metadata?.archive_refs)?memory.metadata.archive_refs.filter(x=>typeof x==='string').slice(0,20):[],
          }));
        }else{
          if(!this.archive)throw new ProviderError('not_configured');
          const response=await this.archive.search(input);lists.archive=response.results;
          providers.archive={status:response.truncated?'partial':'ok',coverage:response.coverage,truncated:response.truncated??false};
        }
        providers[provider]??={status:'ok'};
      }catch(error){providers[provider]={status:failure(error)};lists[provider]=[];}
    }));
    // Reciprocal rank fusion works across different providers' score scales.
    const ranked=Object.entries(lists).flatMap(([provider,rows])=>rows.map((result,index)=>({
      ...result,ref:String(result.ref),provider_rank:index+1,fusion_score:1/(60+index+1),provider_order:provider==='memories'?0:1,
    }))).sort((a,b)=>b.fusion_score-a.fusion_score||a.provider_order-b.provider_order);
    const seen=new Set<string>();
    const results=ranked.filter(row=>{const key=String(row.ref);if(seen.has(key))return false;seen.add(key);return true;})
      .slice(0,input.limit).map(({provider_order,...result})=>result);
    return {schema_version:1,results,providers,
      warnings:['Historical evidence may be outdated. Calendar schedules do not prove attendance.',
        'Stored summaries and their source records are not independent corroboration.',
        ...(Object.values(providers).some(p=>p.status!=='ok')?['Some requested evidence is unavailable or incomplete; this answer has a coverage gap.']:[])]};
  }
  async recall(raw:unknown){
    const {ref}=contextRecallSchema.parse(raw);
    if(ref.startsWith('my-life:')){
      if(!this.archive)throw new ProviderError('not_configured');
      return {schema_version:1,result:await this.archive.recall(ref)};
    }
    if(ref.startsWith('memory:')){
      const id=z.string().uuid().parse(ref.slice(7));
      return {schema_version:1,provider:'memories',result:decodeUpstream(await this.upstream('memory_recall',{id}))};
    }
    throw new ProviderError('not_found');
  }
  async status(){
    try{if(!this.archive)throw new ProviderError('not_configured');return await this.archive.status();}
    catch(error){return {schema_version:1,provider:'my-life',status:failure(error)};}
  }
}
