import {createHmac} from 'node:crypto';
import {stableHash} from './evaluation.js';
import {planEmbeddingChunks} from './embedding-chunks.js';
import {getLocalServingClient} from './local-embedding-runtime.js';
import {formatLocalEmbeddingInput,QWEN_CONTRACT_ID,sha256,validateLocalStoredVector} from './local-embedding-contract.js';

export type PilotCategory='representative'|'hard_negative'|'code_name_multilingual'|'boundary';
export interface PilotParent{id:string;namespace:string;revision:number;sourceSha256:string;content:string;geminiProvider:'gemini';geminiModel:'gemini-embedding-2-preview';geminiDimensions:768;geminiSource:'original';geminiVector:number[]}
export interface PilotJudgment{id:string;query:string;expectedParentIds:string[];forbiddenParentIds:string[];category:PilotCategory;ownerCritical:boolean;reviewedNotes:string;geminiQueryVector:number[]}
export interface PilotInput{contractId:string;corpusHash:string;judgmentsHash:string;parents:PilotParent[];judgments:PilotJudgment[]}
export interface PilotApproval{expectedCorpusHash:string;expectedJudgmentsHash:string;baselineReceiptSha256:string;approvalReference:string}
export interface PilotReport{pilotOnly:true;contractId:string;inputHashes:{corpus:string;judgments:string};baselineReceiptSha256:string;approvalReference:string;metrics:{qwen:{recallAt10:number;mrr:number};gemini:{recallAt10:number;mrr:number};regression:number;targetOnlyMisses:number;criticalMisses:number;boundaryTop10Misses:number;hardNegativeViolations:number};passed:boolean;cases:Array<{id:string;expectedParentIds:string[];qwenRanks:number[];geminiRanks:number[];forbiddenQwenRanks:number[];forbiddenGeminiRanks:number[]}>}
export const PILOT_INPUT_MAX_BYTES=8*1024*1024;
const PILOT_PARENT_SOURCE_MAX_BYTES=1024*1024,PILOT_JUDGMENT_TEXT_MAX_BYTES=64*1024,PILOT_REVIEWED_NOTES_MAX_BYTES=8*1024,PILOT_JUDGMENT_TOTAL_MAX_BYTES=1024*1024;

export async function evaluateShadowPilot(input:PilotInput,approval:PilotApproval,pseudonymKey:Buffer,client=getLocalServingClient(),now=Date.now):Promise<PilotReport>{
  validateInput(input,approval);if(pseudonymKey.length<32)throw new Error('pilot.pseudonym_key');
  const pseudo=(kind:string,value:string)=>createHmac('sha256',pseudonymKey).update(`${kind}\0${value}`).digest('hex').slice(0,24);
  const deadline=now()+120_000,signal=AbortSignal.timeout(120_000),qwen=new Map<string,number[][]>();let tokens=0,vectors=0,bytes=0;
  for(const parent of input.parents){bytes+=Buffer.byteLength(parent.content);if(bytes>1_048_576)throw new Error('pilot.byte_budget');
    signal.throwIfAborted();const plan=await planEmbeddingChunks(parent.content,text=>client.countFormattedTokens(text,signal));
    tokens+=plan.chunks.reduce((n,c)=>n+c.tokens,0);vectors+=plan.chunks.length;if(tokens>50_000||vectors>4096)throw new Error('pilot.vector_budget');
    const out:number[][]=[];for(let i=0;i<plan.chunks.length;i+=4){signal.throwIfAborted();if(now()>deadline)throw new Error('pilot.time_budget');const batch=plan.chunks.slice(i,i+4),embedded=await client.embed(batch.map(c=>c.text),'document',signal);if(embedded.vectors.length!==batch.length||embedded.tokens.length!==batch.length||embedded.tokens.some((n,j)=>n!==batch[j].tokens))throw new Error('pilot.runtime_cardinality');out.push(...embedded.vectors);}qwen.set(parent.id,out);
  }
  const internal:Array<{judgment:PilotJudgment;qwenRanks:number[];geminiRanks:number[];forbiddenQwenRanks:number[];forbiddenGeminiRanks:number[]}>=[];
  for(const judgment of input.judgments){if(now()>deadline)throw new Error('pilot.time_budget');signal.throwIfAborted();const expectedTokens=await client.countFormattedTokens(formatLocalEmbeddingInput(judgment.query,'query'),signal),embedded=await client.embed([judgment.query],'query',signal);if(embedded.vectors.length!==1||embedded.tokens.length!==1||embedded.tokens[0]!==expectedTokens)throw new Error('pilot.runtime_cardinality');tokens+=expectedTokens;vectors++;if(tokens>50_000||vectors>4096)throw new Error('pilot.vector_budget');const qRank=rank(input.parents,p=>Math.max(...qwen.get(p.id)!.map(v=>cos(embedded.vectors[0],v)))),gRank=rank(input.parents,p=>cos(judgment.geminiQueryVector,p.geminiVector));internal.push({judgment,qwenRanks:ranks(qRank,judgment.expectedParentIds),geminiRanks:ranks(gRank,judgment.expectedParentIds),forbiddenQwenRanks:ranks(qRank,judgment.forbiddenParentIds),forbiddenGeminiRanks:ranks(gRank,judgment.forbiddenParentIds)});}
  const score=(field:'qwenRanks'|'geminiRanks')=>({recallAt10:mean(internal.map(c=>c[field].filter(r=>r<=10).length/c.judgment.expectedParentIds.length)),mrr:mean(internal.map(c=>{const rank=Math.min(...c[field]);return rank<=10?1/rank:0;}))});
  const qs=score('qwenRanks'),gs=score('geminiRanks');let targetOnlyMisses=0,criticalMisses=0,boundaryTop10Misses=0,hardNegativeViolations=0;
  internal.forEach(c=>{const anyMiss=c.qwenRanks.some(r=>r>10),baselineHasAll=c.geminiRanks.every(r=>r<=10);if(anyMiss&&baselineHasAll)targetOnlyMisses++;if(anyMiss&&c.judgment.ownerCritical)criticalMisses++;if(anyMiss&&c.judgment.category==='boundary')boundaryTop10Misses++;if(c.judgment.category==='hard_negative'&&c.forbiddenQwenRanks.some(r=>r<=10))hardNegativeViolations++;});
  const regression=gs.recallAt10-qs.recallAt10,passed=qs.recallAt10>=.9&&qs.mrr>=.75&&regression<=.05&&targetOnlyMisses<=2&&criticalMisses===0&&boundaryTop10Misses===0&&hardNegativeViolations===0;
  const cases=internal.map(c=>({id:pseudo('case',c.judgment.id),expectedParentIds:c.judgment.expectedParentIds.map(id=>pseudo('parent',id)),qwenRanks:c.qwenRanks,geminiRanks:c.geminiRanks,forbiddenQwenRanks:c.forbiddenQwenRanks,forbiddenGeminiRanks:c.forbiddenGeminiRanks}));
  return{pilotOnly:true,contractId:QWEN_CONTRACT_ID,inputHashes:{corpus:input.corpusHash,judgments:input.judgmentsHash},baselineReceiptSha256:approval.baselineReceiptSha256,approvalReference:approval.approvalReference,metrics:{qwen:qs,gemini:gs,regression,targetOnlyMisses,criticalMisses,boundaryTop10Misses,hardNegativeViolations},passed,cases};
}

