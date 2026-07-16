import pg from 'pg';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { generateKey, hashKey } from '../src/auth.js';
import { parseLimit, parseStrictDuration } from './lib/key-policy.js';

dotenv.config();

type RotateOptions = {
  name: string;
  graceMilliseconds: number;
  requestsPerMinute?: number | null;
  requestsPerDay?: number | null;
};

export function parseRotateKeyArgs(args: string[]): RotateOptions {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    '--requests-per-minute': '--rpm', '--requests-per-day': '--daily-quota',
  };
  const known = new Set(['--name', '--grace', '--rpm', '--daily-quota']);
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
  return {
    name,
    graceMilliseconds: values.has('--grace')
      ? parseStrictDuration(values.get('--grace')!, '--grace', true)
      : 0,
    ...(values.has('--rpm') ? { requestsPerMinute: parseLimit(values.get('--rpm'), '--rpm') } : {}),
    ...(values.has('--daily-quota') ? { requestsPerDay: parseLimit(values.get('--daily-quota'), '--daily-quota') } : {}),
  };
}

type RotatedKey = {
  rawKey: string;
  expiresAt: Date;
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
};

export async function rotateKey(options: RotateOptions): Promise<RotatedKey> {
  const rawKey = generateKey();
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    const source = await client.query(
      `SELECT id, namespaces, permissions, max_access_level, requests_per_minute, requests_per_day
       FROM api_keys
       WHERE name = $1 AND enabled = true AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > statement_timestamp())
       FOR UPDATE`,
      [options.name],
    );
    if (source.rows.length === 0) throw new Error(`No active API key named "${options.name}"`);
    if (source.rows.length > 1) throw new Error(`API key name "${options.name}" is ambiguous`);
    const old = source.rows[0];

    const clock = await client.query<{ now: Date; deadline: Date }>(
      `SELECT statement_timestamp() AS now,
              statement_timestamp() + $1::double precision * interval '1 millisecond' AS deadline`,
      [options.graceMilliseconds],
    );
    const { now, deadline } = clock.rows[0];
    const retiredName = `${options.name} [rotated ${new Date(now).toISOString()} ${String(old.id).slice(0, 8)}]`;
    await client.query(
      `UPDATE api_keys SET name = $1, expires_at = $2 WHERE id = $3`,
      [retiredName, deadline, old.id],
    );

    const rpm = options.requestsPerMinute !== undefined ? options.requestsPerMinute : old.requests_per_minute;
    const daily = options.requestsPerDay !== undefined ? options.requestsPerDay : old.requests_per_day;
    await client.query(
      `INSERT INTO api_keys
         (key_hash, name, namespaces, permissions, max_access_level, requests_per_minute, requests_per_day, rotated_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [hashKey(rawKey), options.name, old.namespaces, old.permissions, old.max_access_level, rpm, daily, old.id],
    );
    await client.query('COMMIT');
    began = false;
    return { rawKey, expiresAt: new Date(deadline), requestsPerMinute: rpm, requestsPerDay: daily };
  } catch (error) {
    if (began) await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const options = parseRotateKeyArgs(process.argv.slice(2));
  const result = await rotateKey(options);
  console.log('API key rotated successfully!');
  console.log(`Name: ${options.name}`);
  console.log(`Predecessor expires: ${result.expiresAt.toISOString()}`);
  console.log(`Requests/minute: ${result.requestsPerMinute ?? 'unlimited'}`);
  console.log(`Requests/day: ${result.requestsPerDay ?? 'unlimited'}`);
  console.log(`\nReplacement key (save this — it cannot be recovered):\n${result.rawKey}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
