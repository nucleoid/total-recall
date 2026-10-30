import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import {parseShadowEmbeddingArguments,runPackedWorkerCommand} from './shadow-embeddings.js';
import {validateOperationalManifest} from '../src/shadow-embedding-control.js';
import {QWEN_CONTRACT_ID} from '../src/local-embedding-contract.js';

// An explicit additive execution approval. The base run/manifest, source identity and
// vector space remain frozen; only separately bounded cloud request packing changes.
async function main(){
 const argv=process.argv.slice(2),supplementPath=argv.shift(),approvedSha=argv.shift(),stage=Number(argv.shift());
 if(!supplementPath||!approvedSha||!/^[a-f0-9]{64}$/.test(approvedSha))throw new Error('embedding.packing_approval_required');
 const raw=await readFile(supplementPath);if(createHash('sha256').update(raw).digest('hex')!==approvedSha)throw new Error('embedding.packing_approval_identity');
 const s=JSON.parse(raw.toString());
 if(s.version!==1||s.contractId!==QWEN_CONTRACT_ID||s.hostedMaxConcurrency!==1||s.localServingMaxConcurrency!==1
   ||!/^[a-f0-9]{40}$/.test(s.implementationSha)||basename(process.cwd())!==s.implementationSha
   ||s.approvalRef!=='owner-2026-10-30T20:46Z-hosted-batching'||!Number.isSafeInteger(stage)||stage<1||stage>s.packing.maxInputs)
   throw new Error('embedding.packing_approval_identity');
 const args=parseShadowEmbeddingArguments(['worker',...argv]);
 if(args.runId!==s.runId||args.manifestSha256!==s.baseManifestSha256)throw new Error('embedding.packing_base_identity');
 const envelope=validateOperationalManifest(JSON.parse(await readFile(args.manifestPath!,'utf8')),args.manifestSha256!);
 if(envelope.manifest.source.releaseSha!==s.baseSourceSha||envelope.manifest.backfill?.maxConcurrency!==1)
   throw new Error('embedding.packing_base_identity');
 const connectionString=process.env.SHADOW_EMBEDDING_DATABASE_URL;
 if(!connectionString)throw new Error('embedding.operator_url_required');
 const pool=new pg.Pool({connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:30000,query_timeout:35000,
   application_name:'total-recall-hosted-packed-owner'});
 try{const result=await runPackedWorkerCommand(pool,args,envelope,{...s.packing,maxInputs:stage});
  console.log(JSON.stringify(result));
 }finally{await pool.end();}
}
main().catch(error=>{console.error(error instanceof Error&&/^embedding\.[a-z0-9_.]+$/.test(error.message)?error.message:'embedding.packed_worker_failure');process.exitCode=1;});
