import { isDirectExecution } from './entrypoint.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateKeyReadOnly } from './auth.js';
import { dbScopeFromAuth, shutdown } from './db.js';
import { claimIngestionJobs, failIngestionJob, finalizeIngestionJob, ingestionInteger, ingestionMaxAttempts, workerIngestionLeaseMs,
  embedClaimedIngestionJobWithinBudget, embedClaimedIngestionBatchWithinBudget, failIngestionBatch, finalizeIngestionBatch,
  type IngestionJob } from './ingestion.js';
import type { DbScope } from './db.js';

export interface IngestionWorkerOptions { once: boolean; maxJobs: number; pollMs: number; concurrency: number; batchSize?: number }
export function parseIngestionWorkerCli(args: string[], env: NodeJS.ProcessEnv = process.env): IngestionWorkerOptions {
  const options = { once: false, maxJobs: Number.MAX_SAFE_INTEGER, pollMs: 1000,
    concurrency: ingestionInteger(env.MEMORY_INGESTION_CONCURRENCY, 4, 'MEMORY_INGESTION_CONCURRENCY', 1, 32), batchSize: 16 };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--once') options.once = true;
    else if (flag === '--concurrency') options.concurrency = ingestionInteger(args[++index] ?? '', 4, flag, 1, 32);
    else if (flag === '--max-jobs') options.maxJobs = ingestionInteger(args[++index] ?? '', 1, flag, 1, 100000);
    else if (flag === '--poll-ms') options.pollMs = ingestionInteger(args[++index] ?? '', 1000, flag, 100, 60000);
    else if (flag === '--batch-size') options.batchSize = ingestionInteger(args[++index] ?? '', 16, flag, 1, 64);
    else throw new Error(`Unknown ingestion worker option: ${flag}`);
  }
  return options;
}
export async function processIngestionBatch(jobs: IngestionJob[], signal?: AbortSignal): Promise<void> {
  if (!jobs.length) return;
  if (jobs[0].kind !== 'document' || !jobs[0].document_id) { await processIngestionJob(jobs[0],signal); return; }
  try {
    const timeout = ingestionInteger(process.env.EMBEDDING_TIMEOUT_MS,15000,'EMBEDDING_TIMEOUT_MS',100,120000);
    const result = await embedClaimedIngestionBatchWithinBudget(jobs,timeout,signal);
    if (signal?.aborted) throw new DOMException('Ingestion worker stopping','AbortError');
    await finalizeIngestionBatch(jobs,result);
  } catch (error) { await failIngestionBatch(jobs,error); }
}
export async function processIngestionJob(job: IngestionJob, signal?: AbortSignal): Promise<void> {
  try {
    const timeout = ingestionInteger(process.env.EMBEDDING_TIMEOUT_MS, 15000, 'EMBEDDING_TIMEOUT_MS', 100, 120000);
    const result = await embedClaimedIngestionJobWithinBudget(job,timeout,signal);
    if (signal?.aborted) throw new DOMException('Ingestion worker stopping','AbortError');
    await finalizeIngestionJob(job, result);
  } catch (error) { await failIngestionJob(job, error); }
}
export async function runIngestionWorker(options: IngestionWorkerOptions, signal: AbortSignal): Promise<{ processed: number }> {
  ingestionMaxAttempts(); workerIngestionLeaseMs(); // Validate worker limits before claims.
  const batchSize=ingestionInteger(String(options.batchSize ?? 16),16,'batch-size',1,64);
  const rawKey = process.env.INGESTION_WORKER_API_KEY?.trim();
  if (!rawKey) throw new Error('INGESTION_WORKER_API_KEY is required');
  let processed = 0;
  let failures = 0;
  const pauseAfterFailure = async () => {
    failures = Math.min(failures + 1, 6);
    console.warn('[ingestion-worker] outcome=poll_deferred');
    await sleep(Math.min(60000, options.pollMs * 2 ** failures), undefined, { signal })
      .catch(error => { if (!signal.aborted) throw error; });
  };
  // No queue gate: switching API acceptance off must still allow backlog drainage.
  while (!signal.aborted && processed < options.maxJobs) {
    let auth;
    try { auth = await validateKeyReadOnly(rawKey); }
    catch (error) { if (options.once) throw error; await pauseAfterFailure(); continue; }
    if (!auth || !auth.permissions.includes('admin')) throw new Error('Enabled admin ingestion worker API key required');
    const scope: DbScope = dbScopeFromAuth(auth);
    const capacity = Math.min(options.concurrency, options.maxJobs - processed);
    // Debit actual chunks so scalar work retains concurrency and batches cannot
    // overrun --max-jobs. No provider work starts until these short claims end.
    let remaining=options.maxJobs-processed;
    const batches: IngestionJob[][]=[];
    let claimFailed=false;
    for (let index=0; index<capacity && remaining>0 && !signal.aborted; index++) {
      try {
        const jobs=await claimIngestionJobs(scope,{ limit:Math.min(batchSize,remaining) });
        if (jobs.length) { batches.push(jobs); remaining-=jobs.length; }
      } catch { claimFailed=true; }
    }
    processed += batches.reduce((count,jobs) => count+jobs.length,0);
    // Stop new polls on SIGTERM; claimed work drains within the bounded lease/stop budget.
    const completions = await Promise.allSettled(batches.map(jobs => processIngestionBatch(jobs)));
    if (claimFailed || completions.some(completion => completion.status === 'rejected')) {
      if (options.once) throw new Error('Ingestion poll incomplete; leases recover automatically');
      await pauseAfterFailure(); continue;
    }
    failures = 0;
    if (!batches.length) {
      if (options.once) break;
      await sleep(options.pollMs, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
    }
  }
  return { processed };
}
export async function ingestionWorkerMain(): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { console.log('[ingestion-worker] stopped', await runIngestionWorker(parseIngestionWorkerCli(process.argv.slice(2)), controller.signal)); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); await shutdown(); }
}
if (isDirectExecution(import.meta.url, process.argv[1])) {
  ingestionWorkerMain().catch(() => { console.error('[ingestion-worker] failed; check database and worker configuration'); process.exitCode = 1; });
}
