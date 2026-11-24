import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { accessLevelSql, canAccessLevel } from './auth.js';
import { dbScopeFromAuth, withScopedClient } from './db.js';
import { HttpJsonGenerationProvider, type GenerationProvider } from './generation.js';
import { maximumAccessLevel } from './synthesis-policy.js';
import { classifyContradiction, policyAllowsScope, reserveContradictionUsage,
  type ContradictionClassification, type ContradictionPolicy } from './contradictions.js';
import type { AccessLevel, AuthContext } from './types.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64=/^[0-9a-f]{64}$/;
export const MAX_REVIEW_SOURCES=6;

type PromptSource={id:string;revision:number;contentHash:string;accessLevel:AccessLevel};
type MaterializedSource=PromptSource&{content:string};
export type ContradictionReviewReceipt={version:1;feature:'contradiction-reviewed-resolution';environment:string;
  createdAt:string;namespace:string;accessLevel:AccessLevel;subjectId:string;promptSources:PromptSource[];
  classification:ContradictionClassification;policyFingerprint:string;receiptFingerprint:string};
export type ContradictionDecision={version:1;receipt:ContradictionReviewReceipt;decision:'apply'|'reject';
  predecessorId:string|null;successorId:string;approvedBy:string;approvedAt:string;expiresAt:string;decisionFingerprint:string};

export function assertContradictionReviewerAuthority(auth:AuthContext,policy:ContradictionPolicy):void{
  const permissions=new Set(auth.permissions);
  if(!permissions.has('read')||!permissions.has('contradiction_resolve')||permissions.has('write')||permissions.has('admin')||permissions.has('delete'))
    throw new Error("Contradiction reviewer requires 'read,contradiction_resolve' without write, admin, or delete");
  if(!policy.namespace||!auth.namespaces.includes(policy.namespace)||!canAccessLevel(policy.accessLevel,auth.maxAccessLevel))
    throw new Error('Contradiction reviewer key does not authorize policy scope');
}

