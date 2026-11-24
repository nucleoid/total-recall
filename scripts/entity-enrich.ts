import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { validateKeyReadOnly } from '../src/auth.js';
import { dbScopeFromAuth, shutdown, withScopedClient } from '../src/db.js';
import {
  MAX_ENTITY_EXTRACTION_OUTPUT_BYTES,
  entityExtractionInputBytes,
  extractEntities,
  parseEntityExtractionPolicy,
  type EntityExtractionPolicy,
} from '../src/entity-extractor.js';
import {
  claimEntityEnrichmentJob,
  loadEntityJobContent,
  markEntityJobFailed,
  removeEntityLinksForIneligibleJob,
  replaceMemoryEntityLinks,
  type EntityEnrichmentJob,
} from '../src/entities.js';
import { HttpJsonGenerationProvider, type GenerationProvider } from '../src/generation.js';
import type { AuthContext } from '../src/types.js';
import { assertSynthesisAuthority, isSubscriptionUsage } from '../src/synthesis-policy.js';

dotenv.config();

interface WorkerOptions { once: boolean; maxJobs: number; pollMs: number; memoryIds?: string[] }

export function parseEntityWorkerCli(args: string[]): WorkerOptions {
  let once = false;
  let maxJobs = 100;
  let pollMs = 1_000;
  const memoryIds: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--once') once = true;
    else if (arg === '--memory-id') {
      const value = args[++index];
      if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        throw new Error('--memory-id must be a UUID');
      }
      if (memoryIds.includes(value)) throw new Error('--memory-id values must be unique');
      if (memoryIds.length >= 100) throw new Error('--memory-id is limited to 100 values');
      memoryIds.push(value);
    } else if (arg === '--max-jobs') maxJobs = integer(args[++index], arg, 1, 100_000);
    else if (arg === '--poll-ms') pollMs = integer(args[++index], arg, 100, 60_000);
    else throw new Error(`Unknown entity enrichment option: ${arg}`);
  }
  return { once, maxJobs, pollMs, memoryIds };
}

