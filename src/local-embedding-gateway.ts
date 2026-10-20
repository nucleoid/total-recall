import { createHash,randomBytes,timingSafeEqual } from 'node:crypto';
import { chmod,lstat,mkdtemp,readFile,readdir,realpath,rm,stat,statfs,writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, freemem, hostname, loadavg, platform, tmpdir,homedir } from 'node:os';
import { dirname,isAbsolute,join,relative,resolve,sep } from 'node:path';
import type { Socket } from 'node:net';
import net from 'node:net';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID, projectQwenVector } from './local-embedding-contract.js';
import {verifyWindowsEmbeddingPermissions,protectNewWindowsEmbeddingDirectory} from './windows-embedding-permissions.js';

export interface GatewayReceipt {
  contractId:string; artifactSha256:string; runtimeContract:string; acceptanceReceiptSha256:string;
  build:'b11669'; binarySha256:string; binaryPath:string; ggufPath:string; hostId:string;
  runtimeRoot:string;runtimeFiles:Array<{path:string;sha256:string}>;
  mode:'gpu'|'cpu'; authorizedUntil:string; persistentCpuApproved?:boolean;
  listen?:string; port?:number; tlsCertPath?:string; tlsKeyPath?:string;
  tlsCertSha256?:string; allowedPeerAddresses?:string[];
  host:{platform:'linux'|'win32';diskPath:string;minimumAvailableBytes:number;minimumDiskFreeBytes:number;maximumSwapUsedBytes:number;maximumLoad1?:number;maximumCpuUtilizationPercent?:number};
  cpu?:{maximumMemoryPsiAvg10:number};
  gpu?:{deviceUuid:string;minimumFreeVramMiB:number};
}
export interface GatewayTelemetry {hostId:string;timestamp:number;mode:'gpu'|'cpu';gpuDeviceUuid?:string;gpuTempC?:number;vramUsedMiB?:number;vramTotalMiB?:number;availableBytes?:number;diskFreeBytes?:number;swapUsedBytes?:number;memoryPsiAvg10?:number;load1?:number;cpuUtilizationPercent?:number}
export interface GatewayDependencies {
  now?:()=>Date; read?:typeof readFile; fetch?:typeof fetch;
  spawnChild?:(file:string,args:string[])=>ChildProcess;
  telemetry?:(receipt:GatewayReceipt)=>Promise<GatewayTelemetry>;
  commonTelemetry?:(receipt:GatewayReceipt)=>Promise<GatewayTelemetry>;
  hashFile?:(path:string)=>Promise<string>;
  hostname?:()=>string;
  verifyBuild?:(path:string)=>Promise<string>;
  listRuntimeFiles?:(root:string)=>Promise<string[]>;
  realpath?:(path:string)=>Promise<string>;
  lstat?:(path:string)=>Promise<{isSymbolicLink():boolean}>;
  verifyPathSecurity?:(paths:string[])=>Promise<void>;
  revalidateLaunchFiles?:(receipt:GatewayReceipt)=>Promise<void>;
  probeBackendPort?:(port:number)=>Promise<void>;
  setAuthorityTimer?:(callback:()=>void,delayMs:number)=>NodeJS.Timeout;
  clearAuthorityTimer?:(timer:NodeJS.Timeout)=>void;
  setAdmissionTimer?:(callback:()=>void,delayMs:number)=>NodeJS.Timeout;
  clearAdmissionTimer?:(timer:NodeJS.Timeout)=>void;
  admissionNow?:()=>number;
}

const MAX_BODY=8*1024*1024,MAX_TOKENIZER_RESPONSE=16*1024*1024;
const MAX_AUTHORITY_TIMER_DELAY_MS=24*60*60_000;
const MAX_ADMISSION_WAIT_MS=5_000;
const FIXED_ARGS=(model:string,port:number,mode:'gpu'|'cpu')=>['--model',model,'--host','127.0.0.1','--port',String(port),
  '--ctx-size','4096','--batch-size','2048','--ubatch-size','2048','--parallel','1','--threads','2','--pooling','last','--embedding',
  '--n-gpu-layers',mode==='gpu'?'999':'0'];

