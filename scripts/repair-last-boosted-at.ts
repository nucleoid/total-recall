import { pathToFileURL } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export interface RepairLastBoostedAtOptions {
  connectionString: string;
  batchSize?: number;
  maxRows?: number;
  dryRun?: boolean;
}

export interface RepairLastBoostedAtResult {
  updatedRows: number;
  remainingRows: number;
  batches: number;
  dryRun: boolean;
}

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_ROWS = 10000;
const MAX_BATCH_SIZE = 10000;

export async function repairLastBoostedAt(
  options: RepairLastBoostedAtOptions
): Promise<RepairLastBoostedAtResult> {
  const batchSize = boundedInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize', 1, MAX_BATCH_SIZE);
  const maxRows = boundedInteger(options.maxRows ?? DEFAULT_MAX_ROWS, 'maxRows', 1, Number.MAX_SAFE_INTEGER);
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();

  try {
    if (options.dryRun) {
      const remaining = await countRemaining(client);
      return {
        updatedRows: 0,
        remainingRows: remaining,
        batches: 0,
        dryRun: true,
      };
    }

    let updatedRows = 0;
    let batches = 0;

    while (updatedRows < maxRows) {
      const limit = Math.min(batchSize, maxRows - updatedRows);
      const result = await client.query<{ id: string }>(
        `
        WITH candidates AS (
          SELECT id
          FROM public.memories
          WHERE last_boosted_at IS NULL
            AND deleted_at IS NULL
          ORDER BY created_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE public.memories AS memories
        SET last_boosted_at = COALESCE(memories.accessed_at, memories.created_at, NOW()),
            updated_at = NOW()
        FROM candidates
        WHERE memories.id = candidates.id
          AND memories.deleted_at IS NULL
        RETURNING memories.id
        `,
        [limit]
      );

      if (result.rowCount === 0) {
        break;
      }

      updatedRows += result.rowCount ?? 0;
      batches += 1;
    }

    return {
      updatedRows,
      remainingRows: await countRemaining(client),
      batches,
      dryRun: false,
    };
  } finally {
    await client.end();
  }
}

async function countRemaining(client: pg.Client): Promise<number> {
  const result = await client.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count
    FROM public.memories
    WHERE last_boosted_at IS NULL
      AND deleted_at IS NULL
  `);
  return Number.parseInt(result.rows[0].count, 10);
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function readNumberFlag(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return fallback;
  }

  const raw = process.argv[index + 1];
  if (!raw) {
    throw new Error(`${flag} requires a value`);
  }
  return Number.parseInt(raw, 10);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const result = await repairLastBoostedAt({
    connectionString,
    batchSize: readNumberFlag('--batch-size', DEFAULT_BATCH_SIZE),
    maxRows: readNumberFlag('--max-rows', DEFAULT_MAX_ROWS),
    dryRun: process.argv.includes('--dry-run'),
  });

  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('last_boosted_at repair failed:', err);
    process.exit(1);
  });
}
