import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { validateKeyReadOnly } from '../src/auth.js';
import { shutdown, withCheckedOutClient } from '../src/db.js';
import {
  lastCompletedMediaMonth,
  mediaMonthPeriod,
  parseTasteProfilePolicy,
  runTasteProfile,
  type TasteProfileMode,
  type TasteProfilePolicy,
} from '../src/taste-profile.js';
import type { MediaTasteCategory } from '../src/media.js';

dotenv.config();

const TASTE_PROFILE_CLI_LOCK = 0x54525450; // "TRTP"

export interface TasteProfileCliOptions {
  mode: TasteProfileMode;
  category: MediaTasteCategory | 'all';
  period?: string;
  force: boolean;
  json: boolean;
}

export function parseTasteProfileCli(args: string[]): TasteProfileCliOptions {
  let explicitMode: TasteProfileMode | undefined;
  let category: TasteProfileCliOptions['category'] = 'all';
  let period: string | undefined;
  let force = false;
  let json = false;
  const value = (index: number, option: string): string => {
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${option} requires a value`);
    return next;
  };
  const setMode = (next: TasteProfileMode) => {
    if (explicitMode) throw new Error('Taste-profile modes are mutually exclusive');
    explicitMode = next;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') setMode('dry-run');
    else if (arg === '--preview') setMode('preview');
    else if (arg === '--apply') setMode('apply');
    else if (arg === '--category') {
      const parsed = value(index++, arg);
      if (!['music', 'viewing', 'all'].includes(parsed)) throw new Error('--category must be music, viewing, or all');
      category = parsed as TasteProfileCliOptions['category'];
    } else if (arg === '--period') {
      period = value(index++, arg);
      if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(period)) throw new Error('--period must use YYYY-MM');
    } else if (arg === '--force') {
      if (force) throw new Error('--force may be specified only once');
      force = true;
    } else if (arg === '--json') {
      if (json) throw new Error('--json may be specified only once');
      json = true;
    } else throw new Error(`Unknown taste-profile option: ${arg}`);
  }
  const mode = explicitMode ?? 'dry-run';
  if (mode === 'dry-run' && force) throw new Error('--force cannot be combined with --dry-run');
  return { mode, category, period, force, json };
}

async function loadPolicy(): Promise<TasteProfilePolicy> {
  const file = process.env.TASTE_PROFILE_POLICY_FILE?.trim();
  const environment = process.env.DEPLOYMENT_ENVIRONMENT?.trim();
  if (!file || !environment) {
    throw new Error('Taste profiles are disabled without TASTE_PROFILE_POLICY_FILE and DEPLOYMENT_ENVIRONMENT');
  }
  let value: unknown;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Unable to load taste-profile policy: ${error instanceof Error ? error.message : String(error)}`); }
  return parseTasteProfilePolicy(value, environment);
}

async function main(): Promise<void> {
  const cli = parseTasteProfileCli(process.argv.slice(2));
  const policy = await loadPolicy();
  const rawKey = process.env.TASTE_PROFILE_API_KEY?.trim();
  if (!rawKey) throw new Error('TASTE_PROFILE_API_KEY is required');
  const auth = await validateKeyReadOnly(rawKey);
  if (!auth) throw new Error('Invalid or disabled taste-profile API key');
  const timeZone = process.env.MEDIA_TIME_ZONE?.trim() || 'UTC';
  const period = cli.period ? mediaMonthPeriod(cli.period, timeZone) : lastCompletedMediaMonth(new Date(), timeZone);
  const categories: MediaTasteCategory[] = cli.category === 'all' ? ['music', 'viewing'] : [cli.category];
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const results = await withCheckedOutClient(async client => {
      const lockIdentity = `${auth.keyId}\0${policy.environment}`;
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked', [TASTE_PROFILE_CLI_LOCK, lockIdentity],
      );
      if (lock.rows[0]?.locked !== true) throw new Error('Another taste-profile job is active for this owner');
      try {
        const values = [];
        for (const category of categories) {
          values.push(await runTasteProfile({
            auth, category, period, timeZone,
            environment: process.env.DEPLOYMENT_ENVIRONMENT!.trim(), policy,
            mode: cli.mode, force: cli.force, signal: controller.signal,
          }));
        }
        return values;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1, hashtext($2))',
          [TASTE_PROFILE_CLI_LOCK, lockIdentity]).catch(() => undefined);
      }
    });
    if (cli.json) console.log(JSON.stringify({ version: 1, feature: 'media-taste-profile', results }, null, 2));
    else {
      // Content-free by default. Explicit --json is the human-review boundary.
      for (const result of results) console.log('[taste-profile]', {
        category: result.category, period: result.period, mode: result.mode, status: result.status,
        totalEvents: result.totalEvents, providerCalls: result.providerCalls,
        estimatedCostMicroUsd: result.estimatedCostMicroUsd, qualityWarnings: result.qualityWarnings,
      });
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[taste-profile] Failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
