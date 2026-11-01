import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { validateKeyReadOnly } from '../src/auth.js';
import {
  dbScopeFromAuth,
  shutdown,
  withCheckedOutClient,
  withScopedTransactionOnClient,
  type DbScope,
  type ScopedClient,
} from '../src/db.js';
import { ACTIVE_EMBEDDING_PROFILE, embedWithProfile, type EmbeddingResult } from '../src/embedding.js';
import {
  INGESTION_LEASE_MS,
  cancelIngestionJob,
  claimIngestionJob,
  failIngestionJob,
  finalizeIngestionJob,
  ingestionJobScope,
  ingestionMaxAttemptsFromEnv,
  ingestionPaused,
  loadIngestionJobContent,
  recordIngestionWorkerHeartbeat,
  scheduleIngestionShadow,
  type FinalizeIngestionOptions,
  type FinalizeIngestionResult,
  type IngestionJob,
  type IngestionJobSource,
} from '../src/ingestion.js';
import type { AuthContext } from '../src/types.js';

dotenv.config();

/**
 * Durable ingestion worker for memory_store (#157). Drains
 * memory_ingestion_jobs: claims one job per transaction under the dedicated
 * admin key, embeds the accepted content outside any transaction with the
 * active profile (bounded by EMBEDDING_TIMEOUT_MS), and finalizes or records
 * the failure under the job's own owner scope so the worker never holds a
 * scope wider than one job's namespace while touching memory rows. Nothing
 * here logs memory content: every log line is a fixed outcome code.
 */

export interface IngestionWorkerOptions { once: boolean; maxJobs: number; pollMs: number; concurrency: number }

export function parseIngestionWorkerCli(args: string[], env: NodeJS.ProcessEnv = process.env): IngestionWorkerOptions {
  let once = false;
  let maxJobs = Number.MAX_SAFE_INTEGER;
  let pollMs = 1_000;
  let concurrency = integer(env.INGESTION_WORKER_CONCURRENCY ?? '4', 'INGESTION_WORKER_CONCURRENCY', 1, 32);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--once') once = true;
    else if (arg === '--max-jobs') maxJobs = integer(args[++index], arg, 1, 100_000);
    else if (arg === '--poll-ms') pollMs = integer(args[++index], arg, 100, 60_000);
    else if (arg === '--concurrency') concurrency = integer(args[++index], arg, 1, 32);
    else throw new Error(`Unknown ingestion worker option: ${arg}`);
  }
  return { once, maxJobs, pollMs, concurrency };
}

/** Per-job outcomes counted for the exit summary. */
export const INGESTION_WORKER_OUTCOMES = ['ready', 'deduplicated', 'retry', 'failed', 'cancelled', 'stale', 'error'] as const;
export type IngestionWorkerOutcome = typeof INGESTION_WORKER_OUTCOMES[number];

export interface IngestionWorkerResult extends Record<IngestionWorkerOutcome, number> {
  /** Jobs claimed by this run. */
  processed: number;
}

export interface IngestionWorkerDeps {
  /** Drain: stop claiming; jobs already in flight finish and are finalized. */
  signal?: AbortSignal;
  /** Abort in-flight provider calls too; those jobs are recorded as retryable. */
  abortSignal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Resolves the worker key; production uses validateKeyReadOnly. */
  authenticate?: (rawKey: string) => Promise<AuthContext | null>;
  /** Claims one job on the admin-scoped transaction; production uses claimIngestionJob. */
  claim?: (client: ScopedClient) => Promise<IngestionJob | null>;
  /** Embeds accepted content; production uses embedWithProfile with the active profile. */
  embed?: (content: string, signal: AbortSignal) => Promise<EmbeddingResult>;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  finalize?: FinalizeIngestionOptions;
  scheduleShadow?: (task: () => Promise<void>) => void;
  /** Defaults to MEMORY_INGESTION_MAX_ATTEMPTS. */
  maxAttempts?: number;
  /** Defaults to INGESTION_LEASE_MS. */
  leaseMs?: number;
}

