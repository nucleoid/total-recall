import assert from 'node:assert/strict';
import test from 'node:test';
import { QWEN_CHUNK_CONTRACT,QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import { LocalEmbeddingGateway,verifyGatewayReceipt,type GatewayReceipt } from '../src/local-embedding-gateway.js';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { platform } from 'node:os';

const binary=Buffer.from('binary'),gguf=Buffer.from('model');
const runtimeDeps={listRuntimeFiles:async()=>['llama-server.exe'],realpath:async(path:string)=>path,lstat:async()=>({isSymbolicLink:()=>false}),verifyPathSecurity:async()=>{}};
const base=(mode:'gpu'|'cpu'='gpu'):GatewayReceipt=>({contractId:QWEN_CONTRACT_ID,artifactSha256:QWEN_CHUNK_CONTRACT.artifactSha256,
  runtimeContract:QWEN_CHUNK_CONTRACT.runtimeContract,acceptanceReceiptSha256:'a'.repeat(64),build:'b11669',
  binarySha256:createHash('sha256').update(binary).digest('hex'),binaryPath:'/fixed/runtime/llama-server.exe',runtimeRoot:'/fixed/runtime',
  runtimeFiles:[{path:'llama-server.exe',sha256:createHash('sha256').update(binary).digest('hex')}],ggufPath:'/fixed/model',hostId:'validator-1',mode,
  authorizedUntil:new Date(Date.now()+10*60_000).toISOString(),persistentCpuApproved:mode==='cpu',
  host:platform()==='win32'?{platform:'win32',diskPath:'C:\\',minimumAvailableBytes:2*1024**3,minimumDiskFreeBytes:100*1024**3,maximumSwapUsedBytes:0,maximumCpuUtilizationPercent:80}:
    {platform:'linux',diskPath:'/',minimumAvailableBytes:2*1024**3,minimumDiskFreeBytes:100*1024**3,maximumSwapUsedBytes:0,maximumLoad1:1},
  cpu:mode==='cpu'?{maximumMemoryPsiAvg10:0}:undefined,
  gpu:mode==='gpu'?{deviceUuid:'GPU-test-1',minimumFreeVramMiB:512}:undefined});

test('receipt pins contract, files, build, authorization and remote TLS',async()=>{
  const receipt=base();receipt.artifactSha256=QWEN_CHUNK_CONTRACT.artifactSha256;
  const hashFile=async(path:string)=>path.includes('server')?receipt.binarySha256:receipt.artifactSha256;
  await assert.rejects(verifyGatewayReceipt(receipt,{hashFile:async()=> '0'.repeat(64),...runtimeDeps}),/file_identity/);
  const verified=await verifyGatewayReceipt(receipt,{hashFile,...runtimeDeps});assert.equal(verified.build,'b11669');
  await assert.rejects(verifyGatewayReceipt({...receipt,authorizedUntil:new Date(Date.now()+16*60_000).toISOString()},{hashFile,...runtimeDeps}),/authorization_limit/);
  await assert.rejects(verifyGatewayReceipt({...receipt,listen:'0.0.0.0'},{hashFile,...runtimeDeps}),/remote_tls/);
});

test('launch arguments are fixed and contain no bearer secret',()=>{
  const receipt=base('cpu');const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000);
  assert.deepEqual(gateway.launchArgs(),['--model','/fixed/model','--host','127.0.0.1','--port','19000','--ctx-size','4096','--batch-size','2048','--ubatch-size','2048','--parallel','1','--threads','2','--pooling','last','--embedding','--n-gpu-layers','0']);
  assert.doesNotMatch(gateway.launchArgs().join(' '),/ssss/);
});

test('CPU mode requires explicit approval and GPU receipt is transient',async()=>{
  const r=base('cpu'),hashFile=async(path:string)=>path.includes('server')?r.binarySha256:r.artifactSha256;
  await verifyGatewayReceipt({...r,persistentCpuApproved:false},{hashFile,...runtimeDeps});
  await assert.rejects(verifyGatewayReceipt({...r,persistentCpuApproved:false,authorizedUntil:new Date(Date.now()+60*60_000).toISOString()},{hashFile,...runtimeDeps}),/cpu_approval_required/);
  await assert.rejects(verifyGatewayReceipt({...base(),authorizedUntil:new Date(Date.now()-1).toISOString()},{hashFile,...runtimeDeps}),/authorization_expired/);
});

test('authenticated health owns the sole slot and rejected requests cannot release it',async()=>{
  const receipt=base();let release!:()=>void;
  const telemetryWait=new Promise<void>(resolve=>{release=resolve;});
  let first=true;
  const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{telemetry:async()=>{
    if(first){first=false;await telemetryWait;}
    return healthyGpuTelemetry(receipt);
  }});
  const invoke=async(token:string)=>{
    const req=Readable.from([]) as any;req.method='GET';req.url='/health';req.headers={authorization:token};
    let status=0,body='';const res={writeHead:(value:number)=>{status=value;},end:(value:string)=>{body=value;}} as any;
    await(gateway as any).handle(req,res);return{status,body:JSON.parse(body)};
  };
  const active=invoke(`Bearer ${'s'.repeat(32)}`);await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await invoke('Bearer wrong')).status,401);
  assert.equal((await invoke(`Bearer ${'s'.repeat(32)}`)).status,429);
  release();const health=await active;assert.equal(health.status,200);assert.equal(health.body.status,'ok');assert.equal(health.body.verifiedLaunch,true);
});

