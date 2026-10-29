import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { platform } from 'node:os';
import { Readable } from 'node:stream';
import test from 'node:test';
import { LocalEmbeddingClient, LocalEmbeddingError } from '../src/local-embedding-client.js';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import { LocalEmbeddingGateway, type GatewayReceipt } from '../src/local-embedding-gateway.js';

const secret='s'.repeat(32);
const receipt=():GatewayReceipt=>({
  contractId:QWEN_CONTRACT_ID,artifactSha256:QWEN_CHUNK_CONTRACT.artifactSha256,
  runtimeContract:QWEN_CHUNK_CONTRACT.runtimeContract,acceptanceReceiptSha256:'a'.repeat(64),build:'b11669',
  binarySha256:createHash('sha256').update('binary').digest('hex'),binaryPath:'/fixed/runtime/llama-server',
  runtimeRoot:'/fixed/runtime',runtimeFiles:[{path:'llama-server',sha256:createHash('sha256').update('binary').digest('hex')}],
  ggufPath:'/fixed/model',hostId:'validator-1',mode:'cpu',authorizedUntil:new Date(Date.now()+60_000).toISOString(),
  persistentCpuApproved:true,host:platform()==='win32'
    ?{platform:'win32',diskPath:'C:\\',minimumAvailableBytes:2*1024**3,minimumDiskFreeBytes:100*1024**3,maximumSwapUsedBytes:0,maximumCpuUtilizationPercent:80}
    :{platform:'linux',diskPath:'/',minimumAvailableBytes:2*1024**3,minimumDiskFreeBytes:100*1024**3,maximumSwapUsedBytes:0,maximumLoad1:1},
  cpu:{maximumMemoryPsiAvg10:1},
});

function healthy(r:GatewayReceipt){return{hostId:r.hostId,mode:'cpu' as const,timestamp:Date.now(),availableBytes:3*1024**3,
  diskFreeBytes:101*1024**3,swapUsedBytes:0,memoryPsiAvg10:0,...(r.host.platform==='win32'?{cpuUtilizationPercent:0}:{load1:0})};}

function gatewayFetch(gateway:LocalEmbeddingGateway,onCall:(status?:number,body?:string)=>void):typeof fetch{return (async(input,init)=>{
  onCall();const raw=typeof init?.body==='string'?init.body:'';const req=Readable.from(raw?[raw]:[]) as any;
  const target=new URL(String(input));req.method=init?.method??'GET';req.url=target.pathname;
  const headers=new Headers(init?.headers);req.headers=Object.fromEntries(headers.entries());
  if(raw)req.headers['content-length']=String(Buffer.byteLength(raw));
  let status=0,body='';const responseHeaders:Record<string,string>={};
  const res={writeHead:(value:number,values?:Record<string,string>)=>{status=value;Object.assign(responseHeaders,values);},end:(value='')=>{body=String(value);}} as any;
  await(gateway as any).handle(req,res);onCall(status,body);return new Response(body,{status,headers:responseHeaders});
}) as typeof fetch;}

