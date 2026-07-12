import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

export interface RepairDocumentChunkCountsOptions {
  connectionString: string;
  batchSize?: number;
  maxRows?: number;
  dryRun?: boolean;
  onProgress?: (progress: DocumentChunkCountRepairProgress) => void;
}

export interface DocumentChunkCountRepairProgress {
  batch: number;
  updatedRows: number;
  remainingRows: number;
}

export interface RepairDocumentChunkCountsResult {
  updatedRows: number;
  remainingRows: number;
  batches: number;
  dryRun: boolean;
  complete: boolean;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_ROWS = 5000;
const MAX_BATCH_SIZE = 5000;

export async function repairDocumentChunkCounts(
  options: RepairDocumentChunkCountsOptions
): Promise<RepairDocumentChunkCountsResult> {
  const batchSize = boundedInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize', 1, MAX_BATCH_SIZE);
  const maxRows = boundedInteger(options.maxRows ?? DEFAULT_MAX_ROWS, 'maxRows', 1, Number.MAX_SAFE_INTEGER);
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();

  try {
    await rejectRuntimeRole(client);

    if (options.dryRun) {
      const remainingRows = await countRemaining(client);
      return {
        updatedRows: 0,
        remainingRows,
        batches: 0,
        dryRun: true,
        complete: remainingRows === 0,
      };
    }

    let updatedRows = 0;
    let batches = 0;

    while (updatedRows < maxRows) {
      const limit = Math.min(batchSize, maxRows - updatedRows);
      const result = await client.query<{ id: string }>(
        `
        WITH candidates AS MATERIALIZED (
          SELECT document.id,
                 (
                   SELECT COUNT(*)::integer
                   FROM public.memories AS memory
                   WHERE memory.document_id = document.id
                     AND (
                       document.client_id IS NULL
                       OR memory.client_id = document.client_id::text
                     )
                 ) AS actual_count
          FROM public.documents AS document
          WHERE document.chunk_count IS DISTINCT FROM (
            SELECT COUNT(*)::integer
            FROM public.memories AS memory
            WHERE memory.document_id = document.id
              AND (
                document.client_id IS NULL
                OR memory.client_id = document.client_id::text
              )
          )
          ORDER BY document.created_at, document.id
          LIMIT $1
          FOR UPDATE OF document SKIP LOCKED
        )
        UPDATE public.documents AS document
        SET chunk_count = candidates.actual_count
        FROM candidates
        WHERE document.id = candidates.id
          AND document.chunk_count IS DISTINCT FROM candidates.actual_count
        RETURNING document.id
        `,
        [limit]
      );

      const changed = result.rowCount ?? 0;
      if (changed === 0) break;

      updatedRows += changed;
      batches += 1;
      const remainingRows = await countRemaining(client);
      options.onProgress?.({ batch: batches, updatedRows, remainingRows });
    }

    const remainingRows = await countRemaining(client);
    return {
      updatedRows,
      remainingRows,
      batches,
      dryRun: false,
      complete: remainingRows === 0,
    };
  } finally {
    await client.end();
  }
}

async function countRemaining(client: pg.Client): Promise<number> {
  const result = await client.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count
    FROM public.documents AS document
    WHERE document.chunk_count IS DISTINCT FROM (
      SELECT COUNT(*)::integer
      FROM public.memories AS memory
      WHERE memory.document_id = document.id
        AND (
          document.client_id IS NULL
          OR memory.client_id = document.client_id::text
        )
    )
  `);
  return Number.parseInt(result.rows[0].count, 10);
}

async function rejectRuntimeRole(client: pg.Client): Promise<void> {
  const result = await client.query<{ currentUser: string }>(
    'SELECT current_user AS "currentUser"'
  );
  if (result.rows[0]?.currentUser === 'total_recall_app') {
    throw new Error(
      'total_recall_app cannot repair all document counters under RLS; ' +
      'use MIGRATION_DATABASE_URL for the schema owner or a superuser'
    );
  }
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function readNumberFlag(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const raw = process.argv[index + 1];
  if (!raw) throw new Error(`${flag} requires a value`);
  return Number.parseInt(raw, 10);
}

async function main(): Promise<void> {
  const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
  }

  const result = await repairDocumentChunkCounts({
    connectionString,
    batchSize: readNumberFlag('--batch-size', DEFAULT_BATCH_SIZE),
    maxRows: readNumberFlag('--max-rows', DEFAULT_MAX_ROWS),
    dryRun: process.argv.includes('--dry-run'),
    onProgress: progress => console.log(JSON.stringify({ type: 'progress', ...progress })),
  });
  console.log(JSON.stringify({ type: 'result', ...result }));
  if (!result.dryRun && !result.complete) {
    console.error(`document chunk-count repair incomplete: ${result.remainingRows} rows remain; re-run to resume`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('document chunk-count repair failed:', error);
    process.exit(1);
  });
}