test('startup failure after child launch closes the owned child',async()=>{
  const receipt={...base(),listen:'10.0.0.2',tlsCertPath:'/missing/cert',tlsKeyPath:'/missing/key',tlsCertSha256:'b'.repeat(64),allowedPeerAddresses:['10.0.0.3']};
  const child=new EventEmitter() as any;child.exitCode=null;child.kill=()=>{setImmediate(()=>{child.exitCode=0;child.emit('exit',0);});return true;};
  let launched=false;
  const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{hostname:()=>receipt.hostId,verifyBuild:async()=> 'build 11669, commit 620d2225c',
    revalidateLaunchFiles:async()=>{},spawnChild:()=>{launched=true;return child;},probeBackendPort:async()=>{},read:async()=>{throw new Error('unreadable TLS');}});
  await assert.rejects(gateway.start(),/unreadable TLS/);assert.equal(launched,true);assert.equal(child.exitCode,0);assert.equal((gateway as any).backendKeyDir,undefined);
});

test('tokenizer supports long planning counts while embedding requests retain the 2000 token cap',async()=>{
  const receipt=base(),tokens=Array(5000).fill(1);let embeddingCalls=0;
  const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{telemetry:async()=>healthyGpuTelemetry(receipt),
    fetch:(async(target:string|URL|Request)=>{if(String(target).endsWith('/tokenize'))return Response.json({tokens});embeddingCalls++;return Response.json({});}) as typeof fetch});
  (gateway as any).backendSecret=Buffer.from('b'.repeat(32));
  const invoke=async(url:string,body:unknown)=>{const raw=JSON.stringify(body),req=Readable.from([raw]) as any;req.method='POST';req.url=url;
    req.headers={authorization:`Bearer ${'s'.repeat(32)}`,'content-length':String(Buffer.byteLength(raw))};let status=0,value='';
    const res={writeHead:(n:number)=>{status=n;},end:(v:string)=>{value=v;}} as any;await(gateway as any).handle(req,res);return{status,body:JSON.parse(value)};};
  assert.equal((await invoke('/tokenize',{content:'x'.repeat(40_000),add_special:true})).status,200);
  const rejected=await invoke('/v1/embeddings',{input:['long'],truncate:false});assert.equal(rejected.status,400);
  assert.equal(rejected.body.error,'gateway.token_limit');assert.equal(embeddingCalls,0);
});

test('frontend does not listen until authenticated backend health and warmup succeed',async()=>{
  const receipt={...base(),port:0},child=new EventEmitter() as any;child.exitCode=null;
  child.kill=()=>{setImmediate(()=>{child.exitCode=0;child.emit('exit',0);});return true;};
  const calls:string[]=[];
  const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{hostname:()=>receipt.hostId,verifyBuild:async()=> 'build 11669, commit 620d2225c',spawnChild:()=>child,probeBackendPort:async()=>{},
    revalidateLaunchFiles:async()=>{},
    telemetry:async()=>healthyGpuTelemetry(receipt),
    fetch:(async(target:string|URL|Request,init?:RequestInit)=>{calls.push(`${String(target)} ${String((init?.headers as any)?.authorization??'')}`);
      if(String(target).endsWith('/health'))return Response.json({status:'ok'});
      return Response.json({data:[{index:0,embedding:nativeVector(0)}],usage:{prompt_tokens:1}});}) as typeof fetch});
  await gateway.start();try{assert.equal(calls.length,2);assert.match(calls[0],/\/health Bearer [a-f0-9]{64}/);assert.match(calls[1],/\/v1\/embeddings Bearer [a-f0-9]{64}/);assert.doesNotMatch(calls.join(' '),new RegExp(`Bearer ${'s'.repeat(32)}`));}finally{await gateway.close();}
});

function nativeVector(axis:number):number[]{return Array.from({length:1024},(_,i)=>i===axis?1:0);}
function healthyGpuTelemetry(receipt:GatewayReceipt){return{hostId:receipt.hostId,timestamp:Date.now(),mode:'gpu' as const,gpuDeviceUuid:'GPU-test-1',gpuTempC:50,vramUsedMiB:1,vramTotalMiB:1024,
  availableBytes:3*1024**3,diskFreeBytes:101*1024**3,swapUsedBytes:0,...(receipt.host.platform==='win32'?{cpuUtilizationPercent:20}:{load1:0.5})};}

test('GPU admission fails closed when common host telemetry is missing or malformed',async()=>{
  const receipt=base(),invoke=async(telemetry:any)=>{const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{telemetry:async()=>telemetry});
    const req=Readable.from([]) as any;req.method='GET';req.url='/health';req.headers={authorization:`Bearer ${'s'.repeat(32)}`};let status=0,value='';
    const res={writeHead:(n:number)=>{status=n;},end:(v:string)=>{value=v;}} as any;await(gateway as any).handle(req,res);return{status,body:JSON.parse(value)};};
  const missing=healthyGpuTelemetry(receipt);delete (missing as any).availableBytes;
  assert.deepEqual(await invoke(missing),{status:400,body:{error:'gateway.host_guard'}});
  assert.deepEqual(await invoke({...healthyGpuTelemetry(receipt),swapUsedBytes:Number.NaN}),{status:400,body:{error:'gateway.host_guard'}});
});
