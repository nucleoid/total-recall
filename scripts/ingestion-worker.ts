import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateKeyReadOnly } from '../src/auth.js';
import { dbScopeFromAuth, shutdown } from '../src/db.js';
import { claimIngestionJob, embedWithinBudget, failIngestionJob, finalizeIngestionJob, ingestionInteger,
  type IngestionJob } from '../src/ingestion.js';
import type { DbScope } from '../src/db.js';

export interface IngestionWorkerOptions { once: boolean; maxJobs: number; pollMs: number; concurrency: number }
export function parseIngestionWorkerCli(args: string[], env: NodeJS.ProcessEnv = process.env): IngestionWorkerOptions {
  const options = { once: false, maxJobs: Number.MAX_SAFE_INTEGER, pollMs: 1000,
    concurrency: ingestionInteger(env.MEMORY_INGESTION_CONCURRENCY, 4, 'MEMORY_INGESTION_CONCURRENCY', 1, 32) };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--once') options.once = true;
    else if (flag === '--concurrency') options.concurrency = ingestionInteger(args[++index] ?? '', 4, flag, 1, 32);
    else if (flag === '--max-jobs') options.maxJobs = ingestionInteger(args[++index] ?? '', 1, flag, 1, 100000);
    else if (flag === '--poll-ms') options.pollMs = ingestionInteger(args[++index] ?? '', 1000, flag, 100, 60000);
    else throw new Error(`Unknown ingestion worker option: ${flag}`);
  }
  return options;
}
export async function processIngestionJob(job: IngestionJob, signal?: AbortSignal): Promise<void> {
  try {
    const timeout = ingestionInteger(process.env.EMBEDDING_TIMEOUT_MS, 15000, 'EMBEDDING_TIMEOUT_MS', 100, 120000);
    const result = await embedWithinBudget(job.content, timeout, undefined, signal);
    await finalizeIngestionJob(job, result);
  } catch (error) { await failIngestionJob(job, error); }
}
export async function runIngestionWorker(options: IngestionWorkerOptions, signal: AbortSignal): Promise<{ processed: number }> {
  const rawKey = process.env.INGESTION_WORKER_API_KEY?.trim();
  if (!rawKey) throw new Error('INGESTION_WORKER_API_KEY is required');
  let processed = 0;
  // No queue gate: switching API acceptance off must still allow backlog drainage.
  while (!signal.aborted && processed < options.maxJobs) {
    const auth = await validateKeyReadOnly(rawKey);
    if (!auth || !auth.permissions.includes('admin')) throw new Error('Enabled admin ingestion worker API key required');
    const scope: DbScope = dbScopeFromAuth(auth);
    const capacity = Math.min(options.concurrency, options.maxJobs - processed);
    const jobs = (await Promise.all(Array.from({ length: capacity }, () => claimIngestionJob(scope))))
      .filter((job): job is IngestionJob => job !== null);
    if (!jobs.length) {
      if (options.once) break;
      await sleep(options.pollMs, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
      continue;
    }
    processed += jobs.length;
    await Promise.all(jobs.map(job => processIngestionJob(job, signal)));
  }
  return { processed };
}
async function main(): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { console.log('[ingestion-worker] stopped', await runIngestionWorker(parseIngestionWorkerCli(process.argv.slice(2)), controller.signal)); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); await shutdown(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('[ingestion-worker] failed; check database and worker configuration'); process.exitCode = 1; });
}
