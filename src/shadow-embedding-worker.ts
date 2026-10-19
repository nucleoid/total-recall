import { performance } from 'node:perf_hooks';
import { planEmbeddingChunks } from './embedding-chunks.js';
import { LocalEmbeddingClient, LocalEmbeddingError } from './local-embedding-client.js';
import { ShadowEmbeddingStore } from './shadow-embedding-store.js';
import { formatLocalEmbeddingInput } from './local-embedding-contract.js';

export interface ShadowWorkerLimits {
  maxParents: number;
  maxSourceBytes: number;
  maxTokens: number;
  maxElapsedMs: number;
  maxAttempts: number;
}

export interface ShadowBatchReceipt {
  state: 'bounded_batch_finished' | 'paused';
  completeParents: number;
  excludedParents: number;
  failedParents: number;
  retriedParents: number;
  staleParents: number;
  sourceBytes: number;
  tokens: number;
  vectors: number;
  elapsedMs: number;
  stopCode?: string;
}

export function validateShadowLimits(limits: ShadowWorkerLimits): void {
  for (const [name, min, max] of [
    ['maxParents', 1, 1000], ['maxSourceBytes', 1, 100_000_000], ['maxTokens', 1, 1_000_000],
    ['maxElapsedMs', 1000, 3_600_000], ['maxAttempts', 1, 10],
  ] as const) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < min || limits[name] > max) throw new Error(`embedding.limit_${name}`);
  }
}

