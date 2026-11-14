import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {LocalEmbeddingClient} from '../src/local-embedding-client.js';
import {QWEN_CHUNK_CONTRACT,QWEN_CONTRACT_ID} from '../src/local-embedding-contract.js';
import {evaluateLocalEmbeddingFixtureRanking} from '../src/local-embedding-fixture-ranking.js';

// Only accepts a separately pinned export of the fixed public synthetic fixtures.
// The launcher owns resource caps, host/duty monitoring and process cleanup.
async function main(){
  const [referencePath,expectedSha,launchIdentityPath,expectedLaunchIdentitySha,url,keyFile,output]=process.argv.slice(2);
  if(process.argv.length!==9||![expectedSha,expectedLaunchIdentitySha].every(value=>value?.match(/^[a-f0-9]{64}$/)))throw new Error('runtime.arguments');
  const bytes=await readFile(referencePath);
  if(bytes.length>4*1024**2||createHash('sha256').update(bytes).digest('hex')!==expectedSha)throw new Error('runtime.reference_identity');
  const launchBytes=await readFile(launchIdentityPath);
  if(launchBytes.length>1024**2||createHash('sha256').update(launchBytes).digest('hex')!==expectedLaunchIdentitySha)throw new Error('runtime.launch_identity');
  const launch=JSON.parse(launchBytes.toString('utf8'));
  if(launch.schema!==1||launch.mode!=='cpu'||launch.contractId!==QWEN_CONTRACT_ID||
    launch.artifactSha256!==QWEN_CHUNK_CONTRACT.artifactSha256||launch.runtimeContract!==QWEN_CHUNK_CONTRACT.runtimeContract||
    !/^[a-f0-9]{64}$/.test(launch.binarySha256)||!/^[a-f0-9]{64}$/.test(launch.runtimeFilesSha256)||
    !/^[a-f0-9]{64}$/.test(launch.libgompSha256)||launch.nativeBuild!=='b11669'||
    typeof launch.cpuLimit!=='number'||!Number.isFinite(launch.cpuLimit)||launch.cpuLimit<=0||launch.cpuLimit>2||
    !Number.isSafeInteger(launch.memoryLimitBytes)||launch.memoryLimitBytes<=0||launch.memoryLimitBytes>2147483648)
    throw new Error('runtime.launch_identity');
  const data=JSON.parse(bytes.toString('utf8'));
  if(data.scope!=='fixed-public-synthetic-fixtures-only'||data.contractId!==QWEN_CONTRACT_ID||
    !/^[a-f0-9]{64}$/.test(data.fixtureSha256)||!Array.isArray(data.reference)||data.reference.length!==157)throw new Error('runtime.reference_shape');
  const client=new LocalEmbeddingClient({baseUrl:url,bearerToken:(await readFile(keyFile,'utf8')).trim(),
    runtime:{contractId:QWEN_CONTRACT_ID,artifactSha256:QWEN_CHUNK_CONTRACT.artifactSha256,
      runtimeContract:QWEN_CHUNK_CONTRACT.runtimeContract,acceptanceReceiptSha256:expectedSha},
    timeoutMs:120_000,beforeInference:async()=>{}});
  const deadline=AbortSignal.timeout(600_000),queries:number[]=[];
  await client.embed(['warmup'],'query',deadline);
  let minimumCosine=1,tokens=0,documentVectors=0,queryVectors=0;
  const observed:number[][]=[];
  const failures:Array<{index:number;cosine:number}>=[];
  for(let index=0;index<data.reference.length;index++){
    const item=data.reference[index];
    if(!item||typeof item.text!=='string'||!['document','query'].includes(item.role)||!Number.isSafeInteger(item.tokens)||
      !Array.isArray(item.vector)||item.vector.length!==768||item.vector.some((x:unknown)=>typeof x!=='number'||!Number.isFinite(x))||
      Math.abs(Math.sqrt(item.vector.reduce((sum:number,x:number)=>sum+x*x,0))-1)>.001)throw new Error('runtime.reference_shape');
    const started=performance.now(),actual=await client.embed([item.text],item.role,deadline);
    if(item.role==='query'){queries.push(performance.now()-started);queryVectors++;}else documentVectors++;
    if(actual.tokens[0]!==item.tokens)throw new Error('runtime.tokenizer_parity');
    tokens+=actual.tokens[0];
    observed.push(actual.vectors[0]);
    const cosine=actual.vectors[0].reduce((sum,n,j)=>sum+n*item.vector[j],0);
    minimumCosine=Math.min(minimumCosine,cosine);
    if(cosine<.999)failures.push({index,cosine});
  }
  queries.sort((a,b)=>a-b);
  if(queries.length!==50||queryVectors!==50||documentVectors!==107||documentVectors+queryVectors!==157)throw new Error('runtime.reference_cardinality');
  const queryP95Ms=queries[Math.ceil(queries.length*.95)-1];
  // Each fixed fixture's document chunks precede its query. Rank parents by
  // maximum chunk cosine, exactly as production does. Preserve chunk diagnostics.
  const ranking=evaluateLocalEmbeddingFixtureRanking(data.reference,observed,.005);
  const receipt={scope:'public-synthetic-validator-cpu-versus-accepted-cuda',status:!failures.length&&!ranking.parentInversions&&queryP95Ms<=1500?'pass':'fail',
    referenceSha256:expectedSha,launchIdentitySha256:expectedLaunchIdentitySha,fixtureSha256:data.fixtureSha256,contractId:QWEN_CONTRACT_ID,
    documentVectors,queryVectors,vectors:documentVectors+queryVectors,tokens,minimumCosine,failures,
    ranking,warmQueryP95Ms:queryP95Ms,createdAt:new Date().toISOString(),
    limitations:['Not production relevance acceptance','Validator duty receipt required separately']};
  await writeFile(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  // Fixed public fixtures only: retain numerical diagnostics for a failed gate
  // so investigation never needs repeated model runs or private corpus export.
  await writeFile(output+'.synthetic-vectors.json',JSON.stringify({referenceSha256:expectedSha,vectors:observed})+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(receipt));
  if(receipt.status!=='pass')process.exitCode=1;
}
main().catch(()=>{console.error('runtime.validator_acceptance_failed');process.exitCode=1;});
