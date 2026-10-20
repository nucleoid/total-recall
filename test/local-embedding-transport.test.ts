import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,X509Certificate } from 'node:crypto';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { createPinnedTlsFetch, verifyPinnedServerIdentity } from '../src/local-embedding-transport.js';

test('pinned TLS transport requires an exact retained CA and SPKI identity',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'embedding-tls-')),path=join(dir,'ca.pem'),bytes='synthetic-ca';
  try{
    await writeFile(path,bytes,{mode:0o600});
    assert.throws(()=>createPinnedTlsFetch({caPath:path,caSha256:'0'.repeat(64),spkiSha256:'1'.repeat(64)}),/tls_ca_identity/);
    const fetcher=createPinnedTlsFetch({caPath:path,caSha256:createHash('sha256').update(bytes).digest('hex'),spkiSha256:'1'.repeat(64)});
    await assert.rejects(fetcher('http://127.0.0.1/'),/tls_endpoint/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('peer verification requires both hostname validation and the approved SPKI on every handshake',()=>{
  const spki=Buffer.from('synthetic-spki'),expected=createHash('sha256').update(spki).digest('hex'),certificate={} as never;
  assert.equal(verifyPinnedServerIdentity('runtime.internal',certificate,expected,()=>undefined,()=>spki),undefined);
  assert.match(verifyPinnedServerIdentity('runtime.internal',certificate,'0'.repeat(64),()=>undefined,()=>spki)!.message,/tls_spki_identity/);
  assert.equal(verifyPinnedServerIdentity('wrong.internal',certificate,expected,()=>new Error('hostname mismatch'),()=>spki)!.message,'hostname mismatch');
});

test('actual localhost TLS enforces CA, hostname and SPKI and bounds responses',async()=>{
  const fixture=new URL('./fixtures/local-embedding-tls/',import.meta.url),cert=await readFile(new URL('server-cert.pem',fixture)),key=await readFile(new URL('server-key.pem',fixture));
  const spki=Buffer.from(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'}));
  const config={caPath:fileURLToPath(new URL('server-cert.pem',fixture)),
    caSha256:createHash('sha256').update(cert).digest('hex'),spkiSha256:createHash('sha256').update(spki).digest('hex')};
  const server=https.createServer({cert,key},(request,response)=>{
    if(request.url==='/empty'){response.writeHead(204);response.end();return;}
    if(request.url==='/redirect'){response.writeHead(302,{location:'/ok'});response.end();return;}
    if(request.url==='/large'){response.writeHead(200);response.end(Buffer.alloc(16*1024*1024+1));return;}
    response.writeHead(200,{'content-type':'application/json'});response.end('{"ok":true}');
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'localhost',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('test server address');
  try{
    const good=createPinnedTlsFetch(config),base=`https://localhost:${address.port}`;
    assert.deepEqual(await (await good(`${base}/ok`,{redirect:'error'})).json(),{ok:true});
    assert.equal((await good(`${base}/empty`,{redirect:'error'})).status,204);
    await assert.rejects(good(`${base}/redirect`,{redirect:'error'}),/redirect_policy/);
    await assert.rejects(good(`${base}/large`,{redirect:'error'}),/response_body_limit/);
    const wrongPin=createPinnedTlsFetch({...config,spkiSha256:'0'.repeat(64)});
    await assert.rejects(wrongPin(`${base}/ok`,{redirect:'error'}),/tls_spki_identity/);
    await assert.rejects(good(`https://127.0.0.1:${address.port}/ok`,{redirect:'error'}));
    const dir=await mkdtemp(join(tmpdir(),'embedding-untrusted-')),other=join(dir,'ca.pem');
    try{await writeFile(other,'not a certificate');const untrusted=createPinnedTlsFetch({...config,caPath:other,caSha256:createHash('sha256').update('not a certificate').digest('hex')});
      await assert.rejects(untrusted(`${base}/ok`,{redirect:'error'}));}finally{await rm(dir,{recursive:true,force:true});}
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('CA input is size bounded before allocation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'embedding-large-ca-')),path=join(dir,'ca.pem');
  try{await writeFile(path,Buffer.alloc(1024*1024+1));assert.throws(()=>createPinnedTlsFetch({caPath:path,caSha256:'0'.repeat(64),spkiSha256:'1'.repeat(64)}),/tls_ca_size/);}
  finally{await rm(dir,{recursive:true,force:true});}
});
