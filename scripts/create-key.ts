import pg from 'pg';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { generateKey, hashKey } from '../src/auth.js';
import { parseCsv, parseExpiry, parseLimit, validatePermissions } from './lib/key-policy.js';

dotenv.config();

export type CreateKeyOptions = {
  name: string;
  namespaces: string[];
  permissions: string[];
  maxAccessLevel: 'normal' | 'sensitive' | 'secret';
  expiresAt: Date | null;
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
};

export function parseCreateKeyArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): CreateKeyOptions {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    '--rpm': '--rpm', '--requests-per-minute': '--rpm',
    '--daily-quota': '--daily-quota', '--requests-per-day': '--daily-quota',
  };
  const known = new Set(['--name', '--namespaces', '--permissions', '--max-access-level', '--expires', '--rpm', '--daily-quota']);
  for (let i = 0; i < args.length; i++) {
    const option = aliases[args[i]] ?? args[i];
    if (!known.has(option)) throw new Error(`Unknown option: ${args[i]}`);
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`);
    if (values.has(option)) throw new Error(`${option} may only be specified once`);
    values.set(option, value);
  }

  const name = values.get('--name')?.trim() ?? '';
  if (!name) throw new Error('--name is required');
  const namespaces = parseCsv(values.get('--namespaces') ?? 'shared', '--namespaces');
  const permissions = parseCsv(values.get('--permissions') ?? 'read,write', '--permissions');
  validatePermissions(permissions);
  const maxAccessLevel = values.get('--max-access-level') ?? 'normal';
  if (!['normal', 'sensitive', 'secret'].includes(maxAccessLevel)) {
    throw new Error('--max-access-level must be one of: normal, sensitive, secret');
  }

  const rpmValue = values.get('--rpm') ?? env.API_KEY_DEFAULT_RPM;
  const dailyValue = values.get('--daily-quota') ?? env.API_KEY_DEFAULT_DAILY_QUOTA;
  return {
    name,
    namespaces,
    permissions,
    maxAccessLevel: maxAccessLevel as CreateKeyOptions['maxAccessLevel'],
    expiresAt: values.has('--expires') ? parseExpiry(values.get('--expires')!, now) : null,
    requestsPerMinute: parseLimit(rpmValue, '--rpm'),
    requestsPerDay: parseLimit(dailyValue, '--daily-quota'),
  };
}

export async function createKey(options: CreateKeyOptions): Promise<string> {
  const rawKey = generateKey();
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`api-key-name:${options.name}`]);
    const duplicate = await client.query(
      `SELECT 1 FROM api_keys
       WHERE name = $1 AND enabled = true AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > statement_timestamp())
       LIMIT 1`,
      [options.name],
    );
    if (duplicate.rows.length > 0) throw new Error(`An active API key named "${options.name}" already exists`);
    await client.query(
      `INSERT INTO api_keys
         (key_hash, name, namespaces, permissions, max_access_level, expires_at, requests_per_minute, requests_per_day)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [hashKey(rawKey), options.name, options.namespaces, options.permissions, options.maxAccessLevel,
       options.expiresAt, options.requestsPerMinute, options.requestsPerDay],
    );
    await client.query('COMMIT');
    began = false;
    return rawKey;
  } catch (error) {
    if (began) await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const options = parseCreateKeyArgs(process.argv.slice(2));
  const rawKey = await createKey(options);
  console.log('API key created successfully!');
  console.log(`Name: ${options.name}`);
  console.log(`Namespaces: ${options.namespaces.join(', ')}`);
  console.log(`Permissions: ${options.permissions.join(', ')}`);
  console.log(`Max access level: ${options.maxAccessLevel}`);
  console.log(`Expires: ${options.expiresAt?.toISOString() ?? 'never'}`);
  console.log(`Requests/minute: ${options.requestsPerMinute ?? 'unlimited'}`);
  console.log(`Requests/day: ${options.requestsPerDay ?? 'unlimited'}`);
  console.log(`\nKey (save this — it cannot be recovered):\n${rawKey}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
