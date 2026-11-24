import { randomUUID } from 'node:crypto';
import { chmod, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { validateBoundedDecayOptions, type BoundedDecaySummary, type MaintenanceQueryClient } from '../src/maintenance.js';

export const NATIVE_MAINTENANCE_DATABASE_URL = 'postgresql://postgres@127.0.0.1:5432/total_recall';
export const NATIVE_MAINTENANCE_PAGE_SIZE = 100;
export const NATIVE_MAINTENANCE_STATE_PATH = '/job/state.json';
export const NATIVE_MAINTENANCE_RECEIPT_PATH = '/job/last-receipt.json';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T.*Z$/;

export type NativeMaintenanceState = {
  version: 1;
  passDay: string;
  asOf: string;
  afterId: string | null;
  complete: boolean;
  completedDay: string | null;
};

export type NativeMaintenanceReceipt = {
  version: 1;
  kind: 'bounded_native_decay';
  status: 'page_applied' | 'pass_complete' | 'already_complete_today';
  database: 'total_recall';
  role: 'postgres';
  utcDay: string;
  passDay: string;
  asOf: string;
  beforeCursor: string | null;
  nextCursor: string | null;
  selected: number;
  updated: number;
  byNamespace: Record<string, number>;
  complete: boolean;
  classificationsFinalized: true;
  generatedAt: string;
};

type OwnerPreflight = {
  database: string;
  role: string;
  null_bases: string | number;
  base_not_null: boolean;
};

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Native maintenance requires a Unix UID');
  return uid;
}

export function validateNativeMaintenanceState(value: unknown): NativeMaintenanceState {
  const state = value as Partial<NativeMaintenanceState> | null;
  if (!state || state.version !== 1 || typeof state.passDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(state.passDay) ||
      typeof state.asOf !== 'string' || !UTC_INSTANT.test(state.asOf) || !Number.isFinite(new Date(state.asOf).getTime()) ||
      (state.afterId !== null && (typeof state.afterId !== 'string' || !UUID_PATTERN.test(state.afterId))) ||
      typeof state.complete !== 'boolean' || (state.completedDay !== null &&
        (typeof state.completedDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(state.completedDay))) ||
      state.asOf.slice(0, 10) !== state.passDay || (state.complete !== (state.completedDay !== null)) ||
      (state.completedDay !== null && state.completedDay < state.passDay)) {
    throw new Error('Native maintenance state is invalid');
  }
  return state as NativeMaintenanceState;
}

export async function readNativeMaintenanceState(path = NATIVE_MAINTENANCE_STATE_PATH): Promise<NativeMaintenanceState | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.uid !== currentUid()) {
      throw new Error('Native maintenance state file ownership or mode is invalid');
    }
    return validateNativeMaintenanceState(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writePrivateJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o777) !== 0o700 ||
      directoryInfo.uid !== currentUid()) throw new Error('Native maintenance state directory ownership or mode is invalid');
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function stateForInvocation(previous: NativeMaintenanceState | null, now: Date): NativeMaintenanceState {
  if (!Number.isFinite(now.getTime())) throw new Error('Native maintenance invocation time is invalid');
  const instant = now.toISOString();
  const today = instant.slice(0, 10);
  if (!previous) return { version: 1, passDay: today, asOf: instant, afterId: null, complete: false, completedDay: null };
  const state = validateNativeMaintenanceState(previous);
  if (today < state.passDay || (state.completedDay !== null && today < state.completedDay)) {
    throw new Error('Native maintenance clock moved behind persisted state');
  }
  if (state.complete && state.completedDay !== null && today > state.completedDay) {
    return { version: 1, passDay: today, asOf: instant, afterId: null, complete: false, completedDay: null };
  }
  return state;
}

export async function verifyNativeMaintenanceOwner(client: MaintenanceQueryClient): Promise<void> {
  const result = await client.query<OwnerPreflight>(`
    SELECT current_database() AS database, current_role AS role,
      (SELECT count(*)::text FROM public.memories WHERE relevance_base_score IS NULL) AS null_bases,
      (SELECT a.attnotnull FROM pg_attribute a
       WHERE a.attrelid='public.memories'::regclass AND a.attname='relevance_base_score' AND NOT a.attisdropped) AS base_not_null
  `);
  const row = result.rows[0];
  if (!row || row.database !== 'total_recall' || row.role !== 'postgres') {
    throw new Error('Native maintenance requires the exact postgres owner role in total_recall');
  }
  if (Number(row.null_bases) !== 0 || row.base_not_null !== true) {
    throw new Error('Native maintenance requires finalized relevance classifications with zero NULL bases');
  }
}