export async function verifyGatewayReceipt(raw:unknown,deps:GatewayDependencies={}):Promise<GatewayReceipt>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('gateway.receipt_shape');
  const r=raw as GatewayReceipt;
  const fields=['contractId','artifactSha256','runtimeContract','acceptanceReceiptSha256','build','binarySha256','binaryPath','ggufPath','hostId','mode','authorizedUntil','runtimeRoot'];
  const allowed=new Set([...fields,'runtimeFiles','persistentCpuApproved','listen','port','tlsCertPath','tlsKeyPath','tlsCertSha256','allowedPeerAddresses','host','cpu','gpu']);
  if(Object.keys(r).some(key=>!allowed.has(key)))throw new Error('gateway.receipt_shape');
  if(fields.some(k=>typeof (r as any)[k]!=='string')||r.contractId!==QWEN_CONTRACT_ID||r.artifactSha256!==QWEN_CHUNK_CONTRACT.artifactSha256||
    r.runtimeContract!==QWEN_CHUNK_CONTRACT.runtimeContract||r.build!=='b11669'||!/^[a-f0-9]{64}$/.test(r.binarySha256)||
    !/^[a-f0-9]{64}$/.test(r.acceptanceReceiptSha256)||!r.hostId.trim()||!['gpu','cpu'].includes(r.mode))throw new Error('gateway.receipt_identity');
  if(!Array.isArray(r.runtimeFiles)||!r.runtimeFiles.length||r.runtimeFiles.some(f=>!f||typeof f.path!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256)||!safeRelative(f.path))||new Set(r.runtimeFiles.map(f=>f.path)).size!==r.runtimeFiles.length)throw new Error('gateway.runtime_manifest');
  const now=(deps.now??(()=>new Date()))().getTime(),until=new Date(r.authorizedUntil).getTime();
  if(!Number.isFinite(until)||until<=now)throw new Error('gateway.authorization_expired');
  if(r.mode==='gpu'&&until-now>15*60_000)throw new Error('gateway.gpu_authorization_limit');
  if(r.mode==='cpu'&&until-now>15*60_000&&r.persistentCpuApproved!==true)throw new Error('gateway.cpu_approval_required');
  if(!r.host||!['linux','win32'].includes(r.host.platform)||r.host.platform!==platform()||!isAbsolute(r.host.diskPath)||
    !Number.isSafeInteger(r.host.minimumAvailableBytes)||r.host.minimumAvailableBytes<2*1024**3||
    !Number.isSafeInteger(r.host.minimumDiskFreeBytes)||r.host.minimumDiskFreeBytes<100*1024**3||
    !Number.isSafeInteger(r.host.maximumSwapUsedBytes)||r.host.maximumSwapUsedBytes<0||
    (r.host.platform==='linux'&&(!Number.isFinite(r.host.maximumLoad1)||r.host.maximumLoad1!<=0))||
    (r.host.platform==='win32'&&(!Number.isFinite(r.host.maximumCpuUtilizationPercent)||r.host.maximumCpuUtilizationPercent!<=0||r.host.maximumCpuUtilizationPercent!>100)))throw new Error('gateway.host_guard_config');
  const hostKeys=r.host.platform==='linux'?['platform','diskPath','minimumAvailableBytes','minimumDiskFreeBytes','maximumSwapUsedBytes','maximumLoad1']:['platform','diskPath','minimumAvailableBytes','minimumDiskFreeBytes','maximumSwapUsedBytes','maximumCpuUtilizationPercent'];
  if(Object.keys(r.host).length!==hostKeys.length||Object.keys(r.host).some(key=>!hostKeys.includes(key)))throw new Error('gateway.host_guard_config');
  if(r.mode==='cpu'&&(!r.cpu||!Number.isFinite(r.cpu.maximumMemoryPsiAvg10)||r.cpu.maximumMemoryPsiAvg10<0))throw new Error('gateway.cpu_guard_config');
  if(r.mode==='gpu'&&(!r.gpu||!/^GPU-[A-Za-z0-9-]+$/.test(r.gpu.deviceUuid)||!Number.isFinite(r.gpu.minimumFreeVramMiB)||r.gpu.minimumFreeVramMiB<512))throw new Error('gateway.gpu_guard_config');
  const remote=!!r.listen&&r.listen!=='127.0.0.1'&&r.listen!=='::1';
  if(remote&&(!isPrivateIpv4(r.listen!)||!r.tlsCertPath||!r.tlsKeyPath||!/^[a-f0-9]{64}$/.test(r.tlsCertSha256??'')||!r.allowedPeerAddresses?.length||r.allowedPeerAddresses.some(x=>!isPrivateIpv4(x))))throw new Error('gateway.remote_tls_required');
  if(r.port!==undefined&&(!Number.isSafeInteger(r.port)||r.port<1024||r.port>65535))throw new Error('gateway.port');
  const read=deps.read??readFile;
  const hash=deps.hashFile??hashFileStreaming;
  const resolveReal=deps.realpath??realpath,readLinkStat=deps.lstat??lstat;
  const [root,binaryReal,ggufReal]=await Promise.all([resolveReal(r.runtimeRoot),resolveReal(r.binaryPath),resolveReal(r.ggufPath)]);if(!within(root,binaryReal))throw new Error('gateway.runtime_confinement');
  const [binaryHash,ggufHash]=await Promise.all([hash(binaryReal),hash(ggufReal)]);
  if(binaryHash!==r.binarySha256||ggufHash!==r.artifactSha256)throw new Error('gateway.file_identity');
  const declared=new Map(r.runtimeFiles.map(f=>[f.path,f.sha256])),binaryRelative=relative(root,binaryReal).split(sep).join('/');
  if(declared.get(binaryRelative)!==r.binarySha256)throw new Error('gateway.runtime_binary_manifest');
  const actual=(deps.listRuntimeFiles??listRuntimeFiles);const files=[...new Set([...(await actual(root)),binaryRelative])].sort();
  if(files.length!==declared.size||files.some(file=>!declared.has(file)))throw new Error('gateway.runtime_unlisted_file');
  const protectedPaths=[root,binaryReal,ggufReal];
  for(const file of files){const full=resolve(root,file),info=await readLinkStat(full);let target=full;if(info.isSymbolicLink()){if(process.platform==='win32')throw new Error('gateway.runtime_symlink');target=await resolveReal(full);if(!within(root,target))throw new Error('gateway.runtime_symlink');}protectedPaths.push(target);if(await hash(full)!==declared.get(file))throw new Error('gateway.runtime_file_identity');}
  await(deps.verifyPathSecurity??verifyProtectedPaths)(protectedPaths);
  if(remote){if(await hash(r.tlsCertPath!)!==r.tlsCertSha256)throw new Error('gateway.certificate_identity');const key=await stat(r.tlsKeyPath!);if(process.platform!=='win32'&&(key.mode&0o077)!==0)throw new Error('gateway.tls_key_permissions');else if(process.platform==='win32')await verifyWindowsEmbeddingPermissions([r.tlsKeyPath!],true);}
  return Object.freeze({...r,runtimeRoot:root,binaryPath:binaryReal,ggufPath:ggufReal});
}