/** The claim scope: the dedicated worker key must be enabled and hold admin. */
export function ingestionWorkerScope(auth: AuthContext): DbScope {
  if (!auth.permissions.includes('admin')) {
    throw new Error("Ingestion worker requires a dedicated enabled API key with the 'admin' permission");
  }
  return dbScopeFromAuth(auth);
}

export async function runIngestionWorker(
  options: IngestionWorkerOptions,
  deps: IngestionWorkerDeps = {},
): Promise<IngestionWorkerResult> {
  const env = deps.env ?? process.env;
  const signal = deps.signal ?? new AbortController().signal;
  const rawKey = env.INGESTION_WORKER_API_KEY?.trim();
  if (!rawKey) throw new Error('INGESTION_WORKER_API_KEY is required');
  const auth = await (deps.authenticate ?? validateKeyReadOnly)(rawKey);
  if (!auth) throw new Error('Invalid or disabled ingestion worker API key');
  const scope = ingestionWorkerScope(auth);
  const context: JobContext = {
    embed: deps.embed ?? defaultEmbed,
    abortSignal: deps.abortSignal ?? new AbortController().signal,
    finalize: deps.finalize,
    scheduleShadow: deps.scheduleShadow,
    maxAttempts: deps.maxAttempts ?? ingestionMaxAttemptsFromEnv(env),
  };
  const leaseMs = deps.leaseMs ?? INGESTION_LEASE_MS;
  const claim = deps.claim ?? ((client: ScopedClient) => claimIngestionJob(client, { leaseMs }));
  const sleep = deps.sleep ?? pause;

  const result: IngestionWorkerResult = { processed: 0, ready: 0, deduplicated: 0, retry: 0, failed: 0, cancelled: 0, stale: 0, error: 0 };
  const inFlight = new Set<Promise<void>>();
  const track = (job: IngestionJob): void => {
    const task: Promise<void> = processJob(job, context)
      .then(outcome => { result[outcome] += 1; }, () => { result.error += 1; metric('job_error'); })
      .finally(() => { inFlight.delete(task); });
    inFlight.add(task);
  };

  try {
    while (!signal.aborted && result.processed < options.maxJobs) {
      if (inFlight.size >= options.concurrency) {
        await Promise.race(inFlight);
        continue;
      }
      // Each poll heartbeats and honors the operator pause switch before claiming.
      const paused = await transaction(scope, async client => {
        await recordIngestionWorkerHeartbeat(client);
        return ingestionPaused(client);
      });
      if (signal.aborted) break;
      if (paused) {
        metric('paused');
        if (options.once) {
          if (inFlight.size === 0) break;
          await Promise.race(inFlight);
          continue;
        }
        await sleep(options.pollMs, signal);
        continue;
      }

      let claimed = 0;
      while (!signal.aborted && inFlight.size < options.concurrency && result.processed < options.maxJobs) {
        const job = await transaction(scope, claim);
        if (!job) break;
        claimed += 1;
        result.processed += 1;
        track(job);
      }
      if (claimed > 0 || signal.aborted) continue;
      if (inFlight.size > 0) {
        // Nothing claimable right now; wait for a job to finish before polling again.
        await Promise.race(inFlight);
        continue;
      }
      if (options.once) break;
      await sleep(options.pollMs, signal);
    }
  } finally {
    // Drain: whatever was claimed is finalized or recorded before returning.
    await Promise.allSettled(inFlight);
  }
  return result;
}

interface JobContext {
  embed: (content: string, signal: AbortSignal) => Promise<EmbeddingResult>;
  abortSignal: AbortSignal;
  finalize: FinalizeIngestionOptions | undefined;
  scheduleShadow: ((task: () => Promise<void>) => void) | undefined;
  maxAttempts: number;
}

