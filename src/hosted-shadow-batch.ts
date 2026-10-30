import { performance } from 'node:perf_hooks';
import { planEmbeddingChunks, type ParentChunkPlan } from './embedding-chunks.js';
import { formatLocalEmbeddingInput } from './local-embedding-contract.js';
import { LocalEmbeddingError } from './local-embedding-client.js';
import type { EmbeddingClient } from './embedding-client.js';
import type { ShadowClaim, ClaimedSource, ShadowEmbeddingStore } from './shadow-embedding-store.js';
import { validateShadowLimits, type ShadowWorkerLimits, type ShadowBatchReceipt } from './shadow-embedding-worker.js';

export interface HostedPacking { maxInputs: number; maxTokens: number; maxRequestBytes: number }
interface Parent { claim: ShadowClaim; source: ClaimedSource; plan: ParentChunkPlan | null;
  role: 'document' | 'query'; texts: string[]; tokens: number[]; vectors: Array<number[] | undefined>; done: boolean }
export interface PackedReceipt extends ShadowBatchReceipt { hostedCalls: number; largestHostedInputs: number;
  planningMs: number; cloudMs: number; renewals: number; guardFailureCode?: string }

/** Cross-parent packing. One hosted call at a time; local tokenization is also serial.
 * Semantic chunks and per-parent generation/source/commit fences are unchanged.
 */
