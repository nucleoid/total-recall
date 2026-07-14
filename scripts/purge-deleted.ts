import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { connectMaintenanceClient, type QueryClient } from './lib/maintenance-db.js';

dotenv.config();

export const PURGE_RETENTION_DAYS = 30;
export const PURGE_BATCH_SIZE = 100;
export const MAX_PURGE_PREVIEW_ROWS = 10_000;
const PURGE_LOCK_KEY = 0x54525051; // "TRPQ"
const PURGE_CLIENT_ID = 'maintenance:memory-purge';

export interface PurgeCandidate {
  id: string;
  namespace: string;
  deletedAt: string;
  fingerprint: string;
}

export interface PurgeBlockedRow {
  id: string;
  namespace: string;
  reason: string;
}

export interface PurgePreview {
  version: 1;
  retentionDays: 30;
  namespaces: string[];
  createdAt: string;
  candidates: PurgeCandidate[];
  blocked: PurgeBlockedRow[];
}

interface EligibleRow {
  id: string;
  namespace: string;
  deleted_at: string;
  media_references: number | string;
}

interface MemoryReferenceColumn {
  table_schema: string;
  table_name: string;
  column_name: string;
  constraint_name: string;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function memoryReferenceColumns(client: QueryClient): Promise<MemoryReferenceColumn[]> {
  const result = await client.query<MemoryReferenceColumn>(`
    SELECT ns.nspname AS table_schema, rel.relname AS table_name,
           source_column.attname AS column_name, constraint_row.conname AS constraint_name
    FROM pg_constraint constraint_row
    JOIN pg_class rel ON rel.oid = constraint_row.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY source_key(attnum, ord) ON TRUE
    JOIN LATERAL unnest(constraint_row.confkey) WITH ORDINALITY target_key(attnum, ord)
      ON target_key.ord = source_key.ord
    JOIN pg_attribute source_column
      ON source_column.attrelid = constraint_row.conrelid AND source_column.attnum = source_key.attnum
    JOIN pg_attribute target_column
      ON target_column.attrelid = constraint_row.confrelid AND target_column.attnum = target_key.attnum
    WHERE constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'public.memories'::regclass
      AND target_column.attname = 'id'
    ORDER BY ns.nspname, rel.relname, source_column.attname
  `);
  return result.rows;
}

async function referencedMemoryIds(
  client: QueryClient,
  ids: string[],
  references: MemoryReferenceColumn[],
): Promise<Map<string, string>> {
  const blocked = new Map<string, string>();
  if (ids.length === 0) return blocked;
  for (const reference of references) {
    const table = `${quoteIdentifier(reference.table_schema)}.${quoteIdentifier(reference.table_name)}`;
    const column = quoteIdentifier(reference.column_name);
    const result = await client.query<{ memory_id: string }>(
      `SELECT DISTINCT ${column}::text AS memory_id FROM ${table} WHERE ${column} = ANY($1::uuid[])`,
      [ids],
    );
    for (const row of result.rows) {
      blocked.set(row.memory_id, reference.table_name === 'media_events'
        ? 'media_events'
        : `foreign_key:${reference.constraint_name}`);
    }
  }
  return blocked;
}

function fingerprint(row: Pick<EligibleRow, 'id' | 'deleted_at'>): string {
  return createHash('sha256').update(`${row.id}\0${row.deleted_at}`).digest('hex');
}

export function parsePurgeNamespaces(raw: string | undefined): string[] {
  if (!raw?.trim()) throw new Error('PURGE_NAMESPACES must explicitly list at least one namespace');
  let values: unknown;
  try { values = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(','); }
  catch { throw new Error('PURGE_NAMESPACES must be a JSON array or comma-separated list'); }
  if (!Array.isArray(values)) throw new Error('PURGE_NAMESPACES must be an array');
  const namespaces = [...new Set(values.map(value => typeof value === 'string' ? value.trim() : ''))].sort();
  if (namespaces.length === 0 || namespaces.some(value => !value || value.includes(','))) {
    throw new Error('PURGE_NAMESPACES contains an invalid or empty namespace');
  }
  return namespaces;
}

async function lockRun(client: QueryClient): Promise<void> {
  const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [PURGE_LOCK_KEY]);
  if (result.rows[0]?.locked !== true) throw new Error('Another memory purge is already running');
}

async function unlockRun(client: QueryClient): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [PURGE_LOCK_KEY]);
}

