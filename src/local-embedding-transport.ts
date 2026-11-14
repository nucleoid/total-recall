import { createHash, X509Certificate } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import https from 'node:https';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { isIP } from 'node:net';

const SHA256=/^[a-f0-9]{64}$/u;
const MAX_RESPONSE_BYTES=16*1024*1024;
const MAX_CA_BYTES=1024*1024;
export interface PinnedTlsTransport { caPath:string; caSha256:string; spkiSha256:string }
export function verifyPinnedServerIdentity(host:string,certificate:PeerCertificate,expectedSpkiSha256:string,
  hostnameVerifier:typeof checkServerIdentity=checkServerIdentity,
  extractSpki:(certificate:PeerCertificate)=>Buffer=cert=>Buffer.from(new X509Certificate(cert.raw).publicKey.export({type:'spki',format:'der'}))):Error|undefined {
  const hostnameError=hostnameVerifier(host,certificate);if(hostnameError)return hostnameError;
  try {if(createHash('sha256').update(extractSpki(certificate)).digest('hex')!==expectedSpkiSha256)return new Error('embedding.tls_spki_identity');}
  catch{return new Error('embedding.tls_spki_identity');}
  return undefined;
}

export function createPinnedTlsFetch(config:PinnedTlsTransport):typeof fetch{
  if(!config||typeof config.caPath!=='string'||!config.caPath.trim()||!SHA256.test(config.caSha256)||!SHA256.test(config.spkiSha256)) {
    throw new Error('embedding.tls_identity');
  }
  const fd=openSync(config.caPath,'r');let ca:Buffer;
  try {const size=fstatSync(fd).size;if(!Number.isSafeInteger(size)||size<1||size>MAX_CA_BYTES)throw new Error('embedding.tls_ca_size');
    ca=Buffer.allocUnsafe(size);let offset=0;while(offset<size){const read=readSync(fd,ca,offset,size-offset,offset);if(read===0)throw new Error('embedding.tls_ca_read');offset+=read;}}
  finally{closeSync(fd);}
  if(createHash('sha256').update(ca).digest('hex')!==config.caSha256)throw new Error('embedding.tls_ca_identity');
  const agent=new https.Agent({keepAlive:false,maxCachedSessions:0,ca,rejectUnauthorized:true});
  return (async(input:URL|string|Request,init?:RequestInit):Promise<Response>=>{
    const url=input instanceof URL?input:new URL(typeof input==='string'?input:input.url);
    if(url.protocol!=='https:')throw new Error('embedding.tls_endpoint');
    if(init?.redirect&&init.redirect!=='error')throw new Error('embedding.redirect_policy');
    const headers=new Headers(init?.headers);
    const body=typeof init?.body==='string'||Buffer.isBuffer(init?.body)?init.body:undefined;
    if(init?.body!==undefined&&body===undefined)throw new Error('embedding.request_body');
    return await new Promise<Response>((resolve,reject)=>{
      let settled=false;
      const fail=(error:unknown)=>{if(settled)return;settled=true;reject(error);};
      const request=https.request(url,{method:init?.method??'GET',headers:Object.fromEntries(headers.entries()),agent,
        rejectUnauthorized:true,servername:isIP(url.hostname)?undefined:url.hostname,checkServerIdentity:(host,certificate)=>
          verifyPinnedServerIdentity(host,certificate as PeerCertificate,config.spkiSha256)},response=>{
          const chunks:Buffer[]=[];let size=0;
          const status=response.statusCode??500;if(status>=300&&status<400){response.resume();fail(new Error('embedding.redirect_policy'));return;}
          response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_RESPONSE_BYTES){request.destroy(new Error('embedding.response_body_limit'));return;}chunks.push(Buffer.from(chunk));});
          response.once('error',fail);response.once('end',()=>{if(settled)return;try{const noBody=status===204||status===205||status===304;
            const built=new Response(noBody?null:Buffer.concat(chunks),{status,statusText:response.statusMessage,headers:response.headers as Record<string,string>});settled=true;resolve(built);
          }catch(error){fail(error);}});
        });
      request.once('error',fail);
      const abort=()=>request.destroy(init?.signal?.reason instanceof Error?init.signal.reason:new Error('embedding.cancelled'));
      if(init?.signal){if(init.signal.aborted)abort();else init.signal.addEventListener('abort',abort,{once:true});request.once('close',()=>init.signal?.removeEventListener('abort',abort));}
      if(body!==undefined)request.write(body);request.end();
    });
  }) as typeof fetch;
}