async function loadPolicy(): Promise<EntityExtractionPolicy> {
  const file = process.env.ENTITY_EXTRACTION_POLICY_FILE?.trim();
  const environment = process.env.DEPLOYMENT_ENVIRONMENT?.trim();
  if (!file || !environment) {
    throw new Error('Entity extraction is disabled without ENTITY_EXTRACTION_POLICY_FILE and DEPLOYMENT_ENVIRONMENT');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Unable to load entity extraction policy: ${error instanceof Error ? error.message : String(error)}`); }
  return parseEntityExtractionPolicy(parsed, environment);
}

export function assertEntityWorkerAuthority(auth: AuthContext, policy: EntityExtractionPolicy): void {
  const namespace = policy.scope.namespaces[0];
  assertSynthesisAuthority(auth, [namespace], policy.scope.accessLevel);
  const permissions = new Set(auth.permissions);
  if (!permissions.has('read') || !permissions.has('entity_extract') || permissions.has('write') ||
      permissions.has('admin') || permissions.has('delete')) {
    throw new Error("Entity worker requires 'read,entity_extract' without write, admin, or delete");
  }
}

class InvocationBudget {
  calls = 0;
  inputBytes = 0;
  outputBytesReserved = 0;
  costMicroUsd = 0;
  constructor(private readonly policy: EntityExtractionPolicy) {}

  reserve(inputBytes: number): boolean {
    const budget = this.policy.budget;
    const cost = Math.ceil(budget.estimatedRequestCostUsd * 1_000_000) +
      Math.ceil(inputBytes * budget.estimatedInputCostUsdPerMillionBytes) +
      Math.ceil(MAX_ENTITY_EXTRACTION_OUTPUT_BYTES * budget.estimatedOutputCostUsdPerMillionBytes);
    if (this.calls + 1 > budget.maxCallsPerInvocation ||
        this.inputBytes + inputBytes > budget.maxInputBytesPerInvocation ||
        this.outputBytesReserved + MAX_ENTITY_EXTRACTION_OUTPUT_BYTES > budget.maxOutputBytesPerInvocation ||
        (!isSubscriptionUsage(budget) &&
          this.costMicroUsd + cost > Math.floor(budget.maxCostUsdPerInvocation * 1_000_000))) return false;
    this.calls += 1;
    this.inputBytes += inputBytes;
    this.outputBytesReserved += MAX_ENTITY_EXTRACTION_OUTPUT_BYTES;
    this.costMicroUsd += cost;
    return true;
  }
}

export async function runEntityWorker(
  options: WorkerOptions,
  signal: AbortSignal,
  supplied?: { policy?: EntityExtractionPolicy; provider?: GenerationProvider; auth?: AuthContext },
): Promise<{ processed: number; providerCalls: number }> {
  const loadedPolicy = supplied?.policy ?? await loadPolicy();
  const policy = parseEntityExtractionPolicy(loadedPolicy, loadedPolicy.environment);
  const rawKey = process.env.ENTITY_ENRICH_API_KEY?.trim();
  const auth = supplied?.auth ?? (rawKey ? await validateKeyReadOnly(rawKey) : null);
  if (!auth) throw new Error('Invalid or disabled entity worker API key');
  assertEntityWorkerAuthority(auth, policy);
  const credential = process.env[policy.generation.credentialEnv]?.trim();
  if (!supplied?.provider && !credential) throw new Error(`Entity generation credential ${policy.generation.credentialEnv} is missing or blank`);
  const provider = supplied?.provider ?? new HttpJsonGenerationProvider({
    name: policy.generation.provider, endpoint: policy.generation.endpoint, apiKey: credential!,
  });
  if (provider.name !== policy.generation.provider) throw new Error('Entity generation provider does not match policy');
  const scope = dbScopeFromAuth(auth);
  const namespace = policy.scope.namespaces[0];
  const budget = new InvocationBudget(policy);
  let processed = 0;

  while (!signal.aborted && processed < options.maxJobs) {
    const job = await withScopedClient(scope, client => claimEntityEnrichmentJob(client, [namespace], policy.scope.accessLevel, 5, options.memoryIds ?? []));
    if (!job) {
      if (options.once) break;
      await sleep(options.pollMs, signal);
      continue;
    }
    processed += 1;
    if (job.namespace !== namespace || job.sourceAccessLevel !== policy.scope.accessLevel) {
      await withScopedClient(scope, client => removeEntityLinksForIneligibleJob(client, job));
      emitMetric('ineligible');
      continue;
    }

    const content = await withScopedClient(scope, client => loadEntityJobContent(client, job));
    if (content === null) {
      const completed = await withScopedClient(scope, client => replaceMemoryEntityLinks(client, job, []));
      emitMetric(completed ? 'ineligible' : 'stale');
      continue;
    }
    // Reserve the exact serialized prompt bytes before a provider is called.
    const inputBytes = entityExtractionInputBytes(content);
    if (!budget.reserve(inputBytes)) {
      await failJob(scope, job, 'budget_exhausted');
      emitMetric('budget_exhausted');
      break;
    }

    try {
      const entities = await extractEntities(content, provider, policy.generation.model, 30_000, signal);
      const applied = await withScopedClient(scope, client => replaceMemoryEntityLinks(client, job, entities));
      emitMetric(applied ? 'indexed' : 'stale');
    } catch (error) {
      const code = classifyError(error);
      await failJob(scope, job, code);
      emitMetric(code);
      if (signal.aborted) break;
    }
  }
  return { processed, providerCalls: budget.calls };
}

async function failJob(scope: ReturnType<typeof dbScopeFromAuth>, job: EntityEnrichmentJob, code: string): Promise<void> {
  await withScopedClient(scope, client => markEntityJobFailed(client, job, code));
}

function classifyError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted';
  const message = error instanceof Error ? error.message : '';
  if (message.includes('timed out')) return 'provider_timeout';
  if (message.includes('input_too_large') || message.includes('input exceeds')) return 'input_too_large';
  if (message.includes('output exceeds')) return 'output_too_large';
  if (message.startsWith('invalid_') || message === 'duplicate_extracted_entity') return 'invalid_output';
  return 'provider_error';
}

function emitMetric(outcome: string): void {
  // Never include source text, extracted names, provider output, or namespace.
  console.warn(`[entity-enrich] outcome=${outcome}`);
}

function integer(raw: string | undefined, option: string, min: number, max: number): number {
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`${option} must be an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${option} must be an integer from ${min} to ${max}`);
  return value;
}

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); done(); };
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function main(): Promise<void> {
  const options = parseEntityWorkerCli(process.argv.slice(2));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const result = await runEntityWorker(options, controller.signal);
    console.log('[entity-enrich] stopped', result);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[entity-enrich] failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
