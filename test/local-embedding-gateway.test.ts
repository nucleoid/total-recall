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

test('long CPU authority leases rearm without timer overflow and close at exact expiry',async()=>{
  let now=Date.parse('2026-10-20T00:00:00.000Z');const until=now+30*24*60*60_000;
  const scheduled:Array<{callback:()=>void;delay:number}>=[];let cleared=0,closed=0;
  const receipt={...base('cpu'),authorizedUntil:new Date(until).toISOString(),persistentCpuApproved:true};
  const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{now:()=>new Date(now),
    setAuthorityTimer:(callback,delay)=>{scheduled.push({callback,delay});return{unref(){}} as NodeJS.Timeout;},
    clearAuthorityTimer:()=>{cleared++;}});
  (gateway as any).close=async()=>{closed++;};(gateway as any).authorityTimerActive=true;(gateway as any).armAuthorityExpiry();
  assert.equal(scheduled[0].delay,24*60*60_000);assert.equal(closed,0);
  now=until-1;scheduled.shift()!.callback();assert.equal(scheduled[0].delay,1);assert.equal(closed,0);
  now=until;scheduled.shift()!.callback();assert.equal(closed,1);assert.equal(scheduled.length,0);assert.equal(cleared,0);
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
  const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{telemetry:async()=>healthyGpuTelemetry(receipt),commonTelemetry:async()=>healthyGpuTelemetry(receipt),
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
  const calls:string[]=[];let fullGuards=0,commonGuards=0;
  const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{hostname:()=>receipt.hostId,verifyBuild:async()=> 'build 11669, commit 620d2225c',spawnChild:()=>child,probeBackendPort:async()=>{},
    revalidateLaunchFiles:async()=>{},
    telemetry:async()=>{fullGuards++;return healthyGpuTelemetry(receipt);},
    commonTelemetry:async()=>{commonGuards++;return healthyGpuTelemetry(receipt);},
    fetch:(async(target:string|URL|Request,init?:RequestInit)=>{calls.push(`${String(target)} ${String((init?.headers as any)?.authorization??'')}`);
      if(String(target).endsWith('/health'))return Response.json({status:'ok'});
      return Response.json({data:[{index:0,embedding:nativeVector(0)}],usage:{prompt_tokens:1}});}) as typeof fetch});
  await gateway.start();try{assert.equal(calls.length,2);assert.match(calls[0],/\/health Bearer [a-f0-9]{64}/);assert.match(calls[1],/\/v1\/embeddings Bearer [a-f0-9]{64}/);assert.equal(commonGuards,1);assert.equal(fullGuards,1);assert.doesNotMatch(calls.join(' '),new RegExp(`Bearer ${'s'.repeat(32)}`));}finally{await gateway.close();}
});

function nativeVector(axis:number):number[]{return Array.from({length:1024},(_,i)=>i===axis?1:0);}
function healthyGpuTelemetry(receipt:GatewayReceipt){return{hostId:receipt.hostId,timestamp:Date.now(),mode:'gpu' as const,gpuDeviceUuid:'GPU-test-1',gpuTempC:50,vramUsedMiB:1,vramTotalMiB:1024,
  availableBytes:3*1024**3,diskFreeBytes:101*1024**3,swapUsedBytes:0,...(receipt.host.platform==='win32'?{cpuUtilizationPercent:20}:{load1:0.5})};}

test('GPU admission fails closed when common host telemetry is missing or malformed',async()=>{
  const receipt=base();let upstreamCalls=0;const invoke=async(telemetry:any)=>{const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{telemetry:async()=>telemetry,fetch:(async()=>{upstreamCalls++;return Response.json({});}) as typeof fetch});
    const req=Readable.from([]) as any;req.method='GET';req.url='/health';req.headers={authorization:`Bearer ${'s'.repeat(32)}`};let status=0,value='';
    const res={writeHead:(n:number)=>{status=n;},end:(v:string)=>{value=v;}} as any;await(gateway as any).handle(req,res);return{status,body:JSON.parse(value)};};
  const missing=healthyGpuTelemetry(receipt);delete (missing as any).availableBytes;
  assert.deepEqual(await invoke(missing),{status:503,body:{error:'gateway.host_guard'}});
  assert.deepEqual(await invoke({...healthyGpuTelemetry(receipt),swapUsedBytes:Number.NaN}),{status:503,body:{error:'gateway.host_guard'}});
  assert.equal(upstreamCalls,0);
});