function hash(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex');}

export async function previewContradictionResolution(args:{auth:AuthContext;policy:ContradictionPolicy;
  environment:string;subjectId:string;candidateIds:string[];provider?:GenerationProvider;now?:Date}):Promise<ContradictionReviewReceipt>{
  assertContradictionReviewerAuthority(args.auth,args.policy);
  if(!args.policy.classificationEnabled||!args.policy.model||!args.policy.provider||!args.policy.endpoint||!args.policy.budget)
    throw new Error('Contradiction classification policy is disabled or incomplete');
  const namespace=args.policy.namespace!;
  const ids=[args.subjectId,...args.candidateIds];
  if(!UUID.test(args.subjectId)||args.candidateIds.length<1||ids.length>MAX_REVIEW_SOURCES||
      args.candidateIds.some(id=>!UUID.test(id))||new Set(ids).size!==ids.length) throw new Error('Review requires unique exact UUID sources within bounds');
  const rows=await withScopedClient(dbScopeFromAuth(args.auth),client=>client.query<MaterializedSource>(`
    SELECT id,content,revision,md5(content) AS "contentHash",access_level AS "accessLevel"
    FROM memories WHERE id=ANY($1::uuid[]) AND namespace=$2 AND memory_kind='semantic'
      AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>statement_timestamp())
      AND superseded_at IS NULL AND valid_to IS NULL AND valid_from<=statement_timestamp()
      AND consolidated_into_id IS NULL AND ${accessLevelSql('access_level','$3')} ORDER BY id`,[ids,namespace,args.auth.maxAccessLevel]));
  if(rows.rows.length!==ids.length)throw new Error('Review sources are missing, inactive, or outside current reader scope');
  const byId=new Map(rows.rows.map(row=>[row.id,row]));
  const subject=byId.get(args.subjectId)!;
  const candidates=args.candidateIds.map(id=>byId.get(id)!);
  const accessLevel=maximumAccessLevel(rows.rows.map(row=>row.accessLevel));
  if(!policyAllowsScope(args.policy,namespace,accessLevel))throw new Error('Review sources exceed approved policy access level');
  const provider=args.provider??new HttpJsonGenerationProvider({name:args.policy.provider,endpoint:args.policy.endpoint,apiKey:args.policy.apiKey});
  if(provider.name!==args.policy.provider)throw new Error('Contradiction provider does not match policy');
  const classification=await classifyContradiction(subject.content,candidates.map(row=>({id:row.id,content:row.content,similarity:1})),
    provider,args.policy.model,args.policy.timeoutMs,(input,output)=>reserveContradictionUsage(args.policy,input,output));
  const promptSources=rows.rows.map(({id,revision,contentHash,accessLevel})=>({id,revision,contentHash,accessLevel}));
  const unsigned={version:1 as const,feature:'contradiction-reviewed-resolution' as const,environment:args.environment,
    createdAt:(args.now??new Date()).toISOString(),namespace,accessLevel,subjectId:args.subjectId,
    promptSources,classification,policyFingerprint:args.policy.budget.fingerprint};
  return {...unsigned,receiptFingerprint:hash(unsigned)};
}

export function createContradictionDecision(receipt:ContradictionReviewReceipt,input:{decision:'apply'|'reject';approvedBy:string;
  approvedAt:string;expiresAt:string}):ContradictionDecision{
  validateReceipt(receipt);
  const predecessorId=input.decision==='apply'?receipt.classification.candidate_id:null;
  const unsigned={version:1 as const,receipt,decision:input.decision,predecessorId,successorId:receipt.subjectId,
    approvedBy:input.approvedBy,approvedAt:new Date(input.approvedAt).toISOString(),expiresAt:new Date(input.expiresAt).toISOString()};
  if(!input.approvedBy.trim()||!Number.isFinite(Date.parse(input.approvedAt))||!Number.isFinite(Date.parse(input.expiresAt))||
      Date.parse(input.expiresAt)<=Date.parse(input.approvedAt))throw new Error('Decision approval metadata is invalid');
  return {...unsigned,decisionFingerprint:hash(unsigned)};
}

export async function applyContradictionDecision(auth:AuthContext,policy:ContradictionPolicy,decision:ContradictionDecision,
  now=new Date()):Promise<{resolutionId:string;alreadyApplied:boolean}>{
  assertContradictionReviewerAuthority(auth,policy); validateDecision(decision,now);
  if(decision.decision!=='apply'||decision.receipt.classification.classification!=='contradiction'||
      decision.receipt.classification.confidence<policy.mutationConfidence||!decision.predecessorId)
    throw new Error('Only an approved high-confidence contradiction receipt can be applied');
  if(decision.receipt.policyFingerprint!==policy.budget?.fingerprint||decision.receipt.namespace!==policy.namespace)
    throw new Error('Decision policy does not match current reviewed policy');
  return withScopedClient(dbScopeFromAuth(auth),async client=>{
    const existing=await client.query<{id:string;status:string}>('SELECT id,status FROM contradiction_resolutions WHERE decision_fingerprint=$1',[decision.decisionFingerprint]);
    if(existing.rows[0]){if(existing.rows[0].status!=='applied')throw new Error('Contradiction decision was already reversed');return{resolutionId:existing.rows[0].id,alreadyApplied:true};}
    const result=await client.query<{id:string}>(`SELECT public.apply_reviewed_contradiction_resolution(
      $1,$2,$3::uuid,$4::uuid,$5::jsonb,$6,$7) AS id`,[decision.receipt.namespace,decision.receipt.accessLevel,
      decision.predecessorId,decision.successorId,JSON.stringify(decision.receipt.promptSources),
      decision.receipt.receiptFingerprint,decision.decisionFingerprint]);
    return{resolutionId:result.rows[0].id,alreadyApplied:false};
  });
}

export async function reverseContradictionDecision(auth:AuthContext,policy:ContradictionPolicy,input:{resolutionId:string;
  decisionFingerprint:string}):Promise<string>{
  assertContradictionReviewerAuthority(auth,policy);
  if(!UUID.test(input.resolutionId)||!HEX64.test(input.decisionFingerprint))throw new Error('Invalid reversal receipt');
  return withScopedClient(dbScopeFromAuth(auth),async client=>(await client.query<{ok:string}>(
    'SELECT public.reverse_reviewed_contradiction_resolution($1::uuid,$2) AS ok',[input.resolutionId,input.decisionFingerprint])).rows[0].ok);
}

function validateReceipt(receipt:ContradictionReviewReceipt):void{
  const {receiptFingerprint,...unsigned}=receipt;
  if(receipt.version!==1||receipt.feature!=='contradiction-reviewed-resolution'||!HEX64.test(receiptFingerprint)||hash(unsigned)!==receiptFingerprint||
      receipt.promptSources.length<2||receipt.promptSources.length>MAX_REVIEW_SOURCES)throw new Error('Invalid contradiction review receipt');
}
function validateDecision(decision:ContradictionDecision,now:Date):void{
  validateReceipt(decision.receipt);const {decisionFingerprint,...unsigned}=decision;
  if(!HEX64.test(decisionFingerprint)||hash(unsigned)!==decisionFingerprint||Date.parse(decision.expiresAt)<=now.getTime())
    throw new Error('Contradiction decision is invalid or expired');
}
