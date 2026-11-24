import { readFile,writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { validateKeyReadOnly } from '../src/auth.js';
import { shutdown } from '../src/db.js';
import { contradictionPolicyFromEnv } from '../src/contradictions.js';
import { applyContradictionDecision,createContradictionDecision,previewContradictionResolution,
  reverseContradictionDecision,type ContradictionDecision,type ContradictionReviewReceipt } from '../src/contradiction-review.js';
dotenv.config();

type Options={mode:'preview'|'decide'|'apply'|'reverse';subject?:string;candidates:string[];input?:string;output?:string;
  decision?:'apply'|'reject';approvedBy?:string;approvedAt?:string;expiresAt?:string};
export function parseContradictionReviewCli(args:string[]):Options{
  let mode:Options['mode']|undefined;const options:Omit<Options,'mode'>={candidates:[]};
  for(let i=0;i<args.length;i++){const arg=args[i];
    if(['preview','decide','apply','reverse'].includes(arg)&&!mode)mode=arg as Options['mode'];
    else if(arg==='--subject')options.subject=args[++i];else if(arg==='--candidate')options.candidates.push(args[++i]);
    else if(arg==='--input')options.input=args[++i];else if(arg==='--output')options.output=args[++i];
    else if(arg==='--decision')options.decision=args[++i] as 'apply'|'reject';else if(arg==='--approved-by')options.approvedBy=args[++i];
    else if(arg==='--approved-at')options.approvedAt=args[++i];else if(arg==='--expires-at')options.expiresAt=args[++i];
    else throw new Error(`Unknown contradiction review option: ${arg}`);
  }
  if(!mode)throw new Error('Use preview, decide, apply, or reverse');return{mode,...options};
}
async function main(){
  const options=parseContradictionReviewCli(process.argv.slice(2));
  if(options.mode==='decide'){
    if(!options.input||!options.output||!options.decision||!options.approvedBy||!options.approvedAt||!options.expiresAt)
      throw new Error('decide requires input/output/decision/approved-by/approved-at/expires-at');
    const receipt=JSON.parse(await readFile(options.input,'utf8')) as ContradictionReviewReceipt;
    await writeFile(options.output,JSON.stringify(createContradictionDecision(receipt,options as Required<Pick<Options,'decision'|'approvedBy'|'approvedAt'|'expiresAt'>>),null,2),{mode:0o600});return;
  }
  const rawKey=process.env.CONTRADICTION_REVIEW_API_KEY?.trim();if(!rawKey)throw new Error('CONTRADICTION_REVIEW_API_KEY is required');
  const auth=await validateKeyReadOnly(rawKey);if(!auth)throw new Error('Invalid contradiction reviewer key');
  const policy=contradictionPolicyFromEnv();const environment=process.env.DEPLOYMENT_ENVIRONMENT?.trim();if(!environment)throw new Error('DEPLOYMENT_ENVIRONMENT is required');
  if(options.mode==='preview'){
    if(!options.subject||!options.output)throw new Error('preview requires subject, candidate(s), and output');
    const receipt=await previewContradictionResolution({auth,policy,environment,subjectId:options.subject,candidateIds:options.candidates});
    await writeFile(options.output,JSON.stringify(receipt,null,2),{mode:0o600});
    console.log(JSON.stringify({version:1,classification:receipt.classification.classification,confidence:receipt.classification.confidence,
      accessLevel:receipt.accessLevel,promptSources:receipt.promptSources.length,receiptFingerprint:receipt.receiptFingerprint}));return;
  }
  if(!options.input)throw new Error(`${options.mode} requires --input`);
  if(options.mode==='apply'){
    const result=await applyContradictionDecision(auth,policy,JSON.parse(await readFile(options.input,'utf8')) as ContradictionDecision);
    console.log(JSON.stringify({version:1,...result}));return;
  }
  const reversal=JSON.parse(await readFile(options.input,'utf8')) as {resolutionId:string;decisionFingerprint:string};
  console.log(JSON.stringify({version:1,reversed:await reverseContradictionDecision(auth,policy,reversal)}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error('[contradiction-review] failed:',error instanceof Error?error.message:String(error));process.exitCode=1;}).finally(()=>shutdown());