test('malformed embedding payload remains a bounded client error before upstream inference',async()=>{
  const receipt=base();let upstreamCalls=0;const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{telemetry:async()=>healthyGpuTelemetry(receipt),commonTelemetry:async()=>healthyGpuTelemetry(receipt),fetch:(async()=>{upstreamCalls++;return Response.json({});}) as typeof fetch});
  const raw=JSON.stringify({input:'not-an-array',truncate:false}),req=Readable.from([raw]) as any;req.method='POST';req.url='/v1/embeddings';req.headers={authorization:`Bearer ${'s'.repeat(32)}`,'content-length':String(Buffer.byteLength(raw))};let status=0,value='';
  const res={writeHead:(n:number)=>{status=n;},end:(v:string)=>{value=v;}} as any;await(gateway as any).handle(req,res);
  assert.equal(status,400);assert.deepEqual(JSON.parse(value),{error:'gateway.embedding_shape'});assert.equal(upstreamCalls,0);
});

async function invokeGateway(gateway:LocalEmbeddingGateway,url:'/health'|'/tokenize'|'/v1/embeddings',body?:unknown){
  const raw=body===undefined?'':JSON.stringify(body),req=Readable.from(raw?[raw]:[]) as any;req.method=body===undefined?'GET':'POST';req.url=url;
  req.headers={authorization:`Bearer ${'s'.repeat(32)}`,...(raw?{'content-length':String(Buffer.byteLength(raw))}:{})};let status=0,value='';
  const res={writeHead:(n:number)=>{status=n;},end:(v:string)=>{value=v;}} as any;await(gateway as any).handle(req,res);return{status,body:JSON.parse(value)};
}

test('GPU tokenizer uses only common host guards and common failure prevents backend work',async()=>{
  const receipt=base();let full=0,backend=0;
  const unhealthy={...healthyGpuTelemetry(receipt),availableBytes:1};
  const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{commonTelemetry:async()=>unhealthy,telemetry:async()=>{full++;return healthyGpuTelemetry(receipt);},fetch:(async()=>{backend++;return Response.json({tokens:[1]});}) as typeof fetch});
  (gateway as any).backendSecret=Buffer.from('b'.repeat(32));
  assert.deepEqual(await invokeGateway(gateway,'/tokenize',{content:'x',add_special:true}),{status:503,body:{error:'gateway.host_guard'}});
  assert.equal(full,0);assert.equal(backend,0);
});

test('every GPU embedding performs a fresh full probe immediately before backend inference',async()=>{
  const receipt=base();const events:string[]=[];
  const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{commonTelemetry:async()=>{events.push('common');return healthyGpuTelemetry(receipt);},telemetry:async()=>{events.push('full');return healthyGpuTelemetry(receipt);},fetch:(async(target:string|URL|Request)=>{const embedding=String(target).endsWith('/v1/embeddings');events.push(embedding?'embed':'tokenize');return embedding?Response.json({data:[{index:0,embedding:nativeVector(0)}],usage:{prompt_tokens:1}}):Response.json({tokens:[1]});}) as typeof fetch});
  (gateway as any).backendSecret=Buffer.from('b'.repeat(32));
  assert.equal((await invokeGateway(gateway,'/v1/embeddings',{input:['x'],truncate:false})).status,200);
  assert.equal((await invokeGateway(gateway,'/v1/embeddings',{input:['x'],truncate:false})).status,200);
  assert.deepEqual(events,['common','common','tokenize','full','embed','common','common','tokenize','full','embed']);
});

test('fresh GPU thermal failure prevents the actual embedding request',async()=>{
  const receipt=base();let embeddingCalls=0,full=0;
  const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{commonTelemetry:async()=>healthyGpuTelemetry(receipt),telemetry:async()=>{full++;return{...healthyGpuTelemetry(receipt),gpuTempC:85};},fetch:(async(target:string|URL|Request)=>{if(String(target).endsWith('/v1/embeddings'))embeddingCalls++;return Response.json({tokens:[1]});}) as typeof fetch});
  (gateway as any).backendSecret=Buffer.from('b'.repeat(32));
  assert.deepEqual(await invokeGateway(gateway,'/v1/embeddings',{input:['x'],truncate:false}),{status:503,body:{error:'gateway.gpu_guard'}});
  assert.equal(full,1);assert.equal(embeddingCalls,0);
});