export async function runHostedPackedBatch(store: ShadowEmbeddingStore, client: EmbeddingClient,
  limits: ShadowWorkerLimits, packing: HostedPacking, guard: () => Promise<void>, signal?: AbortSignal): Promise<PackedReceipt> {
  validateShadowLimits(limits);
  for (const [key, min, max] of [['maxInputs',1,128],['maxTokens',1,32768],['maxRequestBytes',1024,1048576]] as const) {
    if (!Number.isSafeInteger(packing[key]) || packing[key] < min || packing[key] > max) throw new Error('embedding.hosted_batch_limit');
  }
  const started = performance.now();
  const receipt: PackedReceipt = { state:'bounded_batch_finished',completeParents:0,excludedParents:0,failedParents:0,
    retriedParents:0,staleParents:0,sourceBytes:0,tokens:0,vectors:0,elapsedMs:0,hostedCalls:0,largestHostedInputs:0,
    planningMs:0,cloudMs:0,renewals:0 };
  const controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(limits.maxElapsedMs), ...(signal ? [signal] : [])]);
  const live = new Map<string, ShadowClaim>();
  const parents: Parent[] = [];
  const key = (c: ShadowClaim) => `${c.parentType}:${c.parentId}`;
  let renewal = performance.now(), reservedTokens = 0;
  let checkpointing: Promise<void> | undefined;
  const checkpoint = (): Promise<void> => {
    if (checkpointing) return checkpointing;
    checkpointing = (async () => {
      if (combined.aborted) throw combined.reason instanceof LocalEmbeddingError ? combined.reason
        : new LocalEmbeddingError(signal?.aborted ? 'embedding.cancelled' : 'embedding.batch_stopped','retryable');
      try { await guard(); } catch (error) {
        if (error instanceof LocalEmbeddingError && error.code === 'embedding.gateway_busy') throw error;
        receipt.guardFailureCode=error instanceof Error && /^embedding\.[a-z0-9_.]+$/.test(error.message) ? error.message : 'embedding.host_metrics_unknown';
        throw new LocalEmbeddingError('embedding.resource_guard','retryable');
      }
      if (performance.now() - renewal >= 10000) {
        for (const c of live.values()) {
          if (!await store.renew(c)) throw new LocalEmbeddingError('embedding.claim_lost','retryable');
          receipt.renewals++;
        }
        renewal = performance.now();
      }
    })().finally(() => { checkpointing = undefined; });
    return checkpointing;
  };
  const heartbeat = setInterval(() => { void checkpoint().catch(error => controller.abort(error)); }, 10000);
  heartbeat.unref();
  let submitted = new Set<string>();
  try {
    for (let examined=0; examined<limits.maxParents; examined++) {
      await checkpoint();
      const claim = await store.claim(); if (!claim) break;
      live.set(key(claim),claim);
      if (claim.attempts >= limits.maxAttempts) {
        if (await store.settle(claim,'failed','embedding.retry_exhausted')) receipt.failedParents++; else receipt.staleParents++;
        live.delete(key(claim)); continue;
      }
      try {
        const source = await store.loadSource(claim);
        if (!source?.eligible) {
          const ok = source?.disposition==='future' && source.deferUntil
            ? await store.defer(claim,'embedding.valid_from_deferred',new Date(source.deferUntil.getTime()+1))
            : await store.settle(claim,'excluded',source ? `embedding.lifecycle_${source.disposition ?? 'excluded'}` : 'embedding.parent_deleted');
          if (!ok) receipt.staleParents++; else if (source?.disposition!=='future') receipt.excludedParents++;
          live.delete(key(claim)); continue;
        }
        const bytes=Buffer.byteLength(source.text,'utf8');
        if (bytes>limits.maxSourceBytes-receipt.sourceBytes) {
          if (!await store.defer(claim,'embedding.byte_budget')) receipt.staleParents++;
          live.delete(key(claim));
          if (bytes>limits.maxSourceBytes) throw new LocalEmbeddingError('embedding.parent_byte_budget','retryable');
          break;
        }
        receipt.sourceBytes+=bytes;
        const plan=claim.parentType==='memory' ? await planEmbeddingChunks(source.text,async text => {
          await checkpoint(); return client.countFormattedTokens(text,combined);
        }) : null;
        const role=plan ? 'document' : 'query';
        const texts=plan ? plan.chunks.map(c=>c.text) : [source.text];
        const tokens=plan ? plan.chunks.map(c=>c.tokens) : [await client.countFormattedTokens(formatLocalEmbeddingInput(source.text,'query'),combined)];
        if (role==='query' && tokens[0]>2000) throw new LocalEmbeddingError('embedding.request_token_limit','input');
        const total=tokens.reduce((a,b)=>a+b,0);
        if (total>limits.maxTokens-reservedTokens) {
          if (!await store.defer(claim,'embedding.token_budget')) receipt.staleParents++;
          live.delete(key(claim));
          if (total>limits.maxTokens) throw new LocalEmbeddingError('embedding.parent_token_budget','retryable');
          break;
        }
        reservedTokens+=total;
        parents.push({claim,source,plan,role,texts,tokens,vectors:Array(texts.length).fill(undefined),done:false});
      } catch (error) {
        if (error instanceof LocalEmbeddingError && error.classification==='input'
          || error instanceof Error && /^embedding\.(postgres_nul|invalid_unicode|input_type|parent_byte_limit|codepoint_over_token_limit)$/u.test(error.message)) {
          if (await store.settle(claim,'failed',error.message)) receipt.failedParents++; else receipt.staleParents++;
          live.delete(key(claim));
        } else throw error;
      }
    }
    receipt.planningMs=Math.round(performance.now()-started);
    for (const role of ['document','query'] as const) {
      const entries=parents.filter(p=>p.role===role).flatMap(parent=>parent.texts.map((text,index)=>({parent,text,index,tokens:parent.tokens[index]})));
      let cursor=0;
      while (cursor<entries.length) {
        await checkpoint();
        const group: typeof entries=[]; let tokens=0,bytes=512;
        while (cursor<entries.length && group.length<packing.maxInputs) {
          const entry=entries[cursor];
          const extra=Buffer.byteLength(JSON.stringify(formatLocalEmbeddingInput(entry.text,role)),'utf8')+1;
          if (tokens+entry.tokens>packing.maxTokens || bytes+extra>packing.maxRequestBytes) {
            if (!group.length) throw new LocalEmbeddingError('embedding.hosted_item_budget','input');
            break;
          }
          group.push(entry);tokens+=entry.tokens;bytes+=extra;cursor++;
        }
        submitted=new Set(group.map(e=>key(e.parent.claim)));
        const cloudStart=performance.now();
        const result=await client.embed(group.map(e=>e.text),role,combined);
        receipt.cloudMs+=Math.round(performance.now()-cloudStart);
        receipt.hostedCalls++;receipt.largestHostedInputs=Math.max(receipt.largestHostedInputs,group.length);
        receipt.tokens+=result.tokens.reduce((a,b)=>a+b,0);receipt.vectors+=result.vectors.length;
        if (result.tokens.length!==group.length || result.vectors.length!==group.length || receipt.tokens>limits.maxTokens)
          throw new LocalEmbeddingError('embedding.hosted_mapping','systemic');
        for (let i=0;i<group.length;i++) {
          const e=group[i];
          if (result.tokens[i]!==e.tokens) throw new LocalEmbeddingError('embedding.unstable_tokenizer','systemic');
          e.parent.vectors[e.index]=result.vectors[i];
        }
        submitted.clear();
        for (const p of parents) {
          if (p.done || p.vectors.some(v=>v===undefined)) continue;
          await checkpoint();
          const vectors=p.vectors as number[][];
          const ok=p.plan ? await store.commitMemory(p.claim,p.source,p.plan,vectors)
            : await store.commitSubscription(p.claim,p.source,vectors[0],p.tokens[0]);
          if (ok) receipt.completeParents++;
          else { receipt.staleParents++; await store.defer(p.claim,'embedding.source_changed'); }
          p.done=true;live.delete(key(p.claim));
        }
      }
    }
  } catch (error) {
    const e=combined.aborted && combined.reason instanceof LocalEmbeddingError ? combined.reason
      : error instanceof LocalEmbeddingError ? error : new LocalEmbeddingError('embedding.worker_failure','systemic');
    const control=['embedding.cancelled','embedding.batch_stopped','embedding.resource_guard','embedding.parent_byte_budget','embedding.parent_token_budget'].includes(e.code);
    for (const c of live.values()) {
      let ok:boolean;
      if (submitted.has(key(c)) && e.classification==='retryable' && !control && e.code!=='embedding.gateway_busy') {
        const exhausted=c.attempts+1>=limits.maxAttempts;
        ok=await store.settle(c,exhausted?'failed':'retry',exhausted?'embedding.retry_exhausted':e.code,
          exhausted?0:e.retryAfterMs??Math.min(1000*2**c.attempts,60000));
        if (ok) { if (exhausted)receipt.failedParents++;else receipt.retriedParents++; }
      } else ok=await store.defer(c,e.code,new Date(Date.now()+(e.code==='embedding.gateway_busy'?(e.retryAfterMs??1000):0)));
      if (!ok) receipt.staleParents++;
    }
    live.clear();receipt.stopCode=e.code;
    if (control || e.classification!=='retryable') { await store.pause(e.code);receipt.state='paused'; }
  } finally {
    clearInterval(heartbeat);
    if (checkpointing) await checkpointing.catch(()=>{});
    receipt.elapsedMs=Math.round(performance.now()-started);
  }
  return receipt;
}