async function processJob(job: IngestionJob, context: JobContext): Promise<IngestionWorkerOutcome> {
  const owner = ingestionJobScope(job);

  let source: IngestionJobSource;
  try {
    source = await transaction(owner, client => loadIngestionJobContent(client, job));
  } catch {
    metric('load_error');
    return 'error';
  }
  if (!source.available) {
    if (source.reason === 'stale_lease') {
      metric('stale');
      return 'stale';
    }
    // Expired TTL, forgotten, or unreachable content is never embedded.
    const reason = source.reason;
    try {
      const applied = await transaction(owner, client => cancelIngestionJob(client, job, reason));
      metric(applied ? `cancelled_${reason}` : 'stale');
      return applied ? 'cancelled' : 'stale';
    } catch {
      metric('cancel_error');
      return 'error';
    }
  }

  // Provider work never holds a database connection or transaction.
  let embedding: EmbeddingResult;
  try {
    embedding = await context.embed(source.content, context.abortSignal);
  } catch (error) {
    return recordFailure(job, error, context, undefined);
  }

  let outcome: FinalizeIngestionResult;
  try {
    outcome = await transaction(owner, client => finalizeIngestionJob(client, job, embedding, context.finalize));
  } catch (error) {
    metric('finalize_error');
    return recordFailure(job, error, context, 'finalize_error');
  }
  switch (outcome.outcome) {
    case 'ready':
      scheduleIngestionShadow(outcome, {
        scheduleShadow: context.scheduleShadow,
        contradictionMetric: context.finalize?.contradictionMetric,
      });
      metric(outcome.revised ? 'revised' : 'ready');
      return 'ready';
    case 'deduplicated':
      metric('deduplicated');
      return 'deduplicated';
    case 'cancelled':
      metric(`cancelled_${outcome.reason}`);
      return 'cancelled';
    case 'space_mismatch':
      metric('failed_space_mismatch');
      return 'failed';
    case 'stale':
      metric('stale');
      return 'stale';
  }
}

/** Record a failed attempt with the bounded backoff; a lost lease is a no-op. */
async function recordFailure(
  job: IngestionJob,
  error: unknown,
  context: JobContext,
  errorCode: string | undefined,
): Promise<IngestionWorkerOutcome> {
  try {
    const failure = await transaction(ingestionJobScope(job), client =>
      failIngestionJob(client, job, error, { maxAttempts: context.maxAttempts, errorCode }));
    if (!failure.applied) {
      metric('stale');
      return 'stale';
    }
    const outcome = failure.status === 'retry_wait' ? 'retry' : 'failed';
    metric(`${outcome}_${failure.classification.category}`);
    return outcome;
  } catch {
    // The lease expires on its own and the job is reclaimed with a counted attempt.
    metric('fail_error');
    return 'error';
  }
}

/** One RLS-scoped transaction on a checked-out pool session, released afterwards. */
function transaction<T>(scope: DbScope, fn: (client: ScopedClient) => Promise<T>): Promise<T> {
  return withCheckedOutClient(client => withScopedTransactionOnClient(client, scope, fn));
}

function defaultEmbed(content: string, signal: AbortSignal): Promise<EmbeddingResult> {
  return embedWithProfile(content, ACTIVE_EMBEDDING_PROFILE, signal);
}

function metric(outcome: string): void {
  // Fixed outcome codes only: never ids, namespaces, content, or error text.
  console.warn(`[ingestion-worker] outcome=${outcome}`);
}

function integer(raw: string | undefined, name: string, min: number, max: number): number {
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); done(); };
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function main(): Promise<void> {
  const options = parseIngestionWorkerCli(process.argv.slice(2));
  const stop = new AbortController();
  const abort = new AbortController();
  // First SIGINT/SIGTERM drains: no new claims, in-flight jobs finish. A
  // second one aborts in-flight provider calls; those jobs retry later.
  const onSignal = () => {
    if (!stop.signal.aborted) {
      stop.abort();
      console.warn('[ingestion-worker] draining in-flight jobs; signal again to abort them');
    } else {
      abort.abort();
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    console.log('[ingestion-worker] stopped', await runIngestionWorker(options, { signal: stop.signal, abortSignal: abort.signal }));
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[ingestion-worker] failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