test('health uses the full GPU guard and expired authority blocks all routes before telemetry',async()=>{
  const receipt=base();let full=0,common=0,backend=0;
  const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{commonTelemetry:async()=>{common++;return healthyGpuTelemetry(receipt);},telemetry:async()=>{full++;return healthyGpuTelemetry(receipt);},fetch:(async()=>{backend++;return Response.json({tokens:[1]});}) as typeof fetch});
  assert.equal((await invokeGateway(gateway,'/health')).status,200);assert.equal(full,1);assert.equal(common,0);
  const expired={...receipt,authorizedUntil:new Date(Date.now()-1).toISOString()},blocked=new LocalEmbeddingGateway(expired,Buffer.from('s'.repeat(32)),19000,{commonTelemetry:async()=>{common++;return healthyGpuTelemetry(expired);},telemetry:async()=>{full++;return healthyGpuTelemetry(expired);},fetch:(async()=>{backend++;return Response.json({});}) as typeof fetch});
  assert.equal((await invokeGateway(blocked,'/tokenize',{content:'x',add_special:true})).status,403);
  assert.equal((await invokeGateway(blocked,'/health')).status,403);assert.equal(common,0);assert.equal(full,1);assert.equal(backend,0);
});

test('GPU common admission rejects negative swap, load and CPU utilization before upstream work',async()=>{
  const linux={...base(),host:{platform:'linux' as const,diskPath:'/',minimumAvailableBytes:2*1024**3,minimumDiskFreeBytes:100*1024**3,maximumSwapUsedBytes:0,maximumLoad1:1}};
  const windows={...base(),host:{platform:'win32' as const,diskPath:'C:\\',minimumAvailableBytes:2*1024**3,minimumDiskFreeBytes:100*1024**3,maximumSwapUsedBytes:0,maximumCpuUtilizationPercent:100}};
  const cases:[[GatewayReceipt,any],...Array<[GatewayReceipt,any]>]=[
    [linux,{...healthyGpuTelemetry(linux),swapUsedBytes:-1,load1:.5}],
    [linux,{...healthyGpuTelemetry(linux),swapUsedBytes:0,load1:-.01}],
    [windows,{...healthyGpuTelemetry(windows),swapUsedBytes:0,cpuUtilizationPercent:-.01}],
    [windows,{...healthyGpuTelemetry(windows),swapUsedBytes:0,cpuUtilizationPercent:100.01}],
  ];
  for(const [receipt,telemetry] of cases){let backend=0,full=0;const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{commonTelemetry:async()=>telemetry,telemetry:async()=>{full++;return telemetry;},fetch:(async()=>{backend++;return Response.json({tokens:[1]});}) as typeof fetch});
    assert.deepEqual(await invokeGateway(gateway,'/tokenize',{content:'x',add_special:true}),{status:503,body:{error:'gateway.host_guard'}});assert.equal(full,0);assert.equal(backend,0);}
});

test('CPU full admission rejects negative memory PSI before upstream work',async()=>{
  const receipt={...base('cpu'),host:{platform:'linux' as const,diskPath:'/',minimumAvailableBytes:2*1024**3,minimumDiskFreeBytes:100*1024**3,maximumSwapUsedBytes:0,maximumLoad1:1}};
  let backend=0;const telemetry={hostId:receipt.hostId,timestamp:Date.now(),mode:'cpu' as const,availableBytes:3*1024**3,diskFreeBytes:101*1024**3,swapUsedBytes:0,load1:.5,memoryPsiAvg10:-.01};
  const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{telemetry:async()=>telemetry,fetch:(async()=>{backend++;return Response.json({tokens:[1]});}) as typeof fetch});
  assert.deepEqual(await invokeGateway(gateway,'/tokenize',{content:'x',add_special:true}),{status:503,body:{error:'gateway.cpu_guard'}});assert.equal(backend,0);
});
