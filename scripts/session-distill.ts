import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { validateKeyReadOnly } from '../src/auth.js';
import { dbScopeFromAuth, shutdown, withScopedClient } from '../src/db.js';
import { HttpJsonGenerationProvider, type GenerationProvider } from '../src/generation.js';
import {
  applySessionDistillation,
  assertSessionPolicyEffective,
  claimSessionDistillationJob,
  distillSessionTranscript,
  embedDistilledFacts,
  loadSessionTranscript,
  markSessionDistillationFailed,
  parseSessionDistillationPolicy,
  reserveSessionDistillationBudget,
  sessionDistillationInputBytes,
  type SessionDistillationJob,
  type SessionDistillationPolicy,
} from '../src/session-distillation.js';
import type { AuthContext } from '../src/types.js';

dotenv.config();

export interface SessionWorkerOptions { once: boolean; maxJobs: number; pollMs: number }

export function parseSessionWorkerCli(args: string[]): SessionWorkerOptions {
  let once = false;
  let maxJobs = 100;
  let pollMs = 1_000;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--once') once = true;
    else if (arg === '--max-jobs') maxJobs = integer(args[++index], arg, 1, 100_000);
    else if (arg === '--poll-ms') pollMs = integer(args[++index], arg, 100, 60_000);
    else throw new Error(`Unknown session distillation option: ${arg}`);
  }
  return { once, maxJobs, pollMs };
}

async function loadPolicy(): Promise<SessionDistillationPolicy> {
  const file = process.env.SESSION_DISTILLATION_POLICY_FILE?.trim();
  const environment = process.env.DEPLOYMENT_ENVIRONMENT?.trim();
  if (!file || !environment) {
    throw new Error('Session distillation is disabled without SESSION_DISTILLATION_POLICY_FILE and DEPLOYMENT_ENVIRONMENT');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Unable to load session distillation policy: ${error instanceof Error ? error.message : String(error)}`); }
  return parseSessionDistillationPolicy(parsed, environment);
}

export function assertSessionWorkerAuthority(auth: AuthContext, policy: SessionDistillationPolicy): void {
  const namespace = policy.scope.namespaces[0];
  if (auth.namespaces.length !== 1 || auth.namespaces[0] !== namespace || auth.maxAccessLevel !== 'normal') {
    throw new Error('Session worker requires a dedicated normal-only key for the exact approved namespace');
  }
  for (const permission of ['admin', 'read', 'write']) {
    if (!auth.permissions.includes(permission)) throw new Error(`Session worker key requires '${permission}' permission`);
  }
}

export async function runSessionWorker(
  options: SessionWorkerOptions,
  signal: AbortSignal,
  supplied?: { policy?: SessionDistillationPolicy; provider?: GenerationProvider; auth?: AuthContext },
): Promise<{ processed: number; providerCalls: number; factsStored: number }> {
  const policy = supplied?.policy ?? await loadPolicy();
  const rawKey = process.env.SESSION_DISTILLATION_API_KEY?.trim();
  const auth = supplied?.auth ?? (rawKey ? await validateKeyReadOnly(rawKey) : null);
  if (!auth) throw new Error('SESSION_DISTILLATION_API_KEY is required and must be valid');
  assertSessionWorkerAuthority(auth, policy);
  const credential = process.env[policy.generation.credentialEnv]?.trim();
  if (!supplied?.provider && !credential) {
    throw new Error(`Session generation credential ${policy.generation.credentialEnv} is missing or blank`);
  }
  const provider = supplied?.provider ?? new HttpJsonGenerationProvider({
    name: policy.generation.provider,
    endpoint: policy.generation.endpoint,
    apiKey: credential,
  });
  if (provider.name !== policy.generation.provider) {
    throw new Error('Generation provider does not match the approved session policy');
  }

  const scope = dbScopeFromAuth(auth);
  const namespace = policy.scope.namespaces[0];
  let processed = 0;
  let providerCalls = 0;
  let factsStored = 0;

  while (!signal.aborted && processed < options.maxJobs) {
    assertSessionPolicyEffective(policy);
    const job = await withScopedClient(scope, client => claimSessionDistillationJob(client, namespace));
    if (!job) {
      if (options.once) break;
      await sleep(options.pollMs, signal);
      continue;
    }
    processed += 1;
    assertSessionPolicyEffective(policy);
    const loaded = await withScopedClient(scope, client => loadSessionTranscript(client, job));
    if (!loaded) {
      await fail(scope, job, 'source_unavailable', true);
      metric('source_unavailable');
      continue;
    }
    const inputBytes = sessionDistillationInputBytes(loaded.transcript);
    const reserved = await withScopedClient(scope, client =>
      reserveSessionDistillationBudget(client, job, policy, inputBytes));
    if (!reserved) {
      metric('budget_blocked');
      continue;
    }

    try {
      providerCalls += 1;
      const generated = await distillSessionTranscript(
        loaded.transcript,
        provider,
        policy.generation.model,
        policy.budget.maxInputBytesPerSession,
        policy.budget.maxOutputBytesPerSession,
        signal,
      );
      const vectors = await embedDistilledFacts(generated.facts, signal);
      const applied = await withScopedClient(scope, client => applySessionDistillation(
        client, job, loaded, generated.facts, vectors, generated.outputBytes, policy,
      ));
      if (!applied) {
        await fail(scope, job, 'source_changed', true);
        metric('source_changed');
        continue;
      }
      factsStored += generated.facts.length;
      metric('completed', generated.facts.length);
    } catch (error) {
      const code = classifyError(error);
      await fail(scope, job, code, code === 'input_too_large');
      metric(code);
      if (signal.aborted) break;
    }
  }
  return { processed, providerCalls, factsStored };
}

async function fail(
  scope: ReturnType<typeof dbScopeFromAuth>,
  job: SessionDistillationJob,
  code: string,
  terminal = false,
): Promise<void> {
  await withScopedClient(scope, client => markSessionDistillationFailed(client, job, code, terminal));
}

export function classifySessionDistillationError(error: unknown): string {
  return classifyError(error);
}

function classifyError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted';
  const message = error instanceof Error ? error.message : '';
  if (message.includes('timed out')) return 'provider_timeout';
  if (message.includes('input exceeds') || message.includes('input_too_large')) return 'input_too_large';
  if (message.includes('output exceeds')) return 'output_too_large';
  if (message.startsWith('invalid_session_')) return 'invalid_output';
  if (message.toLowerCase().includes('embedding')) return 'embedding_error';
  return 'provider_error';
}

function metric(outcome: string, count?: number): void {
  // Never include transcript text, generated facts, model output, owner, or namespace.
  console.warn(`[session-distill] outcome=${outcome}${count === undefined ? '' : ` facts=${count}`}`);
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
  const options = parseSessionWorkerCli(process.argv.slice(2));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const result = await runSessionWorker(options, controller.signal);
    console.log('[session-distill] stopped', result);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[session-distill] failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