async function assertCompleteInventory(client: QueryClient, namespaces: string[]): Promise<void> {
  const result = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM public.memories
    WHERE deleted_at IS NOT NULL
      AND deleted_at <= statement_timestamp() - INTERVAL '${PURGE_RETENTION_DAYS} days'
      AND NOT (namespace = ANY($1::text[]))
  `, [namespaces]);
  const outside = Number(result.rows[0]?.count ?? 0);
  if (outside > 0) throw new Error(`${outside} eligible tombstone(s) exist outside PURGE_NAMESPACES; inventory is incomplete`);
}

async function eligibleRows(client: QueryClient, namespaces: string[]): Promise<EligibleRow[]> {
  const result = await client.query<EligibleRow>(`
    SELECT m.id, m.namespace, m.deleted_at::text AS deleted_at,
           (SELECT count(*) FROM public.media_events e WHERE e.memory_id = m.id)::int AS media_references
    FROM public.memories m
    WHERE m.deleted_at IS NOT NULL
      AND m.deleted_at <= statement_timestamp() - INTERVAL '${PURGE_RETENTION_DAYS} days'
      AND m.namespace = ANY($1::text[])
    ORDER BY m.deleted_at, m.id
    LIMIT ${MAX_PURGE_PREVIEW_ROWS}
  `, [namespaces]);
  return result.rows;
}

export async function previewDeletedWithClient(client: QueryClient, namespaces: string[]): Promise<PurgePreview> {
  if (namespaces.length === 0) throw new Error('Purge namespace inventory cannot be empty');
  await assertCompleteInventory(client, namespaces);
  const rows = await eligibleRows(client, namespaces);
  const references = await memoryReferenceColumns(client);
  const referenced = await referencedMemoryIds(client, rows.map(row => row.id), references);
  for (const row of rows) {
    if (Number(row.media_references) > 0) referenced.set(row.id, 'media_events');
  }
  return {
    version: 1,
    retentionDays: PURGE_RETENTION_DAYS,
    namespaces: [...namespaces].sort(),
    createdAt: new Date().toISOString(),
    candidates: rows.filter(row => !referenced.has(row.id)).map(row => ({
      id: row.id,
      namespace: row.namespace,
      deletedAt: row.deleted_at,
      fingerprint: fingerprint(row),
    })),
    blocked: rows.filter(row => referenced.has(row.id)).map(row => ({
      id: row.id,
      namespace: row.namespace,
      reason: referenced.get(row.id)!,
    })),
  };
}

function assertPreviewShape(preview: PurgePreview, namespaces: string[]): void {
  if (preview.version !== 1 || preview.retentionDays !== PURGE_RETENTION_DAYS || !Array.isArray(preview.candidates) || !Array.isArray(preview.blocked)) {
    throw new Error('Invalid purge preview manifest');
  }
  if (JSON.stringify(preview.namespaces) !== JSON.stringify([...namespaces].sort())) {
    throw new Error('Purge preview namespace inventory does not match PURGE_NAMESPACES');
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const digest = /^[0-9a-f]{64}$/;
  if (new Set(preview.candidates.map(row => row.id)).size !== preview.candidates.length ||
      new Set(preview.blocked.map(row => row.id)).size !== preview.blocked.length) {
    throw new Error('Purge preview contains duplicate rows');
  }
  for (const row of preview.candidates) {
    if (!uuid.test(row.id) || !preview.namespaces.includes(row.namespace) ||
        !Number.isFinite(new Date(row.deletedAt).getTime()) || !digest.test(row.fingerprint)) {
      throw new Error('Purge preview contains a malformed candidate');
    }
  }
  for (const row of preview.blocked) {
    if (!uuid.test(row.id) || !preview.namespaces.includes(row.namespace) ||
        (row.reason !== 'media_events' && !(row.reason.startsWith('foreign_key:') && row.reason.length <= 256))) {
      throw new Error('Purge preview contains a malformed blocked row');
    }
  }
}

function candidateSignature(rows: PurgeCandidate[]): string[] {
  return rows.map(row => `${row.id}:${row.namespace}:${row.deletedAt}:${row.fingerprint}`).sort();
}

export async function applyDeletedWithClient(
  client: QueryClient,
  namespaces: string[],
  preview: PurgePreview,
  isCancelled: () => boolean = () => false,
): Promise<{ purged: number; blocked: number }> {
  assertPreviewShape(preview, namespaces);
  await lockRun(client);
  try {
    await assertCompleteInventory(client, namespaces);
    const current = await eligibleRows(client, namespaces);
    const references = await memoryReferenceColumns(client);
    const referenced = await referencedMemoryIds(client, current.map(row => row.id), references);
    for (const row of current) {
      if (Number(row.media_references) > 0) referenced.set(row.id, 'media_events');
    }
    const currentCandidates = current.filter(row => !referenced.has(row.id)).map(row => ({
      id: row.id,
      namespace: row.namespace,
      deletedAt: row.deleted_at,
      fingerprint: fingerprint(row),
    }));
    const currentEligibleIds = current.map(row => row.id).sort();
    const previewEligibleIds = [...preview.candidates.map(row => row.id), ...preview.blocked.map(row => row.id)].sort();
    const currentBlocked = current.filter(row => referenced.has(row.id))
      .map(row => `${row.id}:${row.namespace}:${referenced.get(row.id)}`).sort();
    const previewBlocked = preview.blocked.map(row => `${row.id}:${row.namespace}:${row.reason}`).sort();
    if (JSON.stringify(currentEligibleIds) !== JSON.stringify(previewEligibleIds) ||
        JSON.stringify(currentBlocked) !== JSON.stringify(previewBlocked) ||
        JSON.stringify(candidateSignature(currentCandidates)) !== JSON.stringify(candidateSignature(preview.candidates))) {
      throw new Error('Purge eligible set or candidate state drifted since preview; generate and verify a new preview');
    }

    let purged = 0;
    for (let offset = 0; offset < preview.candidates.length; offset += PURGE_BATCH_SIZE) {
      if (isCancelled()) throw new Error(`Purge cancelled after ${purged} committed deletion(s)`);
      const batch = preview.candidates.slice(offset, offset + PURGE_BATCH_SIZE);
      await client.query('BEGIN');
      try {
        for (const candidate of batch) {
          const locked = await client.query<EligibleRow>(`
            SELECT m.id, m.namespace, m.deleted_at::text AS deleted_at,
                   (SELECT count(*) FROM public.media_events e WHERE e.memory_id = m.id)::int AS media_references
            FROM public.memories m
            WHERE m.id = $1::uuid
              AND m.namespace = $2
              AND m.deleted_at = $3::timestamptz
              AND m.deleted_at <= statement_timestamp() - INTERVAL '${PURGE_RETENTION_DAYS} days'
            FOR UPDATE
          `, [candidate.id, candidate.namespace, candidate.deletedAt]);
          const row = locked.rows[0];
          const nowReferenced = await referencedMemoryIds(client, [candidate.id], references);
          if (!row || fingerprint(row) !== candidate.fingerprint ||
              Number(row.media_references) !== 0 || nowReferenced.has(candidate.id)) {
            throw new Error(`Purge candidate ${candidate.id} drifted or became referenced`);
          }
          await client.query(
            `INSERT INTO public.audit_log (client_id, action, namespace, memory_id)
             VALUES ($1, 'memory.purge', $2, $3::uuid)`,
            [PURGE_CLIENT_ID, candidate.namespace, candidate.id],
          );
          const deleted = await client.query('DELETE FROM public.memories WHERE id = $1::uuid AND deleted_at IS NOT NULL', [candidate.id]);
          if (deleted.rowCount !== 1) throw new Error(`Purge candidate ${candidate.id} was not deleted`);
        }
        await client.query('COMMIT');
        purged += batch.length;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
    return { purged, blocked: preview.blocked.length };
  } finally {
    await unlockRun(client).catch(() => undefined);
  }
}

function parseCli(args: string[]): { mode: 'preview' | 'apply'; file: string } {
  if (args.length !== 2 || !['--preview', '--apply'].includes(args[0]) || !args[1]) {
    throw new Error('Usage: npm run purge:deleted -- --preview <manifest.json> | --apply <manifest.json>');
  }
  return { mode: args[0] === '--preview' ? 'preview' : 'apply', file: args[1] };
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const namespaces = parsePurgeNamespaces(process.env.PURGE_NAMESPACES);
  const { client, identity, source } = await connectMaintenanceClient();
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    console.log('[purge] Maintenance database', { ...identity, source });
    console.log('[purge] Explicit namespace inventory', namespaces);
    if (options.mode === 'preview') {
      await lockRun(client);
      let preview: PurgePreview;
      try { preview = await previewDeletedWithClient(client, namespaces); }
      finally { await unlockRun(client).catch(() => undefined); }
      await writeFile(options.file, `${JSON.stringify(preview, null, 2)}\n`, { flag: 'wx' });
      console.log('[purge] Preview written', { file: options.file, candidates: preview.candidates.length, blocked: preview.blocked.length });
      if (preview.blocked.length > 0) process.exitCode = 2;
    } else {
      const preview = JSON.parse(await readFile(options.file, 'utf8')) as PurgePreview;
      const result = await applyDeletedWithClient(client, namespaces, preview, () => cancelled);
      console.log('[purge] Apply complete', result);
      if (result.blocked > 0) process.exitCode = 2;
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[purge] Failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