export class LocalEmbeddingGateway {
  private child?:ChildProcess; private server?:http.Server|https.Server; private activeAdmission?:symbol; private admissionClosed=false;
  private grantedAdmissionDeadlines=new Map<symbol,number>();
  private waitingAdmission?:{token:symbol,req:IncomingMessage,res:ServerResponse,deadline:number,timer:NodeJS.Timeout,resolve:(token:symbol|undefined)=>void,
    cancel:(busy:boolean)=>void,detach:()=>void}; private timer?:NodeJS.Timeout;
  private authorityTimerActive=false;
  private sockets=new Set<Socket>();private backendKeyDir?:string;private backendKeyPath?:string;private backendSecret?:Buffer;
  constructor(readonly receipt:GatewayReceipt,private readonly secret:Buffer,private readonly backendPort:number,
    private readonly deps:GatewayDependencies={}){if(secret.length<32)throw new Error('gateway.secret');}
  launchArgs():readonly string[]{return [...FIXED_ARGS(this.receipt.ggufPath,this.backendPort,this.receipt.mode),...(this.backendKeyPath?['--api-key-file',this.backendKeyPath]:[])];}
  async start():Promise<void>{
    if(this.child||this.server)throw new Error('gateway.already_started');
    this.admissionClosed=false;
    const actualHost=(this.deps.hostname??hostname)();if(actualHost!==this.receipt.hostId)throw new Error('gateway.host_identity');
    await(this.deps.revalidateLaunchFiles??revalidateLaunchFiles)(this.receipt);
    const version=await(this.deps.verifyBuild??verifyBinaryBuild)(this.receipt.binaryPath);if(!/build 11669, commit 620d2225c/.test(version))throw new Error('gateway.build_identity');
    await(this.deps.probeBackendPort??probeLoopbackPort)(this.backendPort);
    this.backendKeyDir=await mkdtemp(join(process.platform==='win32'?homedir():tmpdir(),'.total-recall-llama-'));this.backendKeyPath=join(this.backendKeyDir,'backend.key');
    this.backendSecret=randomBytes(32);
    try{if(process.platform==='win32')await protectNewWindowsEmbeddingDirectory(this.backendKeyDir);
      await writeFile(this.backendKeyPath,this.backendSecret.toString('hex'),{mode:0o600});if(process.platform!=='win32')await chmod(this.backendKeyPath,0o600);
      else await verifyWindowsEmbeddingPermissions([this.backendKeyPath],true);
      const spawnChild=this.deps.spawnChild??((file,args)=>spawn(file,args,{stdio:['ignore','ignore','ignore'],shell:false,windowsHide:true}));
      this.child=spawnChild(this.receipt.binaryPath,[...this.launchArgs()]);
      this.child.once('error',()=>void this.close());this.child.once('exit',()=>{if(this.server)void this.close();});
      const handler=(req:IncomingMessage,res:ServerResponse)=>void this.handle(req,res);
      if(this.receipt.tlsCertPath&&this.receipt.tlsKeyPath){const read=this.deps.read??readFile;this.server=https.createServer({cert:await read(this.receipt.tlsCertPath),key:await read(this.receipt.tlsKeyPath)},handler);}
      else this.server=http.createServer(handler);
      this.server.requestTimeout=35_000;this.server.headersTimeout=10_000;this.server.on('connection',socket=>{this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));});
      await this.waitForBackend();await this.warmBackend();if(this.child.exitCode!==null)throw new Error('gateway.backend_exited');await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.receipt.port??18089,this.receipt.listen??'127.0.0.1',()=>resolve());});
    }catch(error){await this.close();throw error;}
    this.authorityTimerActive=true;this.armAuthorityExpiry();
  }
  async close():Promise<void>{this.admissionClosed=true;this.waitingAdmission?.cancel(false);this.activeAdmission=undefined;this.grantedAdmissionDeadlines.clear();this.authorityTimerActive=false;if(this.timer)(this.deps.clearAuthorityTimer??clearTimeout)(this.timer);this.timer=undefined;for(const socket of this.sockets)socket.destroy();this.sockets.clear();if(this.server)await new Promise<void>(r=>this.server!.close(()=>r()));this.server=undefined;const child=this.child;this.child=undefined;if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise<void>(r=>child.once('exit',()=>r())),new Promise<void>(r=>setTimeout(r,2000))]);if(child.exitCode===null){child.kill('SIGKILL');await Promise.race([new Promise<void>(r=>child.once('exit',()=>r())),new Promise<void>(r=>setTimeout(r,1000))]);}}if(this.backendKeyDir)await rm(this.backendKeyDir,{recursive:true,force:true});this.backendKeyDir=undefined;this.backendKeyPath=undefined;this.backendSecret=undefined;}
  private armAuthorityExpiry():void{if(!this.authorityTimerActive)return;const remaining=new Date(this.receipt.authorizedUntil).getTime()-(this.deps.now??(()=>new Date()))().getTime();if(remaining<=0){void this.close();return;}const schedule=this.deps.setAuthorityTimer??setTimeout;this.timer=schedule(()=>{this.timer=undefined;this.armAuthorityExpiry();},Math.min(remaining,MAX_AUTHORITY_TIMER_DELAY_MS));this.timer.unref?.();}
  private authorized(req:IncomingMessage):boolean{
    const value=req.headers.authorization,expected=`Bearer ${this.secret.toString('utf8')}`;
    const a=createHash('sha256').update(typeof value==='string'?value:'').digest(),b=createHash('sha256').update(expected).digest();
    return timingSafeEqual(a,b)&&typeof value==='string';
  }
  private admissionNow():number{return this.deps.admissionNow?.()??performance.now();}
  private abandoned(req:IncomingMessage,res:ServerResponse):boolean{return req.aborted||res.destroyed||res.writableEnded||!!req.socket?.destroyed;}
  private async acquireAdmission(req:IncomingMessage,res:ServerResponse):Promise<symbol|undefined>{
    if(this.admissionClosed){respond(res,503,{error:'gateway.closed'});return;}
    if(this.abandoned(req,res))return;
    const token=Symbol('gateway-admission');if(!this.activeAdmission){this.activeAdmission=token;return token;}
    if(this.waitingAdmission){respond(res,429,{error:'busy'});return;}
    return new Promise<symbol|undefined>(resolve=>{
      const deadline=this.admissionNow()+MAX_ADMISSION_WAIT_MS;
      let finished=false;const detach=()=>{req.removeListener('aborted',cancel);res.removeListener?.('close',cancel);req.socket?.removeListener?.('close',cancel);};
      const finish=(busy:boolean)=>{if(finished)return;finished=true;(this.deps.clearAdmissionTimer??clearTimeout)(timer);detach();if(this.waitingAdmission?.token===token)this.waitingAdmission=undefined;
        if(busy&&!res.writableEnded&&!res.destroyed)respond(res,429,{error:'busy'});resolve(undefined);};
      const cancel=()=>finish(false),timer=(this.deps.setAdmissionTimer??setTimeout)(()=>finish(true),MAX_ADMISSION_WAIT_MS);timer.unref?.();
      req.once('aborted',cancel);res.once?.('close',cancel);req.socket?.once?.('close',cancel);
      this.waitingAdmission={token,req,res,deadline,timer,resolve,cancel:finish,detach};
    });
  }
  private validateGrantedAdmission(token:symbol,req:IncomingMessage,res:ServerResponse,deadline?:number):boolean{
    if(this.admissionClosed||this.activeAdmission!==token||this.abandoned(req,res)){this.releaseAdmission(token);return false;}
    if(deadline!==undefined&&this.admissionNow()>=deadline){respond(res,429,{error:'busy'});this.releaseAdmission(token);return false;}
    return true;
  }
  private releaseAdmission(token:symbol):void{
    if(this.activeAdmission!==token)return;
    const waiting=this.waitingAdmission;if(!waiting){this.activeAdmission=undefined;return;}
    if(this.abandoned(waiting.req,waiting.res)){waiting.cancel(false);this.activeAdmission=undefined;return;}
    if(this.admissionNow()>=waiting.deadline){waiting.cancel(true);this.activeAdmission=undefined;return;}
    this.waitingAdmission=undefined;(this.deps.clearAdmissionTimer??clearTimeout)(waiting.timer);waiting.detach();this.activeAdmission=waiting.token;
    this.grantedAdmissionDeadlines.set(waiting.token,waiting.deadline);waiting.resolve(waiting.token);
  }
  private async handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
    let admission: symbol|undefined;try{
      const remote=normalizeAddress(req.socket?.remoteAddress);if(this.receipt.allowedPeerAddresses&&!this.receipt.allowedPeerAddresses.includes(remote))return respond(res,403,{error:'peer_denied'});
      if(!['GET','POST'].includes(req.method??'')||!['/health','/tokenize','/v1/embeddings'].includes(req.url??''))return respond(res,404,{error:'not_found'});
      const declared=Number(req.headers['content-length']??0);if(!Number.isFinite(declared)||declared<0||declared>MAX_BODY)return respond(res,413,{error:'body_limit'});
      if(!this.authorized(req))return respond(res,401,{error:'unauthorized'});
      admission=await this.acquireAdmission(req,res);if(!admission)return;
      const deadline=this.grantedAdmissionDeadlines.get(admission);this.grantedAdmissionDeadlines.delete(admission);
      if(!this.validateGrantedAdmission(admission,req,res,deadline))return;
      const telemetry=req.url==='/health'?await this.guard():await this.commonGuard();
      if(req.method==='GET'&&req.url==='/health')return respond(res,200,{contractId:this.receipt.contractId,artifactSha256:this.receipt.artifactSha256,
        status:'ok',runtimeContract:this.receipt.runtimeContract,acceptanceReceiptSha256:this.receipt.acceptanceReceiptSha256,build:this.receipt.build,
        binarySha256:this.receipt.binarySha256,hostId:this.receipt.hostId,verifiedLaunch:true,telemetry});
      if(req.method!=='POST'||(req.url!=='/tokenize'&&req.url!=='/v1/embeddings'))return respond(res,404,{error:'not_found'});
      const body=await readJson(req);
      if(req.url==='/tokenize'){
        if(typeof body.content!=='string'||Buffer.byteLength(body.content)>1_048_576||body.add_special!==true)throw new Error('gateway.tokenize_shape');
        const data=await this.upstream('/tokenize',{content:body.content,add_special:true});validateTokens(data,1_048_576);
        return respond(res,200,data);
      }
      if(!Array.isArray(body.input)||body.input.length<1||body.input.length>4||body.truncate!==false||body.input.some((x:unknown)=>typeof x!=='string'))throw new Error('gateway.embedding_shape');
      let total=0;for(const input of body.input){const t=await this.upstream('/tokenize',{content:input,add_special:true});total+=validateTokens(t);}
      if(total>2000)throw new Error('gateway.token_limit');
      const data=await this.upstream('/v1/embeddings',{input:body.input,truncate:false});
      if(!Array.isArray(data.data)||data.data.length!==body.input.length||data.usage?.prompt_tokens!==total)throw new Error('gateway.upstream_shape');
      data.data.forEach((x:any,i:number)=>{if(x?.index!==i)throw new Error('gateway.upstream_order');projectQwenVector(x.embedding);});
      return respond(res,200,data);
    }catch(error){const failure=gatewayHttpFailure(error);return respond(res,failure.status,{error:failure.code});}finally{if(admission)this.releaseAdmission(admission);}
  }
  private async upstream(path:string,body:unknown):Promise<any>{
    if(path==='/v1/embeddings')await this.guard();else await this.commonGuard();
    const fetcher=this.deps.fetch??fetch;let response:Response;try{response=await fetcher(`http://127.0.0.1:${this.backendPort}${path}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${this.backendToken()}`},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30_000)});}catch{throw new Error('gateway.backend_unavailable');}
    if(!response.ok){await response.body?.cancel();throw new Error(`gateway.upstream_${response.status}`);}try{return JSON.parse(await boundedResponseText(response,path==='/tokenize'?MAX_TOKENIZER_RESPONSE:MAX_BODY));}catch(error){if(error instanceof Error&&error.message==='gateway.upstream_body_limit')throw error;throw new Error('gateway.upstream_shape');}
  }
  private async guard():Promise<GatewayTelemetry>{const now=this.deps.now?.()??new Date();if(now.getTime()>=new Date(this.receipt.authorizedUntil).getTime()){void this.close();throw new Error('gateway.authorization_expired');}let telemetry:GatewayTelemetry;try{telemetry=await(this.deps.telemetry??collectHostTelemetry)(this.receipt);}catch{throw new Error('gateway.resource_unavailable');}validateTelemetry(this.receipt,telemetry,now);return telemetry;}
  private async commonGuard():Promise<GatewayTelemetry>{
    if(this.receipt.mode==='cpu')return this.guard();
    const now=this.deps.now?.()??new Date();this.checkAuthority(now);let telemetry:GatewayTelemetry;
    try{telemetry=this.deps.commonTelemetry?await this.deps.commonTelemetry(this.receipt):{hostId:hostname(),mode:'gpu',...await collectCommonHostTelemetry(this.receipt)};}
    catch{throw new Error('gateway.resource_unavailable');}
    validateCommonTelemetry(this.receipt,telemetry,now);return telemetry;
  }
  private checkAuthority(now:Date):void{if(now.getTime()>=new Date(this.receipt.authorizedUntil).getTime()){void this.close();throw new Error('gateway.authorization_expired');}}
  private backendToken():string{if(!this.backendSecret)throw new Error('gateway.backend_secret');return this.backendSecret.toString('hex');}
  private async waitForBackend():Promise<void>{
    const fetcher=this.deps.fetch??fetch,deadline=performance.now()+120_000;
    while(performance.now()<deadline){
      if(!this.child||this.child.exitCode!==null||this.child.signalCode)throw new Error('gateway.backend_exited');
      await this.commonGuard();
      try{const response=await fetcher(`http://127.0.0.1:${this.backendPort}/health`,{headers:{authorization:`Bearer ${this.backendToken()}`},redirect:'error',signal:AbortSignal.timeout(1000)});
        if(response.ok){await response.body?.cancel();return;}await response.body?.cancel();}catch{}
      await new Promise(r=>setTimeout(r,100));
    }
    throw new Error('gateway.backend_not_ready');
  }
  private async warmBackend():Promise<void>{await this.guard();const response=await(this.deps.fetch??fetch)(`http://127.0.0.1:${this.backendPort}/v1/embeddings`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${this.backendToken()}`},body:JSON.stringify({input:['warmup'],truncate:false}),redirect:'error',signal:AbortSignal.timeout(120_000)});if(!response.ok)throw new Error('gateway.backend_warmup');const data=JSON.parse(await boundedResponseText(response));if(!Array.isArray(data.data)||data.data.length!==1)throw new Error('gateway.backend_warmup');projectQwenVector(data.data[0]?.embedding);}
}

async function readJson(req:IncomingMessage):Promise<any>{let size=0;const chunks:Buffer[]=[];const timer=setTimeout(()=>req.destroy(new Error('gateway.body_timeout')),10_000);timer.unref();try{for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>MAX_BODY)throw new Error('gateway.body_limit');chunks.push(b);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('gateway.request_json');}}finally{clearTimeout(timer);}}
function validateTokens(data:any,max=1_048_576):number{if(!Array.isArray(data?.tokens)||data.tokens.some((x:unknown)=>!Number.isSafeInteger(x)||Number(x)<0))throw new Error('gateway.tokenizer_shape');if(data.tokens.length>max)throw new Error('gateway.token_limit');return data.tokens.length;}
function respond(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}
function gatewayHttpFailure(error:unknown):{status:number;code:string}{const code=error instanceof Error&&/^gateway\.[a-z0-9_]+$/.test(error.message)?error.message:'gateway.failure';
  if(code==='gateway.body_limit')return{status:413,code};
  if(['gateway.request_json','gateway.tokenize_shape','gateway.embedding_shape','gateway.token_limit'].includes(code))return{status:400,code};
  if(code==='gateway.authorization_expired')return{status:403,code};
  if(['gateway.telemetry_stale','gateway.host_guard','gateway.gpu_guard','gateway.cpu_guard','gateway.resource_unavailable','gateway.backend_unavailable'].includes(code)||/^gateway\.upstream_(?:429|5\d\d)$/.test(code))return{status:503,code};
  return{status:502,code};}
function validateCommonTelemetry(r:GatewayReceipt,t:GatewayTelemetry,now:Date){const stamp=t.timestamp;if(t.hostId!==r.hostId||t.mode!==r.mode||!Number.isFinite(stamp)||Math.abs(now.getTime()-stamp)>5000)throw new Error('gateway.telemetry_stale');
  if(!Number.isFinite(t.availableBytes)||!Number.isFinite(t.diskFreeBytes)||!Number.isFinite(t.swapUsedBytes)||(t.availableBytes??-1)<r.host.minimumAvailableBytes||(t.diskFreeBytes??-1)<r.host.minimumDiskFreeBytes||(t.swapUsedBytes??-1)<0||(t.swapUsedBytes??Infinity)>r.host.maximumSwapUsedBytes||
    (r.host.platform==='linux'&&(!Number.isFinite(t.load1)||(t.load1??-1)<0||(t.load1??Infinity)>r.host.maximumLoad1!))||
    (r.host.platform==='win32'&&(!Number.isFinite(t.cpuUtilizationPercent)||(t.cpuUtilizationPercent??-1)<0||(t.cpuUtilizationPercent??Infinity)>100||(t.cpuUtilizationPercent??Infinity)>r.host.maximumCpuUtilizationPercent!)))throw new Error('gateway.host_guard');}
function validateTelemetry(r:GatewayReceipt,t:GatewayTelemetry,now:Date){validateCommonTelemetry(r,t,now);
  if(r.mode==='gpu'&&r.gpu&&(t.gpuDeviceUuid!==r.gpu.deviceUuid||!Number.isFinite(t.gpuTempC)||t.gpuTempC!<0||t.gpuTempC!>=85||!Number.isFinite(t.vramUsedMiB)||!Number.isFinite(t.vramTotalMiB)||t.vramUsedMiB!<0||t.vramTotalMiB!<=0||t.vramUsedMiB!>t.vramTotalMiB!||(t.vramTotalMiB!-t.vramUsedMiB!)<r.gpu.minimumFreeVramMiB))throw new Error('gateway.gpu_guard');
  if(r.mode==='cpu'&&r.cpu&&(!Number.isFinite(t.memoryPsiAvg10)||(t.memoryPsiAvg10??-1)<0||(t.memoryPsiAvg10??Infinity)>r.cpu.maximumMemoryPsiAvg10))throw new Error('gateway.cpu_guard');}
export async function collectHostTelemetry(r:GatewayReceipt):Promise<GatewayTelemetry>{
  const common=await collectCommonHostTelemetry(r);
  if(r.mode==='gpu'){
    const run=promisify(execFile);const {stdout}=await run('nvidia-smi',['--query-gpu=uuid,temperature.gpu,memory.used,memory.total','--format=csv,noheader,nounits'],{timeout:3000,maxBuffer:4096,windowsHide:true});
    const rows=stdout.trim().split(/\r?\n/).map(line=>{const [uuid,temp,used,total]=line.split(',').map(v=>v.trim());return{uuid,temp:Number(temp),used:Number(used),total:Number(total)};});
    if(!rows.length||rows.some(v=>!/^GPU-[A-Za-z0-9-]+$/.test(v.uuid)||![v.temp,v.used,v.total].every(Number.isFinite)||v.temp<0||v.temp>=85||v.used<0||v.total<=0||v.used>v.total))throw new Error('gateway.gpu_telemetry_shape');
    const selected=rows.find(v=>v.uuid===r.gpu?.deviceUuid);if(!selected)throw new Error('gateway.gpu_device');
    return{hostId:hostname(),mode:'gpu',...common,gpuDeviceUuid:selected.uuid,gpuTempC:selected.temp,vramUsedMiB:selected.used,vramTotalMiB:selected.total};
  }
  if(r.host.platform!=='linux')throw new Error('gateway.cpu_platform');
  const psi=await readFile('/proc/pressure/memory','utf8');
  const avg=Number(/some avg10=([0-9.]+)/.exec(psi)?.[1]??NaN);
  return{hostId:hostname(),mode:'cpu',...common,memoryPsiAvg10:avg};
}
type CommonHostTelemetry=Pick<GatewayTelemetry,'timestamp'|'availableBytes'|'diskFreeBytes'|'swapUsedBytes'|'load1'|'cpuUtilizationPercent'>;
let commonHostCache:{key:string;value:CommonHostTelemetry}|undefined;
async function collectCommonHostTelemetry(r:GatewayReceipt):Promise<CommonHostTelemetry>{
  const cacheKey=`${r.host.platform}:${r.host.diskPath}`,now=Date.now();if(commonHostCache?.key===cacheKey&&now-commonHostCache.value.timestamp<=750)return commonHostCache.value;
  const disk=await statfs(r.host.diskPath),diskFreeBytes=Number(disk.bavail)*Number(disk.bsize);
  if(r.host.platform==='linux'){
    const mem=await readFile('/proc/meminfo','utf8'),kb=(name:string)=>Number(new RegExp(`^${name}:\\s+(\\d+)`,'m').exec(mem)?.[1]??NaN)*1024;
    const value={timestamp:Date.now(),availableBytes:kb('MemAvailable'),diskFreeBytes,swapUsedBytes:kb('SwapTotal')-kb('SwapFree'),load1:loadavg()[0]};commonHostCache={key:cacheKey,value};return value;
  }
  const before=cpuCounters();await new Promise(resolve=>setTimeout(resolve,200));const after=cpuCounters(),cpuUtilizationPercent=cpuUtilization(before,after);
  const run=promisify(execFile);const command="$ErrorActionPreference='Stop';$p=@(Get-CimInstance Win32_PageFileUsage);if($p.Count -lt 1){throw 'telemetry unavailable'};$swap=($p|Measure-Object CurrentUsage -Sum).Sum*1MB;@{swapUsedBytes=[double]$swap}|ConvertTo-Json -Compress";
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{timeout:3000,maxBuffer:4096,windowsHide:true});let observed:any;try{observed=JSON.parse(stdout);}catch{throw new Error('gateway.host_telemetry_shape');}
  if(!Number.isFinite(observed?.swapUsedBytes))throw new Error('gateway.host_telemetry_shape');
  const value={timestamp:Date.now(),availableBytes:freemem(),diskFreeBytes,swapUsedBytes:observed.swapUsedBytes,cpuUtilizationPercent};commonHostCache={key:cacheKey,value};return value;
}
type CpuCounter={idle:number;total:number};
function cpuCounters():CpuCounter[]{return cpus().map(cpu=>{const values=Object.values(cpu.times);return{idle:cpu.times.idle,total:values.reduce((sum,value)=>sum+value,0)}});}
function cpuUtilization(before:CpuCounter[],after:CpuCounter[]):number{if(!before.length||before.length!==after.length)throw new Error('gateway.host_telemetry_shape');let idle=0,total=0;
  for(let i=0;i<before.length;i++){const idleDelta=after[i].idle-before[i].idle,totalDelta=after[i].total-before[i].total;if(!Number.isFinite(idleDelta)||!Number.isFinite(totalDelta)||idleDelta<0||totalDelta<=0||idleDelta>totalDelta)throw new Error('gateway.host_telemetry_shape');idle+=idleDelta;total+=totalDelta;}
  const value=100*(1-idle/total);if(!Number.isFinite(value)||value<0||value>100)throw new Error('gateway.host_telemetry_shape');return value;}
async function boundedResponseText(response:Response,max=MAX_BODY):Promise<string>{let size=0;const chunks:Uint8Array[]=[];if(!response.body)return'';for await(const chunk of response.body){size+=chunk.byteLength;if(size>max)throw new Error('gateway.upstream_body_limit');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}
async function hashFileStreaming(path:string):Promise<string>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
async function revalidateLaunchFiles(r:GatewayReceipt):Promise<void>{const expected=new Map(r.runtimeFiles.map(file=>[file.path,file.sha256]));
  const checks=[hashFileStreaming(r.binaryPath).then(value=>[value,r.binarySha256] as const),hashFileStreaming(r.ggufPath).then(value=>[value,r.artifactSha256] as const),
    ...r.runtimeFiles.map(file=>hashFileStreaming(resolve(r.runtimeRoot,file.path)).then(value=>[value,expected.get(file.path)!] as const))];
  if((await Promise.all(checks)).some(([actual,wanted])=>actual!==wanted))throw new Error('gateway.launch_identity');}
async function verifyProtectedPaths(paths:string[]):Promise<void>{if(process.platform==='win32'){await verifyWindowsEmbeddingPermissions(paths);return;}if(process.platform!=='linux')throw new Error('gateway.platform');const trusted=new Set([0,process.getuid?.()]);
  const checked=new Set<string>();for(const path of new Set(paths)){let current=path;while(!checked.has(current)){checked.add(current);const info=await stat(current);if(!trusted.has(info.uid)||(info.mode&0o022)!==0)throw new Error('gateway.path_permissions');const parent=dirname(current);if(parent===current)break;current=parent;}}}
async function verifyBinaryBuild(path:string):Promise<string>{const run=promisify(execFile);const result=await run(path,['--version'],{timeout:3000,maxBuffer:4096,windowsHide:true});return `${result.stdout}\n${result.stderr}`;}
function normalizeAddress(value?:string):string{return value?.startsWith('::ffff:')?value.slice(7):value??'';}
function isPrivateIpv4(value:string):boolean{const parts=value.split('.').map(Number);if(parts.length!==4||parts.some((v,i)=>!Number.isInteger(v)||v<0||v>255||String(v)!==value.split('.')[i]))return false;return parts[0]===10||(parts[0]===172&&parts[1]>=16&&parts[1]<=31)||(parts[0]===192&&parts[1]===168);}
function safeRelative(value:string):boolean{return value.length>0&&!value.includes('\\')&&!value.startsWith('/')&&!value.split('/').some(part=>!part||part==='.'||part==='..');}
function within(root:string,path:string):boolean{const rel=relative(root,path);return rel===''||(!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel));}
export async function listRuntimeFiles(root:string):Promise<string[]>{const output:string[]=[];async function walk(dir:string){for(const item of await readdir(dir,{withFileTypes:true})){const full=join(dir,item.name),rel=relative(root,full).split(sep).join('/');if(item.isDirectory())await walk(full);else if(item.isFile()||item.isSymbolicLink())output.push(rel);else throw new Error('gateway.runtime_entry_type');}}await walk(root);return output.sort();}
async function probeLoopbackPort(port:number):Promise<void>{await new Promise<void>((resolveProbe,reject)=>{const server=net.createServer();server.once('error',()=>reject(new Error('gateway.backend_port_busy')));server.listen(port,'127.0.0.1',()=>server.close(error=>error?reject(new Error('gateway.backend_port_probe')):resolveProbe()));});}
