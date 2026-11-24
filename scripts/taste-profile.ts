import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { validateKeyReadOnly } from '../src/auth.js';
import { shutdown, withCheckedOutClient } from '../src/db.js';
import {
  lastCompletedMediaMonth,
  mediaMonthPeriod,
  parseTasteProfilePolicy,
  parseTasteProfileSelection,
  runTasteProfile,
  type TasteProfileMode,
  type TasteProfilePolicy,
  type TasteProfileSelection,
} from '../src/taste-profile.js';
import type { MediaTasteCategory } from '../src/media.js';
import type { AccessLevel } from '../src/types.js';

dotenv.config();

const TASTE_PROFILE_CLI_LOCK = 0x54525450; // "TRTP"

export function tasteProfileLockIdentity(keyId: string, environment: string): string {
  return JSON.stringify([keyId, environment]);
}

export interface TasteProfileCliOptions {
  mode: TasteProfileMode;
  category: MediaTasteCategory | 'all';
  period?: string;
  accessLevel: AccessLevel | 'all';
  force: boolean;
  json: boolean;
  selectionFile?: string;
}

export function parseTasteProfileCli(args: string[]): TasteProfileCliOptions {
  let explicitMode: TasteProfileMode | undefined;
  let category: TasteProfileCliOptions['category'] = 'all';
  let period: string | undefined;
  let accessLevel: TasteProfileCliOptions['accessLevel'] = 'all';
  let force = false;
  let json = false;
  let selectionFile: string | undefined;
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
    } else if (arg === '--access-level') {
      const parsed = value(index++, arg);
      if (!['normal', 'sensitive', 'secret', 'all'].includes(parsed)) {
        throw new Error('--access-level must be normal, sensitive, secret, or all');
      }
      accessLevel = parsed as TasteProfileCliOptions['accessLevel'];
    } else if (arg === '--selection-file') {
      if (selectionFile) throw new Error('--selection-file may be specified only once');
      selectionFile = value(index++, arg);
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
  if (mode === 'apply' && !selectionFile) throw new Error('--apply requires --selection-file from an approved preview');
  if (mode !== 'apply' && selectionFile) throw new Error('--selection-file is valid only with --apply');
  return { mode, category, period, accessLevel, force, json, selectionFile };
}

async function loadSelections(file: string | undefined): Promise<TasteProfileSelection[]> {
  if (!file) return [];
  let input: unknown;
  try { input = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Unable to load taste-profile selections: ${error instanceof Error ? error.message : String(error)}`); }
  const raw = Array.isArray(input) ? input : (input as any)?.selections;
  if (!Array.isArray(raw)) throw new Error('Taste-profile selection file must contain a selections array');
  return raw.map(parseTasteProfileSelection);
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
  const accessLevels = cli.accessLevel === 'all' ? policy.scope.accessLevels : [cli.accessLevel];
  for (const accessLevel of accessLevels) {
    if (!policy.scope.accessLevels.includes(accessLevel)) throw new Error(`Taste-profile policy does not approve ${accessLevel} access`);
  }
  const selections = await loadSelections(cli.selectionFile);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const results = await withCheckedOutClient(async client => {
      const lockIdentity = tasteProfileLockIdentity(auth.keyId, policy.environment);
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked', [TASTE_PROFILE_CLI_LOCK, lockIdentity],
      );
      if (lock.rows[0]?.locked !== true) throw new Error('Another taste-profile job is active for this owner');
      try {
        const values = [];
        for (const category of categories) {
          for (const accessLevel of accessLevels) {
            const approvedSelection = selections.find(selection => selection.category === category &&
              selection.period === period.label && selection.accessLevel === accessLevel);
            values.push(await runTasteProfile({
              auth, category, period, timeZone, accessLevel,
              environment: process.env.DEPLOYMENT_ENVIRONMENT!.trim(), policy,
              mode: cli.mode, force: cli.force, signal: controller.signal, approvedSelection,
            }));
          }
        }
        return values;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1, hashtext($2))',
          [TASTE_PROFILE_CLI_LOCK, lockIdentity]).catch(() => undefined);
      }
    });
    if (cli.json) console.log(JSON.stringify({ version: 2, feature: 'media-taste-profile', results,
      selections: results.flatMap(result => result.selection ? [result.selection] : []) }, null, 2));
    else {
      // Content-free by default. Explicit --json is the human-review boundary.
      for (const result of results) console.log('[taste-profile]', {
        category: result.category, period: result.period, mode: result.mode, status: result.status,
        accessLevel: result.accessLevel,
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