export function validateInput(input:PilotInput,approval:PilotApproval):void{
  if(!approval||!/^([a-f0-9]{64})$/.test(approval.expectedCorpusHash)||!/^([a-f0-9]{64})$/.test(approval.expectedJudgmentsHash)||!/^([a-f0-9]{64})$/.test(approval.baselineReceiptSha256)||!approval.approvalReference?.trim())throw new Error('pilot.approval');
  if(input.contractId!==QWEN_CONTRACT_ID||input.parents.length<1||input.parents.length>200||input.judgments.length!==48)throw new Error('pilot.frozen_shape');
  const counts:Record<PilotCategory,number>={representative:0,hard_negative:0,code_name_multilingual:0,boundary:0},ids=new Set<string>();let parentBytes=0,judgmentBytes=0;
  for(const p of input.parents){if(ids.has(p.id)||!p.id||!p.namespace||typeof p.content!=='string'||!Number.isSafeInteger(p.revision)||p.revision<0||sha256(p.content)!==p.sourceSha256||p.geminiProvider!=='gemini'||p.geminiModel!=='gemini-embedding-2-preview'||p.geminiDimensions!==768||p.geminiSource!=='original')throw new Error('pilot.corpus_identity');parentBytes+=Buffer.byteLength(p.content);if(parentBytes>PILOT_PARENT_SOURCE_MAX_BYTES)throw new Error('pilot.byte_budget');ids.add(p.id);validateLocalStoredVector(p.geminiVector);}
  const qids=new Set<string>();for(const j of input.judgments){if(typeof j.query!=='string'||typeof j.reviewedNotes!=='string')throw new Error('pilot.judgment_identity');const queryBytes=Buffer.byteLength(j.query),noteBytes=Buffer.byteLength(j.reviewedNotes);judgmentBytes+=queryBytes+noteBytes;if(queryBytes>PILOT_JUDGMENT_TEXT_MAX_BYTES||noteBytes>PILOT_REVIEWED_NOTES_MAX_BYTES||judgmentBytes>PILOT_JUDGMENT_TOTAL_MAX_BYTES)throw new Error('pilot.byte_budget');if(qids.has(j.id)||!j.query||!j.reviewedNotes.trim()||!j.expectedParentIds.length||!Array.isArray(j.forbiddenParentIds)||new Set(j.expectedParentIds).size!==j.expectedParentIds.length||new Set(j.forbiddenParentIds).size!==j.forbiddenParentIds.length||j.expectedParentIds.some(id=>!ids.has(id))||j.forbiddenParentIds.some(id=>!ids.has(id)||j.expectedParentIds.includes(id))||(j.category==='hard_negative'&&!j.forbiddenParentIds.length))throw new Error('pilot.judgment_identity');qids.add(j.id);counts[j.category]++;validateLocalStoredVector(j.geminiQueryVector);}
  if(counts.representative!==28||counts.hard_negative!==8||counts.code_name_multilingual!==6||counts.boundary!==6)throw new Error('pilot.ground_truth_distribution');
  const corpusHash=stableHash(input.parents),judgmentsHash=stableHash(input.judgments);if(input.corpusHash!==corpusHash||input.judgmentsHash!==judgmentsHash||approval.expectedCorpusHash!==corpusHash||approval.expectedJudgmentsHash!==judgmentsHash)throw new Error('pilot.frozen_hash');
}
function cos(a:number[],b:number[]):number{return a.reduce((n,x,i)=>n+x*b[i],0);}
function rank(parents:PilotParent[],score:(p:PilotParent)=>number):string[]{return [...parents].sort((a,b)=>score(b)-score(a)||a.id.localeCompare(b.id)).map(p=>p.id);}
function ranks(order:string[],expected:string[]):number[]{return expected.map(id=>order.indexOf(id)+1);}
function mean(values:number[]):number{return values.reduce((a,b)=>a+b,0)/values.length;}
