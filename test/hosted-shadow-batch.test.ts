import test from 'node:test';
import assert from 'node:assert/strict';
import {runHostedPackedBatch} from '../src/hosted-shadow-batch.js';
import {LocalEmbeddingError} from '../src/local-embedding-client.js';
import {formatLocalEmbeddingInput} from '../src/local-embedding-contract.js';
import type {ShadowEmbeddingStore,ShadowClaim,ClaimedSource} from '../src/shadow-embedding-store.js';
import type {EmbeddingClient} from '../src/embedding-client.js';
const limits={maxParents:20,maxSourceBytes:1000000,maxTokens:100000,maxElapsedMs:30000,maxAttempts:3};
const packing={maxInputs:128,maxTokens:32768,maxRequestBytes:1048576};
const count=async(s:string)=>Math.ceil(s.length/8)+1;
function fixture(n=20){
 let cursor=0;const commits:any[]=[],defers:any[]=[],settles:any[]=[],pauses:string[]=[],calls:any[]=[];
 const claims=Array.from({length:n},(_,i)=>({contractId:'fixture',parentType:'memory' as const,parentId:String(i),generation:'1',owner:'owner',attempts:0}));
 const sources:ClaimedSource[]=claims.map((_,i)=>({text:`public synthetic parent ${i}`,revision:1,sha256:'fixture',eligible:true}));
 const store={claim:async()=>claims[cursor++]??null,loadSource:async(c:ShadowClaim)=>sources[+c.parentId],renew:async()=>true,
  defer:async(...a:any[])=>{defers.push(a);return true;},settle:async(...a:any[])=>{settles.push(a);return true;},
  pause:async(code:string)=>{pauses.push(code);},commitMemory:async(...a:any[])=>{commits.push(a);return true;},
  commitSubscription:async(...a:any[])=>{commits.push(a);return true;}} as unknown as ShadowEmbeddingStore;
 const client:EmbeddingClient={countFormattedTokens:count,embed:async(texts,role)=>{calls.push({texts,role});return {
  tokens:await Promise.all(texts.map(t=>count(formatLocalEmbeddingInput(t,role)))),vectors:texts.map(t=>[Number(t.match(/\d+$/)?.[0]??0)+1])};}};
 return{store,client,claims,sources,commits,defers,settles,pauses,calls};
}
test('packs twenty independent parents in one cloud call with exact per-parent mapping',async()=>{
 const f=fixture();const r=await runHostedPackedBatch(f.store,f.client,limits,packing,async()=>{});
 assert.equal(r.completeParents,20);assert.equal(r.hostedCalls,1);assert.equal(r.largestHostedInputs,20);
 assert.equal(f.calls.length,1);assert.equal(f.commits.length,20);assert.equal(r.vectors,20);
 for(const [claim,,plan,vectors]of f.commits){assert.equal(vectors[0][0],Number(claim.parentId)+1);assert.equal(plan.chunks.length,1);}
 assert.deepEqual(f.pauses,[]);assert.deepEqual(f.defers,[]);
});
test('respects transport input and token caps independently of per-parent checkpoints',async()=>{
 const f=fixture(12);const r=await runHostedPackedBatch(f.store,f.client,limits,{...packing,maxInputs:4,maxTokens:16},async()=>{});
 assert.equal(r.completeParents,12);assert.ok(f.calls.length>=3);
 for(const c of f.calls){assert.ok(c.texts.length<=4);assert.ok((await Promise.all(c.texts.map((s:string)=>count(s)))).reduce((a,b)=>a+b,0)<=16);}
});
test('separates query/document formatting without losing subscription attribution',async()=>{
 const f=fixture(3);f.claims[1].parentType='subscription' as any;
 const r=await runHostedPackedBatch(f.store,f.client,limits,packing,async()=>{});
 assert.equal(r.completeParents,3);assert.deepEqual(f.calls.map(c=>c.role),['document','query']);assert.equal(f.commits.length,3);
});
test('provider retry applies once only to parents actually submitted, not all staged parents',async()=>{
 const f=fixture(12);f.client.embed=async()=>{throw new LocalEmbeddingError('embedding.openrouter_http_429','retryable',5000);};
 const r=await runHostedPackedBatch(f.store,f.client,limits,{...packing,maxInputs:4},async()=>{});
 assert.equal(r.retriedParents,4);assert.equal(r.failedParents,0);assert.equal(f.settles.length,4);assert.equal(f.defers.length,8);
 assert.ok(f.settles.every(x=>x[1]==='retry'&&x[3]===5000));assert.equal(f.commits.length,0);assert.deepEqual(f.pauses,[]);
});
test('resource stop defers all staged claims without attempts and pauses before any publication',async()=>{
 const f=fixture();let guards=0;
 const r=await runHostedPackedBatch(f.store,f.client,limits,packing,async()=>{if(++guards===7)throw new Error('resource');});
 assert.equal(r.state,'paused');assert.equal(r.stopCode,'embedding.resource_guard');assert.equal(r.retriedParents,0);
 assert.equal(r.failedParents,0);assert.equal(f.settles.length,0);assert.equal(f.commits.length,0);assert.ok(f.defers.length>0);
});
test('explicit cancellation after paid response records usage but cannot commit',async()=>{
 const f=fixture(4);const abort=new AbortController();const embed=f.client.embed.bind(f.client);
 f.client.embed=async(...args)=>{const r=await embed(...args);abort.abort();return r;};
 const r=await runHostedPackedBatch(f.store,f.client,limits,packing,async()=>{},abort.signal);
 assert.equal(r.state,'paused');assert.equal(r.stopCode,'embedding.cancelled');assert.equal(r.vectors,4);assert.ok(r.tokens>0);
 assert.equal(f.commits.length,0);assert.equal(f.defers.length,4);assert.equal(r.retriedParents,0);
});
test('a source revision race is deferred independently while unrelated parents commit',async()=>{
 const f=fixture(3);const original=f.store.commitMemory.bind(f.store);f.store.commitMemory=async(...a)=>a[0].parentId==='1'?false:original(...a);
 const r=await runHostedPackedBatch(f.store,f.client,limits,packing,async()=>{});
 assert.equal(r.completeParents,2);assert.equal(r.staleParents,1);assert.equal(f.defers[0][1],'embedding.source_changed');
});
test('budget deferral cannot drop already planned parents or exceed source budget',async()=>{
 const f=fixture(5);const r=await runHostedPackedBatch(f.store,f.client,{...limits,maxSourceBytes:30},packing,async()=>{});
 assert.equal(r.completeParents,1);assert.ok(r.sourceBytes<=30);assert.equal(f.defers.length,1);assert.equal(f.commits.length,1);
});
test('systemic batch mismatch pauses without blaming or retry-stamping the whole corpus',async()=>{
 const f=fixture(5);f.client.embed=async()=>{throw new LocalEmbeddingError('embedding.openrouter_token_accounting','systemic');};
 const r=await runHostedPackedBatch(f.store,f.client,limits,packing,async()=>{});
 assert.equal(r.state,'paused');assert.equal(r.failedParents,0);assert.equal(r.retriedParents,0);assert.equal(f.defers.length,5);
 assert.equal(f.settles.length,0);assert.equal(f.commits.length,0);
});
test('invalid cloud packing limits fail before claiming or sending',async()=>{
 const f=fixture();await assert.rejects(runHostedPackedBatch(f.store,f.client,limits,{...packing,maxInputs:1025},async()=>{}),/hosted_batch_limit/);
 assert.equal(f.calls.length,0);assert.equal(f.commits.length,0);
});