export async function updateNativeDecayPageWithClient(
  client: MaintenanceQueryClient,
  rawOptions: { asOf: string; afterId: string | null; limit: number; apply: true },
): Promise<BoundedDecaySummary> {
  const options = validateBoundedDecayOptions(rawOptions);
  if (!options.apply || options.limit !== NATIVE_MAINTENANCE_PAGE_SIZE) {
    throw new Error('Native maintenance page must be one fixed apply batch of 100 rows');
  }
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '30s'`);
    const result = await client.query<{ id: string; namespace: string; computed_score: number; changed: boolean }>(`
      WITH candidates AS MATERIALIZED (
        SELECT id,namespace,relevance_base_score,decay_rate,accessed_at,access_count,relevance_score,updated_at
        FROM public.memories
        WHERE relevance_base_score IS NOT NULL
          AND id > COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > $1::timestamptz)
          AND (expires_at IS NULL OR expires_at > statement_timestamp())
          AND superseded_at IS NULL AND valid_to IS NULL
          AND (valid_from IS NULL OR valid_from <= $1::timestamptz)
          AND (valid_from IS NULL OR valid_from <= statement_timestamp())
          AND consolidated_into_id IS NULL
        ORDER BY id LIMIT $3
        FOR UPDATE
      ), computed AS MATERIALIZED (
        SELECT c.*, c.relevance_base_score * EXP(-COALESCE(c.decay_rate,0.01) * GREATEST(0.0,
          EXTRACT(EPOCH FROM ($1::timestamptz - COALESCE(c.accessed_at,$1::timestamptz))) / 86400.0))
          + LEAST(GREATEST(COALESCE(c.access_count,0) * 0.1,0.0),1.0) AS computed_score
        FROM candidates c
      ), updated AS (
        UPDATE public.memories m SET relevance_score=c.computed_score,updated_at=statement_timestamp()
        FROM computed c
        WHERE m.id=c.id AND m.relevance_base_score IS NOT NULL
          AND m.deleted_at IS NULL
          AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
          AND m.superseded_at IS NULL AND m.valid_to IS NULL
          AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp())
          AND m.consolidated_into_id IS NULL
          AND m.updated_at IS NOT DISTINCT FROM c.updated_at
          AND m.relevance_base_score IS NOT DISTINCT FROM c.relevance_base_score
          AND m.decay_rate IS NOT DISTINCT FROM c.decay_rate
          AND m.accessed_at IS NOT DISTINCT FROM c.accessed_at
          AND m.access_count IS NOT DISTINCT FROM c.access_count
          AND m.relevance_score IS DISTINCT FROM c.computed_score
        RETURNING m.id
      )
      SELECT c.id,c.namespace,c.computed_score,EXISTS(SELECT 1 FROM updated u WHERE u.id=c.id) AS changed
      FROM computed c ORDER BY c.id
    `, [options.asOf, options.afterId, options.limit]);
    const byNamespace: Record<string, number> = {};
    const scores: number[] = [];
    let updated = 0;
    for (const row of result.rows) {
      const score = Number(row.computed_score);
      if (!Number.isFinite(score)) throw new Error('Native maintenance computed a non-finite score');
      scores.push(score);
      if (row.changed) { updated += 1; byNamespace[row.namespace] = (byNamespace[row.namespace] ?? 0) + 1; }
    }
    scores.sort((left, right) => left - right);
    const summary: BoundedDecaySummary = {
      count: updated, selected: result.rows.length, updated,
      byNamespace: Object.fromEntries(Object.entries(byNamespace).sort(([left], [right]) => left.localeCompare(right))),
      nextCursor: result.rows.at(-1)?.id ?? null, asOf: options.asOf, dryRun: false,
    };
    if (scores.length > 0) Object.assign(summary, {
      min: scores[0].toFixed(4), max: scores.at(-1)!.toFixed(4), median: scores[Math.floor(scores.length / 2)].toFixed(4),
      avg: (scores.reduce((total, score) => total + score, 0) / scores.length).toFixed(4),
    });
    await client.query('COMMIT');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function executeNativeMaintenancePage(
  client: MaintenanceQueryClient,
  previous: NativeMaintenanceState | null,
  now: Date,
  updatePage: typeof updateNativeDecayPageWithClient = updateNativeDecayPageWithClient,
): Promise<{ state: NativeMaintenanceState; receipt: NativeMaintenanceReceipt; summary: BoundedDecaySummary | null }> {
  await verifyNativeMaintenanceOwner(client);
  const invocationState = stateForInvocation(previous, now);
  const utcDay = now.toISOString().slice(0, 10);
  if (invocationState.complete) {
    return {
      state: invocationState,
      summary: null,
      receipt: {
        version: 1, kind: 'bounded_native_decay', status: 'already_complete_today', database: 'total_recall', role: 'postgres',
        utcDay, passDay: invocationState.passDay, asOf: invocationState.asOf, beforeCursor: invocationState.afterId,
        nextCursor: invocationState.afterId, selected: 0, updated: 0, byNamespace: {}, complete: true,
        classificationsFinalized: true, generatedAt: now.toISOString(),
      },
    };
  }
  const beforeCursor = invocationState.afterId;
  const summary = await updatePage(client, {
    asOf: invocationState.asOf, afterId: beforeCursor, limit: NATIVE_MAINTENANCE_PAGE_SIZE, apply: true,
  });
  if (summary.selected > NATIVE_MAINTENANCE_PAGE_SIZE || summary.updated > summary.selected) {
    throw new Error('Native maintenance page returned invalid bounds');
  }
  const complete = summary.selected < NATIVE_MAINTENANCE_PAGE_SIZE;
  if (!complete && (!summary.nextCursor || summary.nextCursor === beforeCursor)) {
    throw new Error('Native maintenance full page did not advance its UUID cursor');
  }
  const state: NativeMaintenanceState = {
    ...invocationState,
    afterId: summary.nextCursor ?? beforeCursor,
    complete,
    completedDay: complete ? utcDay : null,
  };
  return {
    state,
    summary,
    receipt: {
      version: 1, kind: 'bounded_native_decay', status: complete ? 'pass_complete' : 'page_applied',
      database: 'total_recall', role: 'postgres', utcDay, passDay: state.passDay, asOf: state.asOf,
      beforeCursor, nextCursor: state.afterId, selected: summary.selected, updated: summary.updated,
      byNamespace: summary.byNamespace, complete, classificationsFinalized: true, generatedAt: now.toISOString(),
    },
  };
}

export async function runNativeMaintenanceInvocation(
  connectionString: string,
  statePath = NATIVE_MAINTENANCE_STATE_PATH,
  receiptPath = NATIVE_MAINTENANCE_RECEIPT_PATH,
  now = new Date(),
): Promise<NativeMaintenanceReceipt> {
  if (connectionString !== NATIVE_MAINTENANCE_DATABASE_URL) {
    throw new Error('Native maintenance database URL must match the fixed passwordless loopback owner path');
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const previous = await readNativeMaintenanceState(statePath);
    const result = await executeNativeMaintenancePage(client, previous, now);
    await writePrivateJsonAtomic(statePath, result.state);
    await writePrivateJsonAtomic(receiptPath, result.receipt);
    return result.receipt;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('Native maintenance owner accepts no command-line arguments');
  const databaseUrl = process.env.DATABASE_URL;
  const maintenanceUrl = process.env.MAINTENANCE_DATABASE_URL;
  if (databaseUrl !== NATIVE_MAINTENANCE_DATABASE_URL || maintenanceUrl !== NATIVE_MAINTENANCE_DATABASE_URL) {
    throw new Error('Fixed DATABASE_URL and MAINTENANCE_DATABASE_URL are required');
  }
  if (process.env.PGPASSWORD || process.env.PGSERVICE || process.env.PGPASSFILE) {
    throw new Error('Native maintenance refuses password or service credential environment variables');
  }
  const receipt = await runNativeMaintenanceInvocation(maintenanceUrl);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`[native-maintenance-owner] ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  });
}
