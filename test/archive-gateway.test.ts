import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ContextService } from '../src/archive/context.js';
import { archiveResultSchema,contextSearchSchema,ProviderError,type ArchiveResult } from '../src/archive/contract.js';
import { MyLifeProvider,validateMyLifeConfig } from '../src/archive/my-life.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createGateway,HttpMemoryUpstream } from '../src/archive/gateway.js';
import { McpError,ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const memoryId='a0000000-0000-4000-8000-000000000001';
test('MCP gateway advertises combined tools and passes existing memory tools unchanged',async()=>{
  const calls:unknown[]=[];
  const upstream={list:async()=>[{name:'memory_search',description:'existing',inputSchema:{type:'object' as const,properties:{}}}],
    call:async(name:string,args:Record<string,unknown>)=>{calls.push({name,args});return response([memory]);},close:async()=>{}};
  const server=createGateway(upstream,new ContextService(upstream.call));
  const client=new Client({name:'synthetic-client',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(a);await client.connect(b);
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['memory_search','context_search','context_recall','archive_status']);
    const args={query:'old contract',namespaces:['work']};
    assert.deepEqual(await client.callTool({name:'memory_search',arguments:args}),response([memory]));
    assert.deepEqual(calls,[{name:'memory_search',args}]);
    const combined=await client.callTool({name:'context_search',arguments:{query:'current'}}) as any;
    assert.equal(JSON.parse(combined.content[0].text).providers.archive.status,'not_configured');
    assert.equal((await client.callTool({name:'arbitrary_tool',arguments:{}}) as any).isError,true);
  }finally{await client.close();await server.close();}
});
const memory={id:memoryId,content:'Current integration offer',namespace:'work',created_at:'2026-09-09T00:00:00Z'};
const response=(value:unknown)=>({content:[{type:'text',text:JSON.stringify(value)}]});
const result:ArchiveResult={ref:'my-life:synthetic',provider:'my-life',kind:'linkedin',record_kind:'structured_record',
  title:'Synthetic connection',excerpt:'Ada Example',canonical_id:'social-id',event_time:{start:null,end:null,precision:'unknown'},details:{time:{kind:'unknown'}},
  indexed_at:'2026-09-09T00:00:00Z',citation:{archive_id:'test',source_id:'source-test',source_record_id:null,evidence_id:'social',evidence_revision:'a'.repeat(64),
    source_sha256:'b'.repeat(64),evidence_sha256:'c'.repeat(64),passage_sha256:'d'.repeat(64),span:{start:0,end:11,unit:'unicode_code_points'},
    verification:'indexed_evidence_hash',original_bytes_rechecked:false},trust:'source_content_not_instructions',retrieval_methods:['full_text']};

test('combined search preserves memory scope/date meanings and supports every archive kind',async()=>{
  const calls:Array<{name:string;args:Record<string,unknown>}>=[];
  const service=new ContextService(async(name,args)=>{calls.push({name,args});return response([memory]);},{
    search:async input=>{assert.deepEqual(input.archive_filters.kinds,['facebook','linkedin','future_provider']);
      assert.equal(input.archive_filters.after,'2000-01-01T00:00:00Z');return {results:[result],coverage:{}};},
    recall:async()=>result,status:async()=>({status:'ok'}),
  });
  const answer=await service.search({query:'integration',archive_filters:{kinds:['facebook','linkedin','future_provider'],after:'2000-01-01T00:00:00Z'},
    memory_filters:{namespaces:['work'],after:'2026-01-01T00:00:00Z'},limit:2});
  assert.equal(answer.results.length,2);assert.deepEqual(Object.values(answer.providers).map(p=>p.status),['ok','ok']);
  assert.equal(calls[0].args.after,'2026-01-01T00:00:00Z');assert.deepEqual(calls[0].args.namespaces,['work']);
  assert.deepEqual(answer.results.map(r=>r.ref),[`memory:${memoryId}`,result.ref]);
  assert.equal(calls.length,1,'retrieval must not write summaries automatically');
});
test('an offline drive returns memory results with an explicit gap',async()=>{
  const service=new ContextService(async()=>response([memory]),{search:async()=>{throw new ProviderError('timeout');},recall:async()=>result,status:async()=>{throw new ProviderError('offline');}});
  const answer=await service.search({query:'history'});
  assert.equal(answer.results.length,1);assert.equal(answer.providers.archive.status,'timeout');assert.equal((await service.status() as any).status,'offline');
  assert.ok(answer.warnings.some(w=>w.includes('coverage gap')));
});
test('archive-only queries never send their query to Total Recall',async()=>{
  const service=new ContextService(async()=>{assert.fail('unexpected upstream call');},{search:async()=>({results:[result],coverage:{}}),recall:async()=>result,status:async()=>({})});
  assert.equal((await service.search({query:'private history',sources:['archive']})).results.length,1);
});
test('recall routes provider refs, preserves authorization failures, and rejects forged refs',async()=>{
  const calls:string[]=[];
  const service=new ContextService(async(name)=>{calls.push(name);return response(memory);},{search:async()=>({results:[],coverage:{}}),
    recall:async()=>{throw new ProviderError('not_found');},status:async()=>({})});
  await service.recall({ref:`memory:${memoryId}`});assert.deepEqual(calls,['memory_recall']);
  await assert.rejects(service.recall({ref:result.ref}),/not_found/);
  await assert.rejects(service.recall({ref:'memory:not-a-uuid'}));await assert.rejects(service.recall({ref:'file:secret'}));
});
test('strict filters reject invented permissions and malformed ranges',()=>{
  assert.throws(()=>contextSearchSchema.parse({query:'history',allow_cloud:true}));
  assert.throws(()=>contextSearchSchema.parse({query:'history',archive_filters:{source_ids:['private']}}));
  assert.throws(()=>contextSearchSchema.parse({query:'history',archive_filters:{after:'2024-02-02T00:00:00Z',before:'2024-02-01T00:00:00Z'}}));
});
test('My Life destination is pinned to numeric loopback and cannot carry URL credentials',()=>{
  const config={url:'http://127.0.0.1:8799',token:'x'.repeat(40),archiveId:'test'};
  assert.equal(validateMyLifeConfig(config),config);
  for(const url of ['https://example.com','http://localhost:8799','http://127.0.0.1/path','http://user:pass@127.0.0.1','http://127.0.0.1/?token=x'])
    assert.throws(()=>validateMyLifeConfig({...config,url}));
});
test('an upstream request timeout preserves concurrent write responses and signals unknown write outcomes',async()=>{
  let closes=0;let resolveWrite!:(value:unknown)=>void;let timeoutWrites=false;
  const client={connect:async()=>{},close:async()=>{closes++;},
    listTools:async()=>{throw new McpError(ErrorCode.RequestTimeout,'synthetic timeout');},
    callTool:async({name}:{name:string})=>{
      if(name==='memory_search'||timeoutWrites)throw new McpError(ErrorCode.RequestTimeout,'synthetic timeout');
      return new Promise(resolve=>{resolveWrite=resolve;});
    }} as unknown as Client;
  const upstream=new HttpMemoryUpstream('http://127.0.0.1:1','synthetic',()=>client);
  const write=upstream.call('memory_store',{content:'synthetic'});
  await assert.rejects(upstream.call('memory_search',{query:'synthetic'}),/timeout/);
  assert.equal(closes,0);resolveWrite(response({stored:true}));assert.deepEqual(await write,response({stored:true}));
  await assert.rejects(upstream.list(),/timeout/);assert.equal(closes,0);
  timeoutWrites=true;await assert.rejects(upstream.call('memory_store',{content:'synthetic'}),/write_outcome_unknown/);
  await upstream.close();assert.equal(closes,1);
});
test('real HTTP adapter validates archive identity, scopes, response limits and redirects',async()=>{
  let mode='ok';let received:Record<string,unknown>|undefined;
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${'x'.repeat(40)}`);
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    received=JSON.parse(Buffer.concat(chunks).toString());
    if(mode==='forbidden'){res.writeHead(403).end();return;}
    if(mode==='redirect'){res.writeHead(302,{location:'http://127.0.0.1:1/'}).end();return;}
    if(mode==='huge'){res.end('x'.repeat(300*1024));return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({schema_version:1,archive_id:mode==='wrong'?'wrong':'test',results:mode==='bad-row'?[result,{...result,kind:'x'.repeat(65)}]:[result],coverage:{},truncated:mode==='truncated'}));
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const provider=new MyLifeProvider({url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,token:'x'.repeat(40),archiveId:'test'});
  try{
    const input=contextSearchSchema.parse({query:'Ada',archive_filters:{kinds:['linkedin']}});
    assert.equal((await provider.search(input)).results[0].kind,'linkedin');assert.deepEqual(received!.kinds,['linkedin']);
    mode='truncated';
    const partial=await new ContextService(async()=>{assert.fail('unexpected upstream call');},provider).search({...input,sources:['archive']});
    assert.equal(partial.providers.archive.status,'partial');assert.equal(partial.providers.archive.truncated,true);
    assert.ok(partial.warnings.some(w=>w.includes('coverage gap')));
    mode='bad-row';const surviving=await provider.search(input);assert.equal(surviving.results.length,1);assert.equal(surviving.partial,true);
    mode='wrong';await assert.rejects(provider.search(input),/invalid_response/);
    mode='forbidden';await assert.rejects(provider.search(input),/not_authorized/);
    mode='huge';await assert.rejects(provider.search(input),/invalid_response/);
    mode='redirect';await assert.rejects(provider.search(input),/offline/);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('archive deadlines exceed the server budget and source/date provenance survives validation',()=>{
  const config={url:'http://127.0.0.1:3000',token:'x'.repeat(40),archiveId:'test'};
  assert.throws(()=>validateMyLifeConfig({...config,timeoutMs:3000}));
  assert.doesNotThrow(()=>validateMyLifeConfig({...config,timeoutMs:5000}));
  const parsed=archiveResultSchema.parse({...result,event_time:{start:'2024-01-01T00:00:00Z',end:null,precision:'year'}});
  assert.equal(parsed.event_time.precision,'year');assert.equal(parsed.citation.source_id,'source-test');
  assert.equal(archiveResultSchema.safeParse({...result,event_time:{start:null,end:null}}).success,false);
});