async function runPairedOrder(firstRole:'document'|'query'){
  const r=receipt();let release!:()=>void,admitted!:()=>void;
  const hold=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{admitted=resolve;});
  let upstream=0;
  const gateway=new LocalEmbeddingGateway(r,Buffer.from(secret),19000,{commonTelemetry:async()=>healthy(r),telemetry:async()=>healthy(r),
    fetch:(async(target:string|URL|Request)=>{upstream++;if(upstream===1){admitted();await hold;}
      if(String(target).endsWith('/tokenize'))return Response.json({tokens:[1]});
      return Response.json({data:[{index:0,embedding:[1,...Array(QWEN_CHUNK_CONTRACT.nativeDimensions-1).fill(0)]}],usage:{prompt_tokens:1}});
    }) as typeof fetch});
  (gateway as any).backendSecret=Buffer.from('b'.repeat(32));
  const runtime={contractId:QWEN_CONTRACT_ID,artifactSha256:QWEN_CHUNK_CONTRACT.artifactSha256,
    runtimeContract:QWEN_CHUNK_CONTRACT.runtimeContract,acceptanceReceiptSha256:'a'.repeat(64)};
  let documentRequests=0,queryRequests=0,documentGuards=0,queryGuards=0;const responses:string[]=[];
  const document=new LocalEmbeddingClient({baseUrl:'http://127.0.0.1:18489',bearerToken:secret,runtime,
    beforeInference:async()=>{documentGuards++;},fetch:gatewayFetch(gateway,(status,body)=>{if(status===undefined)documentRequests++;else responses.push(`${status}:${body}`);})});
  const query=new LocalEmbeddingClient({baseUrl:'http://127.0.0.1:18489',bearerToken:secret,runtime,
    beforeInference:async()=>{queryGuards++;},fetch:gatewayFetch(gateway,(status,body)=>{if(status===undefined)queryRequests++;else responses.push(`${status}:${body}`);})});

  const firstClient=firstRole==='document'?document:query,secondClient=firstRole==='document'?query:document;
  const firstText=firstRole==='document'?'synthetic background fact':'synthetic query';
  const secondRole=firstRole==='document'?'query':'document',secondText=secondRole==='document'?'synthetic background fact':'synthetic query';
  const first=firstClient.embed([firstText],firstRole);await entered;
  let secondSettled=false;const second=secondClient.embed([secondText],secondRole).finally(()=>{secondSettled=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(secondSettled,false,'the authenticated waiter must remain queued while the owner is active');
  release();
  const completed=await Promise.all([first,second]);assert.deepEqual(completed.map(value=>value.tokens),[[1],[1]]);
  assert.equal(documentRequests,2);
  assert.equal(queryRequests,2);
  assert.equal(documentGuards,1);
  assert.equal(queryGuards,1);
  assert.equal(upstream,6,'both clients complete tokenization, gateway verification, and embedding without retries');
  assert.equal(responses.filter(value=>value.startsWith('429:')).length,0);
}

test('one authenticated FIFO waiter lets both exact client orders succeed without retry or probe serialization',async()=>{
  await runPairedOrder('document');
  await runPairedOrder('query');
});

test('real loopback HTTP sockets preserve health, paired POST admission, and queued cancellation',async()=>{
  const run=async(firstRole:'document'|'query',cancelQueued=false)=>{
    const r=receipt();let release!:()=>void,admitted!:()=>void;
    const hold=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{admitted=resolve;});let upstream=0;
    const gateway=new LocalEmbeddingGateway(r,Buffer.from(secret),19000,{commonTelemetry:async()=>healthy(r),telemetry:async()=>healthy(r),
      fetch:(async(target:string|URL|Request)=>{upstream++;if(upstream===1){admitted();await hold;}
        if(String(target).endsWith('/tokenize'))return Response.json({tokens:[1]});
        return Response.json({data:[{index:0,embedding:[1,...Array(QWEN_CHUNK_CONTRACT.nativeDimensions-1).fill(0)]}],usage:{prompt_tokens:1}});
      }) as typeof fetch});
    (gateway as any).backendSecret=Buffer.from('b'.repeat(32));
    const server=createServer((req,res)=>{void(gateway as any).handle(req,res);});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();assert.ok(address&&typeof address==='object');const baseUrl=`http://127.0.0.1:${address.port}`;
    try{
      const health=await fetch(`${baseUrl}/health`,{headers:{authorization:`Bearer ${secret}`}});
      assert.equal(health.status,200);
      assert.equal((await health.json() as {status:string}).status,'ok');
      const runtime={contractId:QWEN_CONTRACT_ID,artifactSha256:QWEN_CHUNK_CONTRACT.artifactSha256,
        runtimeContract:QWEN_CHUNK_CONTRACT.runtimeContract,acceptanceReceiptSha256:'a'.repeat(64)};
      let firstRequests=0,secondRequests=0;
      const first=new LocalEmbeddingClient({baseUrl,bearerToken:secret,runtime,beforeInference:async()=>{},
        fetch:(async(...args)=>{firstRequests++;return fetch(...args);}) as typeof fetch});
      const second=new LocalEmbeddingClient({baseUrl,bearerToken:secret,runtime,beforeInference:async()=>{},
        fetch:(async(...args)=>{secondRequests++;return fetch(...args);}) as typeof fetch});
      const secondRole=firstRole==='document'?'query':'document';
      const firstWork=first.embed([firstRole==='document'?'socket background':'socket query'],firstRole);
      const firstOutcome=firstWork.then(value=>({value}),error=>({error}));await entered;
      if(cancelQueued){
        const controller=new AbortController();const queued=second.countFormattedTokens('socket queued cancellation',controller.signal);
        const cancelled=assert.rejects(queued,error=>error instanceof LocalEmbeddingError&&error.code==='embedding.cancelled');
        while(!(gateway as any).waitingAdmission)await new Promise(resolve=>setImmediate(resolve));
        const before=upstream;controller.abort();await cancelled;
        const cancellationDeadline=Date.now()+2000;
        while((gateway as any).waitingAdmission&&Date.now()<cancellationDeadline){
          await new Promise(resolve=>setTimeout(resolve,5));
        }
        assert.ok(!(gateway as any).waitingAdmission,'cancelled socket waiter remained queued');
        assert.equal(upstream,before);release();await firstWork;
        assert.equal(secondRequests,1);
      }else{
        const secondWork=second.embed([secondRole==='document'?'socket background':'socket query'],secondRole);
        const secondOutcome=secondWork.then(value=>({value}),error=>({error}));
        while(!(gateway as any).waitingAdmission)await new Promise(resolve=>setImmediate(resolve));
        release();const completed=await Promise.all([firstOutcome,secondOutcome]);
        assert.ok(completed.every(value=>'value' in value),'paired socket work failed');
        assert.deepEqual(completed.map(value=>'value' in value?value.value.tokens:[]),[[1],[1]]);
        assert.equal(firstRequests,2);assert.equal(secondRequests,2);assert.equal(upstream,6);
      }
    }finally{release?.();await new Promise<void>(resolve=>server.close(()=>resolve()));await gateway.close();}
  };
  await run('document');await run('query');await run('document',true);
});
