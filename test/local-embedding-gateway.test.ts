import assert from 'node:assert/strict';
import test from 'node:test';
import { QWEN_CHUNK_CONTRACT,QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import { LocalEmbeddingGateway,listRuntimeFiles,verifyGatewayReceipt,type GatewayReceipt } from '../src/local-embedding-gateway.js';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp,readFile,rm,symlink,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const healthyCpuTelemetry=(receipt:GatewayReceipt)=>({hostId:receipt.hostId,mode:'cpu' as const,timestamp:Date.now(),availableBytes:3*1024**3,
  diskFreeBytes:101*1024**3,swapUsedBytes:0,memoryPsiAvg10:0,...(receipt.host.platform==='win32'?{cpuUtilizationPercent:0}:{load1:0})});

test('runtime receipt inventories the complete closure and rejects set drift',async()=>{
  const root=await mkdtemp(join(tmpdir(),'gateway-runtime-')),modelRoot=await mkdtemp(join(tmpdir(),'gateway-model-'));
  try{
    const modelPath=join(modelRoot,'model.gguf');await writeFile(modelPath,Buffer.from('model'));
    const names=['LICENSE','llama-server',...Array.from({length:19},(_,i)=>'llama-tool-'+i),...Array.from({length:39},(_,i)=>'lib-runtime-'+i+'.so')];
    const files=new Map(names.map(name=>[name,Buffer.from('runtime:'+name)]));
    for(const [name,bytes] of files)await writeFile(join(root,name),bytes);
    const runtimeFiles=[...files].map(([path,bytes])=>({path,sha256:createHash('sha256').update(bytes).digest('hex')}));
    const binaryHash=runtimeFiles.find(file=>file.path==='llama-server')!.sha256;
    const receipt={...base('cpu'),binaryPath:join(root,'llama-server'),runtimeRoot:root,ggufPath:modelPath,binarySha256:binaryHash,runtimeFiles};
    const hashFile=async(file:string)=>file===modelPath?receipt.artifactSha256:createHash('sha256').update(await readFile(file)).digest('hex');
    const deps={hashFile,verifyPathSecurity:async()=>{}};
    const inventory=await listRuntimeFiles(root);assert.equal(inventory.length,60);assert.ok(inventory.includes('LICENSE'));assert.ok(inventory.includes('llama-tool-18'));assert.ok(inventory.includes('lib-runtime-38.so'));
    await verifyGatewayReceipt(receipt,deps);
    await assert.rejects(verifyGatewayReceipt({...receipt,runtimeFiles:runtimeFiles.filter(file=>file.path!=='LICENSE')},deps),/runtime_unlisted_file/);
    await assert.rejects(verifyGatewayReceipt({...receipt,runtimeFiles:[...runtimeFiles,{path:'unexpected-tool',sha256:'f'.repeat(64)}]},deps),/runtime_unlisted_file/);
  }finally{await rm(root,{recursive:true,force:true});await rm(modelRoot,{recursive:true,force:true});}
});

test('runtime inventory accepts confined symlinks and rejects escapes and unsupported entries',{skip:platform()==='win32'},async()=>{
  const root=await mkdtemp(join(tmpdir(),'gateway-runtime-')),outside=await mkdtemp(join(tmpdir(),'gateway-outside-'));
  try{
    const modelPath=join(outside,'model.gguf');await writeFile(modelPath,Buffer.from('model'));
    await writeFile(join(root,'llama-server'),Buffer.from('server'));
    await writeFile(join(root,'LICENSE'),Buffer.from('license'));
    await symlink('LICENSE',join(root,'LICENSE.link'));
    const serverHash=createHash('sha256').update('server').digest('hex'),licenseHash=createHash('sha256').update('license').digest('hex');
    const receipt={...base('cpu'),binaryPath:join(root,'llama-server'),runtimeRoot:root,ggufPath:modelPath,binarySha256:serverHash,runtimeFiles:[
      {path:'LICENSE',sha256:licenseHash},{path:'LICENSE.link',sha256:licenseHash},{path:'llama-server',sha256:serverHash}]};
    const hashFile=async(file:string)=>file===modelPath?receipt.artifactSha256:createHash('sha256').update(await readFile(file)).digest('hex');
    await verifyGatewayReceipt(receipt,{hashFile,verifyPathSecurity:async()=>{}});
    await rm(join(root,'LICENSE.link'));
    await writeFile(join(outside,'secret'),Buffer.from('outside'));
    await symlink(join(outside,'secret'),join(root,'escape'));
    const escaped={...receipt,runtimeFiles:[...receipt.runtimeFiles.filter(file=>file.path!=='LICENSE.link'),{path:'escape',sha256:createHash('sha256').update('outside').digest('hex')}]};
    await assert.rejects(verifyGatewayReceipt(escaped,{hashFile,verifyPathSecurity:async()=>{}}),/runtime_symlink/);
    await rm(join(root,'escape'));
    execFileSync('/usr/bin/mkfifo',[join(root,'unsupported')]);
    await assert.rejects(listRuntimeFiles(root),/runtime_entry_type/);
  }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
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

test('authenticated requests get one bounded waiter while unauthorized and excess requests cannot queue or release',async()=>{
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
  const queued=invoke(`Bearer ${'s'.repeat(32)}`);await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await invoke(`Bearer ${'s'.repeat(32)}`)).status,429);
  release();const [health,next]=await Promise.all([active,queued]);
  for(const result of [health,next]){assert.equal(result.status,200);assert.equal(result.body.status,'ok');assert.equal(result.body.verifiedLaunch,true);}
});

test('admission handoff is owner-only and timeout, abort, close, and authority expiry drain the waiter',async()=>{
  const make=()=>{const req=Readable.from([]) as any;req.socket=new EventEmitter();const res=new EventEmitter() as any;res.status=0;res.body='';
    res.writeHead=(status:number)=>{res.status=status;};res.end=(body:string)=>{res.body=body;};return{req,res};};
  let admissionDeadline!:()=>void,admissionDelay=0;
  const gateway=new LocalEmbeddingGateway(base('cpu'),Buffer.from('s'.repeat(32)),19000,{setAdmissionTimer:(callback,delay)=>{
    admissionDeadline=callback;admissionDelay=delay;return{unref(){}} as NodeJS.Timeout;},clearAdmissionTimer:()=>{}});
  const first=make(),owner=await(gateway as any).acquireAdmission(first.req,first.res);assert.equal(typeof owner,'symbol');
  const second=make(),waiting=(gateway as any).acquireAdmission(second.req,second.res);await new Promise(resolve=>setImmediate(resolve));
  (gateway as any).releaseAdmission(Symbol('non-owner'));assert.equal((gateway as any).activeAdmission,owner);
  (gateway as any).releaseAdmission(owner);const handed=await waiting;assert.equal(typeof handed,'symbol');assert.equal((gateway as any).activeAdmission,handed);
  (gateway as any).releaseAdmission(handed);

  const timeoutActive=make(),timeoutOwner=await(gateway as any).acquireAdmission(timeoutActive.req,timeoutActive.res),timed=make(),timedWait=(gateway as any).acquireAdmission(timed.req,timed.res);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(admissionDelay,5000);admissionDeadline();assert.equal(await timedWait,undefined);
  assert.equal(timed.res.status,429);assert.deepEqual(JSON.parse(timed.res.body),{error:'busy'});(gateway as any).releaseAdmission(timeoutOwner);

  const abortActive=make(),abortOwner=await(gateway as any).acquireAdmission(abortActive.req,abortActive.res),aborted=make(),abortWait=(gateway as any).acquireAdmission(aborted.req,aborted.res);
  await new Promise(resolve=>setImmediate(resolve));aborted.req.emit('aborted');assert.equal(await abortWait,undefined);assert.equal(aborted.res.status,0);
  (gateway as any).releaseAdmission(abortOwner);

  const closeActive=make(),closeOwner=await(gateway as any).acquireAdmission(closeActive.req,closeActive.res),closing=make(),closeWait=(gateway as any).acquireAdmission(closing.req,closing.res);
  await new Promise(resolve=>setImmediate(resolve));await gateway.close();assert.equal(await closeWait,undefined);assert.equal((gateway as any).activeAdmission,undefined);
  (gateway as any).releaseAdmission(closeOwner);const afterClose=make();assert.equal(await(gateway as any).acquireAdmission(afterClose.req,afterClose.res),undefined);assert.equal(afterClose.res.status,503);

  const expiredReceipt={...base('cpu'),authorizedUntil:new Date(Date.now()-1).toISOString()};
  const expiring=new LocalEmbeddingGateway(expiredReceipt,Buffer.from('s'.repeat(32)),19000,{now:()=>new Date()});
  const expiryOwner=await(expiring as any).acquireAdmission(make().req,make().res),expiryWait=(expiring as any).acquireAdmission(make().req,make().res);
  (expiring as any).authorityTimerActive=true;(expiring as any).armAuthorityExpiry();assert.equal(await expiryWait,undefined);
  assert.equal((expiring as any).activeAdmission,undefined);(expiring as any).releaseAdmission(expiryOwner);
});

test('admission rechecks abandonment, close state, and monotonic deadline across handoff races',async()=>{
  const make=()=>{const req=Readable.from([]) as any;req.socket=new EventEmitter();const res=new EventEmitter() as any;res.status=0;res.body='';
    res.writeHead=(status:number)=>{res.status=status;};res.end=(body:string)=>{res.body=body;};return{req,res};};
  let now=0,timerCallback=()=>{};const deps={admissionNow:()=>now,setAdmissionTimer:(callback:()=>void,delay:number)=>{
    assert.equal(delay,5000);timerCallback=callback;return{unref(){}} as NodeJS.Timeout;},clearAdmissionTimer:()=>{}};

  const preAbortedGateway=new LocalEmbeddingGateway(base('cpu'),Buffer.from('s'.repeat(32)),19000,deps),preAborted=make();
  preAborted.req.aborted=true;assert.equal(await(preAbortedGateway as any).acquireAdmission(preAborted.req,preAborted.res),undefined);
  assert.equal((preAbortedGateway as any).activeAdmission,undefined);assert.equal(preAborted.res.status,0);

  const abortGateway=new LocalEmbeddingGateway(base('cpu'),Buffer.from('s'.repeat(32)),19000,deps),abortActive=make();
  const abortOwner=await(abortGateway as any).acquireAdmission(abortActive.req,abortActive.res),abortQueued=make();
  const abortWait=(abortGateway as any).acquireAdmission(abortQueued.req,abortQueued.res);await new Promise(resolve=>setImmediate(resolve));
  (abortGateway as any).releaseAdmission(abortOwner);const abortToken=await abortWait;abortQueued.req.aborted=true;
  assert.equal((abortGateway as any).validateGrantedAdmission(abortToken,abortQueued.req,abortQueued.res,5000),false);
  assert.equal((abortGateway as any).activeAdmission,undefined);assert.equal(abortQueued.res.status,0);

  const closeGateway=new LocalEmbeddingGateway(base('cpu'),Buffer.from('s'.repeat(32)),19000,deps),closeActive=make();
  const closeOwner=await(closeGateway as any).acquireAdmission(closeActive.req,closeActive.res),closeQueued=make();
  const closeWait=(closeGateway as any).acquireAdmission(closeQueued.req,closeQueued.res);await new Promise(resolve=>setImmediate(resolve));
  (closeGateway as any).releaseAdmission(closeOwner);const closeToken=await closeWait;await closeGateway.close();
  assert.equal((closeGateway as any).validateGrantedAdmission(closeToken,closeQueued.req,closeQueued.res,5000),false);
  assert.equal((closeGateway as any).activeAdmission,undefined);assert.equal(closeQueued.res.status,0);

  const deadlineGateway=new LocalEmbeddingGateway(base('cpu'),Buffer.from('s'.repeat(32)),19000,deps),deadlineActive=make();
  const deadlineOwner=await(deadlineGateway as any).acquireAdmission(deadlineActive.req,deadlineActive.res),expired=make();
  const expiredWait=(deadlineGateway as any).acquireAdmission(expired.req,expired.res);await new Promise(resolve=>setImmediate(resolve));
  now=5000;(deadlineGateway as any).releaseAdmission(deadlineOwner);assert.equal(await expiredWait,undefined);
  assert.equal(expired.res.status,429);assert.deepEqual(JSON.parse(expired.res.body),{error:'busy'});
  assert.equal((deadlineGateway as any).activeAdmission,undefined);assert.equal(typeof timerCallback,'function');

  now=0;const postDeadlineGateway=new LocalEmbeddingGateway(base('cpu'),Buffer.from('s'.repeat(32)),19000,deps),postActive=make();
  const postOwner=await(postDeadlineGateway as any).acquireAdmission(postActive.req,postActive.res),postExpired=make();
  const postWait=(postDeadlineGateway as any).acquireAdmission(postExpired.req,postExpired.res);await new Promise(resolve=>setImmediate(resolve));
  (postDeadlineGateway as any).releaseAdmission(postOwner);now=5000;const postToken=await postWait;
  assert.equal((postDeadlineGateway as any).validateGrantedAdmission(postToken,postExpired.req,postExpired.res,5000),false);
  assert.equal(postExpired.res.status,429);assert.equal((postDeadlineGateway as any).activeAdmission,undefined);
});

test('abandonment or close after synchronous grant never reads the queued body or reaches upstream',async()=>{
  const run=async(race:'abort'|'close')=>{
    const receipt=base('cpu');let upstream=0;
    const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{telemetry:async()=>healthyCpuTelemetry(receipt),
      fetch:(async()=>{upstream++;return Response.json({tokens:[1]});}) as typeof fetch});
    (gateway as any).backendSecret=Buffer.from('b'.repeat(32));
    const ownerReq=Readable.from([]) as any,ownerRes=new EventEmitter() as any,owner=await(gateway as any).acquireAdmission(ownerReq,ownerRes);
    const raw=JSON.stringify({content:'must-not-be-read',add_special:true}),req=Readable.from([raw]) as any;req.method='POST';req.url='/tokenize';
    req.headers={authorization:`Bearer ${'s'.repeat(32)}`,'content-length':String(Buffer.byteLength(raw))};req.socket=new EventEmitter();
    let status=0,body='';const res=new EventEmitter() as any;res.writeHead=(value:number)=>{status=value;};res.end=(value='')=>{body=String(value);};
    const original=(gateway as any).validateGrantedAdmission.bind(gateway);
    (gateway as any).validateGrantedAdmission=(token:symbol,request:any,response:any,deadline:number|undefined)=>{
      if(race==='abort')request.aborted=true;else{(gateway as any).admissionClosed=true;(gateway as any).activeAdmission=undefined;}
      return original(token,request,response,deadline);
    };
    const pending=(gateway as any).handle(req,res);await new Promise(resolve=>setImmediate(resolve));(gateway as any).releaseAdmission(owner);await pending;
    assert.equal(status,0);assert.equal(body,'');assert.equal(upstream,0);
  };
  await run('abort');await run('close');
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

function nativeVector(axis:number):number[]{return Array.from({length:QWEN_CHUNK_CONTRACT.nativeDimensions},(_,i)=>i===axis?1:0);}
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

test('wire NFC is enforced before either tokenizer or inference while preserving byte guards', async () => {
  const receipt=base('cpu'); let calls=0;
  const gateway=new LocalEmbeddingGateway(receipt,Buffer.from('s'.repeat(32)),19000,{
    telemetry:async()=>healthyCpuTelemetry(receipt),commonTelemetry:async()=>healthyCpuTelemetry(receipt),
    fetch:(async target=>{calls++;return String(target).endsWith('/tokenize') ? Response.json({tokens:[1]})
      :Response.json({data:[{index:0,embedding:nativeVector(0)}],usage:{prompt_tokens:1}});}) as typeof fetch});
  (gateway as any).backendSecret=Buffer.from('b'.repeat(32));
  assert.deepEqual(await invokeGateway(gateway,'/tokenize',{content:'e\u0301',add_special:true}),
    {status:400,body:{error:'gateway.text_normalization'}});
  assert.deepEqual(await invokeGateway(gateway,'/v1/embeddings',{input:['e\u0301'],truncate:false}),
    {status:400,body:{error:'gateway.text_normalization'}});
  assert.equal(calls,0);
  assert.equal((await invokeGateway(gateway,'/tokenize',{content:'é',add_special:true})).status,200);
  assert.equal((await invokeGateway(gateway,'/v1/embeddings',{input:['é'],truncate:false})).status,200);
  assert.equal(calls,3);
  assert.deepEqual(await invokeGateway(gateway,'/tokenize',{content:'é'.repeat(524289),add_special:true}),
    {status:400,body:{error:'gateway.tokenize_shape'}});
  assert.equal(calls,3);
});

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
  assert.equal((await invokeGateway(blocked,'/health')).status,503);assert.equal(common,0);assert.equal(full,1);assert.equal(backend,0);
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
