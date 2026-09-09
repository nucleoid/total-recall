import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema,ListToolsRequestSchema,type Tool } from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CONTEXT_TOOLS,ProviderError } from './contract.js';
import { ContextService } from './context.js';
import { MyLifeProvider } from './my-life.js';

const PASSTHROUGH=new Set(['memory_search','memory_recall','memory_store','memory_update','memory_store_document',
  'memory_store_session','memory_session_status','memory_list','memory_list_namespaces','memory_stats','memory_forget',
  'memory_export','memory_import','memory_graph','media_search','agent_register','agent_list',
  'agent_subscribe','agent_list_subscriptions','agent_unsubscribe']);
export interface MemoryUpstream {
  list():Promise<Tool[]>;call(name:string,args:Record<string,unknown>):Promise<any>;close():Promise<void>;
}
/** Lazy connection: the archive works even while the remote memory service is down. */
export class HttpMemoryUpstream implements MemoryUpstream {
  private client?:Client;private connecting?:Promise<Client>;
  constructor(private readonly url:string,private readonly key:string){
    const target=new URL(url);
    if((target.protocol!=='https:'&&!(target.protocol==='http:'&&['127.0.0.1','[::1]'].includes(target.hostname)))
      ||target.username||target.password||target.search||target.hash||!key)throw new Error('Invalid Total Recall upstream configuration');
  }
  private async connected():Promise<Client>{
    if(this.client)return this.client;
    if(!this.connecting)this.connecting=(async()=>{
      const client=new Client({name:'total-recall-local-gateway',version:'1.0.0'});
      try{
        const transport=new StreamableHTTPClientTransport(new URL(this.url),{requestInit:{headers:{authorization:`Bearer ${this.key}`}},
          fetch:((url,init)=>fetch(url,{...init,redirect:'error',signal:init?.signal
            ?AbortSignal.any([init.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)})) as typeof fetch});
        await client.connect(transport,{timeout:15000});this.client=client;return client;
      }catch{await client.close().catch(()=>{});throw new ProviderError('offline');}
    })().finally(()=>{this.connecting=undefined;});
    return this.connecting;
  }
  async list(){try{return(await(await this.connected()).listTools({}, {timeout:15000})).tools;}
    catch(error){await this.close();throw error;}}
  async call(name:string,args:Record<string,unknown>){
    // No retry: a failed write response does not imply the upstream write failed.
    try{return await(await this.connected()).callTool({name,arguments:args},undefined,{timeout:20000});}
    catch(error){await this.close();throw error;}
  }
  async close(){const client=this.client;this.client=undefined;await client?.close().catch(()=>{});}
}

export function createGateway(upstream:MemoryUpstream,context:ContextService):Server{
  const server=new Server({name:'total-recall',version:'1.0.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>{
    let tools:Tool[]=[];
    try{tools=(await upstream.list()).filter(tool=>PASSTHROUGH.has(tool.name));}catch{/* Combined tools remain available offline. */}
    return {tools:[...tools,...CONTEXT_TOOLS]};
  });
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    try{
      const {name,arguments:args={}}=request.params;
      if(PASSTHROUGH.has(name))return await upstream.call(name,args);
      const result=name==='context_search'?await context.search(args):name==='context_recall'?await context.recall(args)
        :name==='archive_status'?(z.object({}).strict().parse(args),await context.status()):null;
      if(result===null)throw new ProviderError('not_found');
      return {content:[{type:'text' as const,text:JSON.stringify(result)}]};
    }catch(error){return {isError:true,content:[{type:'text' as const,text:JSON.stringify({
      error:error instanceof ProviderError?error.status:error instanceof z.ZodError?'invalid_request':'provider_unavailable'})}]};}
  });
  return server;
}

async function main(){
  // Dedicated stdio process per configured client. No DB access or archive mount.
  const upstream=new HttpMemoryUpstream(process.env.TOTAL_RECALL_UPSTREAM_URL??'',process.env.TOTAL_RECALL_API_KEY??'');
  const archive=process.env.MYLIFE_RETRIEVAL_URL?new MyLifeProvider({url:process.env.MYLIFE_RETRIEVAL_URL,
    token:process.env.MYLIFE_RETRIEVAL_TOKEN??'',archiveId:process.env.MYLIFE_ARCHIVE_ID??''}):undefined;
  const server=createGateway(upstream,new ContextService((name,args)=>upstream.call(name,args),archive));
  const stop=async()=>{await server.close();await upstream.close();};
  process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
  await server.connect(new StdioServerTransport());
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){
  main().catch(()=>{process.stderr.write('Total Recall gateway could not start. Check its operator configuration.\n');process.exitCode=1;});
}