/** Finite resumable execution. This does not install a service or imply whole-run completion. */
export async function runShadowBatch(store: ShadowEmbeddingStore, client: LocalEmbeddingClient,
  limits: ShadowWorkerLimits, resourceGuard: () => Promise<void>, signal?: AbortSignal): Promise<ShadowBatchReceipt> {
  validateShadowLimits(limits);
  const started = performance.now();
  const receipt: ShadowBatchReceipt = { state: 'bounded_batch_finished', completeParents: 0, excludedParents: 0,
    failedParents: 0, retriedParents: 0, staleParents: 0, sourceBytes: 0, tokens: 0, vectors: 0, elapsedMs: 0 };
  let examined = 0;
  const deadline = AbortSignal.timeout(limits.maxElapsedMs);
  const batchSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const pause = async (code: string) => {
    await store.pause(code); receipt.state = 'paused'; receipt.stopCode = code;
  };
  while (examined < limits.maxParents && performance.now() - started < limits.maxElapsedMs) {
    if (batchSignal.aborted) { await pause(signal?.aborted ? 'embedding.cancelled' : 'embedding.batch_stopped'); break; }
    try { await resourceGuard(); } catch { await pause('embedding.resource_guard'); break; }
    const claim = await store.claim();
    if (!claim) break;
    examined++;
    if (claim.attempts >= limits.maxAttempts) {
      if (await store.settle(claim, 'failed', 'embedding.retry_exhausted')) receipt.failedParents++;
      else { receipt.staleParents++; break; }
      continue;
    }
    let lastRenewal = performance.now();
    const checkpoint = async () => {
      if (batchSignal.aborted || performance.now() - started >= limits.maxElapsedMs) {
        throw new LocalEmbeddingError(signal?.aborted ? 'embedding.cancelled' : 'embedding.batch_stopped', 'retryable');
      }
      try { await resourceGuard(); } catch { throw new LocalEmbeddingError('embedding.resource_guard', 'retryable'); }
      if (performance.now() - lastRenewal >= 10_000) {
        if (!await store.renew(claim)) throw new LocalEmbeddingError('embedding.claim_lost', 'retryable');
        lastRenewal = performance.now();
      }
    };
    try {
      const source = await store.loadSource(claim);
      if (!source?.eligible) {
        const settled = source?.disposition === 'future' && source.deferUntil
          ? await store.defer(claim, 'embedding.valid_from_deferred', new Date(source.deferUntil.getTime() + 1))
          : await store.settle(claim, 'excluded', source ? `embedding.lifecycle_${source.disposition ?? 'excluded'}` : 'embedding.parent_deleted');
        if (!settled) { receipt.staleParents++; break; }
        else if (source?.disposition !== 'future') receipt.excludedParents++;
        continue;
      }
      const bytes = Buffer.byteLength(source.text, 'utf8');
      if (bytes > limits.maxSourceBytes - receipt.sourceBytes) {
        if (!await store.defer(claim, 'embedding.byte_budget')) receipt.staleParents++;
        if (bytes > limits.maxSourceBytes) await pause('embedding.parent_byte_budget');
        break;
      }
      receipt.sourceBytes += bytes;
      const plan = claim.parentType === 'memory' ? await planEmbeddingChunks(source.text, async text => {
        await checkpoint(); return client.countFormattedTokens(text, batchSignal);
      }) : null;
      const expectedTokens = plan ? plan.chunks.reduce((sum, chunk) => sum + chunk.tokens, 0)
        : await client.countFormattedTokens(formatLocalEmbeddingInput(source.text, 'query'), batchSignal);
      if (expectedTokens > limits.maxTokens - receipt.tokens) {
        if (!await store.defer(claim, 'embedding.token_budget')) receipt.staleParents++;
        if (expectedTokens > limits.maxTokens) await pause('embedding.parent_token_budget');
        break;
      }
      const vectors: number[][] = [];
      let subscriptionTokens = 0;
      const texts = plan ? plan.chunks.map(c => c.text) : [source.text];
      for (let i = 0; i < texts.length; i += 4) {
        await checkpoint();
        const result = await client.embed(texts.slice(i, i + 4), plan ? 'document' : 'query', batchSignal);
        if (plan && result.tokens.some((n, j) => n !== plan.chunks[i + j].tokens)) {
          throw new LocalEmbeddingError('embedding.unstable_tokenizer', 'systemic');
        }
        vectors.push(...result.vectors);
        const tokens = result.tokens.reduce((sum, n) => sum + n, 0);
        receipt.tokens += tokens; receipt.vectors += result.vectors.length; subscriptionTokens += tokens;
        if (receipt.tokens > limits.maxTokens) throw new LocalEmbeddingError('embedding.token_budget', 'systemic');
      }
      await checkpoint();
      const committed = plan ? await store.commitMemory(claim, source, plan, vectors)
        : await store.commitSubscription(claim, source, vectors[0], subscriptionTokens);
      if (committed) receipt.completeParents++;
      else {
        receipt.staleParents++;
        if (!await store.settle(claim, 'retry', 'embedding.source_changed')) break;
      }
    } catch (error) {
      const classified = error instanceof LocalEmbeddingError ? error
        : error instanceof Error && /^embedding\.(postgres_nul|invalid_unicode|input_type|parent_byte_limit|codepoint_over_token_limit)$/u.test(error.message)
          ? new LocalEmbeddingError(error.message, 'input') : new LocalEmbeddingError('embedding.worker_failure', 'systemic');
      if (classified.classification === 'input') {
        if (await store.settle(claim, 'failed', classified.code)) receipt.failedParents++;
        else { receipt.staleParents++; break; }
      } else if (classified.classification === 'retryable') {
        const controlStop = ['embedding.batch_stopped', 'embedding.cancelled', 'embedding.resource_guard'].includes(classified.code);
        const exhausted = !controlStop && claim.attempts + 1 >= limits.maxAttempts;
        const settled = controlStop
          ? await store.defer(claim, classified.code)
          : await store.settle(claim, exhausted ? 'failed' : 'retry', exhausted ? 'embedding.retry_exhausted' : classified.code,
            exhausted ? 0 : classified.retryAfterMs ?? Math.min(1000 * 2 ** claim.attempts, 60_000));
        if (!settled) receipt.staleParents++;
        else if (exhausted) receipt.failedParents++;
        else if (!controlStop) receipt.retriedParents++;
        if (controlStop) await pause(classified.code);
        // Outage/backpressure/cancellation stops this finite batch, avoiding a corpus-wide retry stampede.
        break;
      } else {
        if (await store.settle(claim, 'failed', classified.code)) receipt.failedParents++;
        else receipt.staleParents++;
        await pause(classified.code); break;
      }
    }
  }
  receipt.elapsedMs = Math.round(performance.now() - started);
  return receipt;
}
