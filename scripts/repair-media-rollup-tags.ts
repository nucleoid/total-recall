import { pathToFileURL } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';
import { buildTags } from '../src/rollup.js';
import type { MediaEvent } from '../src/media.js';

dotenv.config();

export interface RepairMediaRollupTagsOptions {
  connectionString: string;
  batchSize?: number;
  maxRows?: number;
  dryRun?: boolean;
  cursor?: string;
  confirmBackup?: boolean;
}

export interface RepairMediaRollupTagsResult {
  scannedRows: number;
  differingRows: number;
  updatedRows: number;
  batches: number;
  dryRun: boolean;
  limitReached: boolean;
  nextCursor: string | null;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_ROWS = 10_000;
const MAX_BATCH_SIZE = 10_000;

type RepairCandidate = MediaEvent & { current_tags: string[] };
type RepairCursor = { keyId: string; playedAt: string; eventId: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function repairMediaRollupTags(
  options: RepairMediaRollupTagsOptions,
): Promise<RepairMediaRollupTagsResult> {
  if (options.dryRun !== true && options.confirmBackup !== true) {
    throw new Error('Apply requires backup confirmation (--confirm-backup) because prior tags cannot be reconstructed');
  }
  const batchSize = boundedInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize', 1, MAX_BATCH_SIZE);
  const maxRows = boundedInteger(options.maxRows ?? DEFAULT_MAX_ROWS, 'maxRows', 1, Number.MAX_SAFE_INTEGER);
  const pool = new pg.Pool({ connectionString: options.connectionString, max: 1 });
  let scannedRows = 0;
  let differingRows = 0;
  let updatedRows = 0;
  let batches = 0;
  let nextCursor: string | null = null;
  const resume = options.cursor ? decodeCursor(options.cursor) : null;

  try {
    const keys = await pool.query<{ id: string }>('SELECT id::text AS id FROM api_keys ORDER BY id');

    for (const { id: keyId } of keys.rows) {
      if (resume && keyId < resume.keyId) continue;
      let cursorPlayedAt: Date | null = resume && keyId === resume.keyId ? new Date(resume.playedAt) : null;
      let cursorId: string | null = resume && keyId === resume.keyId ? resume.eventId : null;

      while (scannedRows < maxRows) {
        const limit = Math.min(batchSize, maxRows - scannedRows);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.allowed_namespaces', $1, true)", [JSON.stringify(['media'])]);
          await client.query("SELECT set_config('app.current_key_id', $1, true)", [keyId]);
          await client.query("SELECT set_config('app.current_key_is_admin', 'false', true)");

          const page = await client.query<RepairCandidate>(
            `SELECT e.*, m.tags AS current_tags
             FROM media_events e
             JOIN memories m ON m.id = e.memory_id
             WHERE e.client_id = $1::uuid
               AND m.namespace = 'media'
               AND m.deleted_at IS NULL
               AND m.client_id = e.client_id::text
               AND m.source = 'media:' || e.service
               AND ($2::timestamptz IS NULL OR (e.played_at, e.id) > ($2::timestamptz, $3::uuid))
             ORDER BY e.played_at, e.id
             LIMIT $4`,
            [keyId, cursorPlayedAt, cursorId, limit],
          );

          if (page.rows.length === 0) {
            await client.query('COMMIT');
            break;
          }

          batches += 1;
          scannedRows += page.rows.length;
          for (const event of page.rows) {
            const expected = buildTags(event);
            if (arraysEqual(event.current_tags, expected)) continue;
            differingRows += 1;
            if (options.dryRun) continue;

            const updated = await client.query(
              `UPDATE memories m
               SET tags = $1, updated_at = NOW()
               WHERE m.id = $2
                 AND m.deleted_at IS NULL
                 AND m.superseded_at IS NULL
                 AND m.namespace = 'media'
                 AND m.client_id = $3
                 AND m.source = 'media:' || $4
                 AND EXISTS (
                   SELECT 1 FROM media_events e
                   WHERE e.id = $5 AND e.memory_id = m.id AND e.client_id = $3::uuid
                 )`,
              [expected, event.memory_id, keyId, event.service, event.id],
            );
            updatedRows += updated.rowCount ?? 0;
          }

          const last = page.rows.at(-1)!;
          cursorPlayedAt = last.played_at;
          cursorId = last.id;
          nextCursor = encodeCursor({ keyId, playedAt: last.played_at.toISOString(), eventId: last.id });
          await client.query('COMMIT');

          if (page.rows.length < limit) break;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }
      if (scannedRows >= maxRows) break;
    }
    if (scannedRows < maxRows) nextCursor = null;
  } finally {
    await pool.end();
  }

  return {
    scannedRows,
    differingRows,
    updatedRows,
    batches,
    dryRun: options.dryRun === true,
    limitReached: scannedRows >= maxRows,
    nextCursor,
  };
}

function encodeCursor(cursor: RepairCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): RepairCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('cursor must be a valid repair cursor');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('cursor must be a valid repair cursor');
  const cursor = parsed as Partial<RepairCursor>;
  if (!cursor.keyId || !cursor.eventId || !UUID_PATTERN.test(cursor.keyId) || !UUID_PATTERN.test(cursor.eventId)) {
    throw new Error('cursor must be a valid repair cursor');
  }
  const playedAt = new Date(cursor.playedAt ?? '');
  if (Number.isNaN(playedAt.getTime())) throw new Error('cursor must be a valid repair cursor');
  return { keyId: cursor.keyId, playedAt: playedAt.toISOString(), eventId: cursor.eventId };
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function readStringFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const raw = process.argv[index + 1];
  if (!raw) throw new Error(`${flag} requires a value`);
  return raw;
}

function readNumberFlag(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const raw = process.argv[index + 1];
  if (!raw) throw new Error(`${flag} requires a value`);
  return Number.parseInt(raw, 10);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  if (!process.argv.includes('--dry-run') && !process.argv.includes('--apply')) {
    throw new Error('Choose exactly one mode: --dry-run or --apply');
  }
  if (process.argv.includes('--dry-run') && process.argv.includes('--apply')) {
    throw new Error('Choose exactly one mode: --dry-run or --apply');
  }

  const result = await repairMediaRollupTags({
    connectionString,
    batchSize: readNumberFlag('--batch-size', DEFAULT_BATCH_SIZE),
    maxRows: readNumberFlag('--max-rows', DEFAULT_MAX_ROWS),
    dryRun: process.argv.includes('--dry-run'),
    cursor: readStringFlag('--cursor'),
    confirmBackup: process.argv.includes('--confirm-backup'),
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('media rollup tag repair failed:', error);
    process.exit(1);
  });
}
