import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { validateKeyReadOnly } from '../src/auth.js';
import { shutdown } from '../src/db.js';
import {
  lastCompletedIsoWeek,
  parseReflectionPolicy,
  runReflection,
  type ReflectionPolicy,
  type ReflectionWindow,
} from '../src/reflection.js';

dotenv.config();

export interface ReflectionCliOptions {
  namespace: string;
  dryRun: boolean;
  force: boolean;
  window?: ReflectionWindow;
}

export function parseReflectionCli(args: string[]): ReflectionCliOptions {
  let namespace = '';
  let dryRun = false;
  let force = false;
  let start: Date | undefined;
  let end: Date | undefined;
  const value = (index: number, option: string): string => {
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${option} requires a value`);
    return next;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--namespace') namespace = value(index++, arg);
    else if (arg === '--dry-run') {
      if (dryRun) throw new Error('--dry-run may be specified only once');
      dryRun = true;
    } else if (arg === '--force') {
      if (force) throw new Error('--force may be specified only once');
      force = true;
    } else if (arg === '--window-start') start = parseTimestamp(value(index++, arg), arg);
    else if (arg === '--window-end') end = parseTimestamp(value(index++, arg), arg);
    else throw new Error(`Unknown reflection option: ${arg}`);
  }
  if (!namespace.trim() || namespace === 'insights' || namespace.includes(',')) {
    throw new Error('--namespace must name exactly one non-insights source namespace');
  }
  if ((start === undefined) !== (end === undefined)) {
    throw new Error('--window-start and --window-end must be supplied together');
  }
  if (start && end && start.getTime() >= end.getTime()) throw new Error('Reflection window must be nonempty');
  if (dryRun && force) throw new Error('--dry-run and --force are mutually exclusive');
  return { namespace, dryRun, force, window: start && end ? { start, end } : undefined };
}

function parseTimestamp(raw: string, option: string): Date {
  // Requiring an explicit offset avoids host-time-zone dependent windows.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new Error(`${option} must be an ISO-8601 timestamp with an explicit offset`);
  }
  const value = new Date(raw);
  if (!Number.isFinite(value.getTime())) throw new Error(`Invalid ${option}`);
  return value;
}

async function loadPolicy(): Promise<ReflectionPolicy> {
  const file = process.env.REFLECTION_POLICY_FILE?.trim();
  const environment = process.env.DEPLOYMENT_ENVIRONMENT?.trim();
  if (!file || !environment) {
    throw new Error('Reflection is disabled without REFLECTION_POLICY_FILE and DEPLOYMENT_ENVIRONMENT');
  }
  let value: unknown;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Unable to load reflection policy: ${error instanceof Error ? error.message : String(error)}`); }
  return parseReflectionPolicy(value, environment);
}

async function main(): Promise<void> {
  const cli = parseReflectionCli(process.argv.slice(2));
  const policy = await loadPolicy();
  if (policy.scope.namespaces[0] !== cli.namespace) {
    throw new Error('Reflection policy does not approve the exact requested namespace');
  }
  const rawKey = process.env.REFLECTION_API_KEY?.trim();
  if (!rawKey) throw new Error('REFLECTION_API_KEY is required');
  const auth = await validateKeyReadOnly(rawKey);
  if (!auth) throw new Error('Invalid or disabled reflection API key');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const result = await runReflection({
      auth, namespace: cli.namespace, window: cli.window ?? lastCompletedIsoWeek(),
      environment: process.env.DEPLOYMENT_ENVIRONMENT!.trim(), policy,
      dryRun: cli.dryRun, force: cli.force, signal: controller.signal,
    });
    // Content-free by design: never print candidate IDs, source text, prompts, or insight text.
    console.log(`[reflection] ${cli.dryRun ? 'dry-run' : result.reused ? 'already-completed' : 'completed'}`, {
      selected: result.selected,
      materialized: result.materialized,
      inputBytes: result.inputBytes,
      truncated: result.truncated,
      estimatedCostMicroUsd: result.estimatedCostMicroUsd,
      providerCalls: result.providerCalls,
      insightsStored: result.insightsStored,
      generation: result.generation,
    });
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[reflection] Failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
