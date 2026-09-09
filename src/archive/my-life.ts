import { z } from 'zod';
import { archiveResultSchema,ProviderError,type ArchiveProvider,type ContextSearch } from './contract.js';

export interface MyLifeConfig { url:string; token:string; archiveId:string; timeoutMs?:number; }
export function validateMyLifeConfig(config:MyLifeConfig):MyLifeConfig {
  const url=new URL(config.url);
  if(url.protocol!=='http:' || !['127.0.0.1','[::1]'].includes(url.hostname)
    ||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname)
    ||config.token.length<32||config.token.length>256||!config.archiveId||config.archiveId.length>512
    ||!Number.isInteger(config.timeoutMs??10000)||(config.timeoutMs??10000)<100||(config.timeoutMs??10000)>30000)
    throw new Error('Invalid My Life gateway configuration');
  return config;
}
export class MyLifeProvider implements ArchiveProvider {
  constructor(private readonly config:MyLifeConfig,private readonly request:typeof fetch=fetch){validateMyLifeConfig(config);}
  private async call(operation:string,input:unknown):Promise<Record<string,unknown>>{
    try{
      const response=await this.request(new URL(`/api/retrieval/${operation}`,this.config.url),{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(this.config.timeoutMs??10000),
        headers:{authorization:`Bearer ${this.config.token}`,'content-type':'application/json'},body:JSON.stringify(input),
      });
      if(response.status===401||response.status===403)throw new ProviderError('not_authorized');
      if(response.status===404)throw new ProviderError(operation==='recall'?'not_found':'not_configured');
      if(!response.ok)throw new ProviderError('provider_error');
      if(!response.body)throw new ProviderError('invalid_response');
      const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
        if(size>256*1024)throw new ProviderError('invalid_response');chunks.push(value);}}
      finally{await reader.cancel();}
      const body=z.object({schema_version:z.literal(1),archive_id:z.literal(this.config.archiveId)}).passthrough()
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return body;
    }catch(error){
      if(error instanceof ProviderError)throw error;
      if(error instanceof z.ZodError||error instanceof SyntaxError)throw new ProviderError('invalid_response');
      if(error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError'))throw new ProviderError('timeout');
      throw new ProviderError('offline');
    }
  }
  async search(input:ContextSearch){
    const data=await this.call('search',{...input.archive_filters,query:input.query,limit:input.limit});
    const parsed=z.object({results:z.array(z.unknown()).max(20),coverage:z.unknown(),truncated:z.boolean().default(false),partial:z.boolean().default(false)}).safeParse(data);
    if(!parsed.success)throw new ProviderError('invalid_response');
    const results=[];let invalid=0;
    for(const candidate of parsed.data.results){
      const result=archiveResultSchema.safeParse(candidate);
      if(!result.success){invalid++;continue;}
      if(result.data.citation.archive_id!==this.config.archiveId)throw new ProviderError('invalid_response');
      results.push(result.data);
    }
    return {results,coverage:{archive:parsed.data.coverage,invalid_results_skipped:invalid},truncated:parsed.data.truncated,partial:parsed.data.partial||invalid>0};
  }
  async recall(ref:string){
    const parsed=z.object({result:archiveResultSchema}).safeParse(await this.call('recall',{ref}));
    if(!parsed.success||parsed.data.result.ref!==ref||parsed.data.result.citation.archive_id!==this.config.archiveId)
      throw new ProviderError('invalid_response');
    return parsed.data.result;
  }
  async status(){return this.call('status',{});}
}
