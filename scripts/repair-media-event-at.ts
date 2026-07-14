import { pathToFileURL } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export interface RepairMediaEventAtOptions {
  connectionString: string;
  batchSize?: number;
  maxRows?: number;
  dryRun?: boolean;
  malformedSampleLimit?: number;
}

export interface MalformedMediaEventAtSample {
  source: string;
  playedAt: string;
}

export interface RepairMediaEventAtResult {
  updatedRows: number;
  remainingRows: number;
  malformedRows: number;
  malformedSamples: MalformedMediaEventAtSample[];
  batches: number;
  dryRun: boolean;
}

export interface CreateMediaEventAtIndexOptions {
  connectionString: string;
}

export interface CreateMediaEventAtIndexResult {
  indexName: string;
  created: boolean;
  indexExists: boolean;
  indexValid: boolean;
}

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_ROWS = 10000;
const DEFAULT_MALFORMED_SAMPLE_LIMIT = 20;
const MAX_BATCH_SIZE = 10000;
const MAX_MALFORMED_SAMPLE_LIMIT = 100;
const MEDIA_EVENT_AT_INDEX = 'memories_media_event_at_idx';
const ISO_TIMESTAMPTZ_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$';

type IndexState = {
  exists: boolean;
  isValid: boolean;
};

export async function repairMediaEventAt(
  options: RepairMediaEventAtOptions
): Promise<RepairMediaEventAtResult> {
  const batchSize = boundedInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize', 1, MAX_BATCH_SIZE);
  const maxRows = boundedInteger(options.maxRows ?? DEFAULT_MAX_ROWS, 'maxRows', 1, Number.MAX_SAFE_INTEGER);
  const malformedSampleLimit = boundedInteger(
    options.malformedSampleLimit ?? DEFAULT_MALFORMED_SAMPLE_LIMIT,
    'malformedSampleLimit',
    0,
    MAX_MALFORMED_SAMPLE_LIMIT
  );
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();

  try {
    if (options.dryRun) {
      return {
        updatedRows: 0,
        remainingRows: await countRepairable(client),
        malformedRows: await countMalformed(client),
        malformedSamples: await loadMalformedSamples(client, malformedSampleLimit),
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
          WHERE namespace = 'media'
            AND deleted_at IS NULL
            AND event_at IS NULL
            AND metadata->>'played_at' IS NOT NULL
            AND metadata->>'played_at' ~ $2
            AND pg_input_is_valid(metadata->>'played_at', 'timestamptz')
          ORDER BY created_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE public.memories AS memories
        SET event_at = (memories.metadata->>'played_at')::timestamptz
        FROM candidates
        WHERE memories.id = candidates.id
          AND memories.deleted_at IS NULL
        RETURNING memories.id
        `,
        [limit, ISO_TIMESTAMPTZ_PATTERN]
      );

      if (result.rowCount === 0) {
        break;
      }

      updatedRows += result.rowCount ?? 0;
      batches += 1;
    }

    return {
      updatedRows,
      remainingRows: await countRepairable(client),
      malformedRows: await countMalformed(client),
      malformedSamples: await loadMalformedSamples(client, malformedSampleLimit),
      batches,
      dryRun: false,
    };
  } finally {
    await client.end();
  }
}

export async function createMediaEventAtIndex(
  options: CreateMediaEventAtIndexOptions
): Promise<CreateMediaEventAtIndexResult> {
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();

  try {
    const before = await loadIndexState(client);
    if (before.exists && !before.isValid) {
      await client.query(`
        DROP INDEX CONCURRENTLY IF EXISTS public.memories_media_event_at_idx
      `);
    }

    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_media_event_at_idx
        ON public.memories (namespace, event_at DESC)
        WHERE event_at IS NOT NULL
    `);
    const after = await loadIndexState(client);

    return {
      indexName: MEDIA_EVENT_AT_INDEX,
      created: !before.exists || !before.isValid,
      indexExists: after.exists,
      indexValid: after.isValid,
    };
  } finally {
    await client.end();
  }
}

async function countRepairable(client: pg.Client): Promise<number> {
  const result = await client.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count
    FROM public.memories
    WHERE namespace = 'media'
      AND deleted_at IS NULL
      AND event_at IS NULL
      AND metadata->>'played_at' IS NOT NULL
      AND metadata->>'played_at' ~ $1
      AND pg_input_is_valid(metadata->>'played_at', 'timestamptz')
  `, [ISO_TIMESTAMPTZ_PATTERN]);
  return Number.parseInt(result.rows[0].count, 10);
}

async function countMalformed(client: pg.Client): Promise<number> {
  const result = await client.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count
    FROM public.memories
    WHERE namespace = 'media'
      AND deleted_at IS NULL
      AND event_at IS NULL
      AND metadata->>'played_at' IS NOT NULL
      AND (
        metadata->>'played_at' !~ $1
        OR NOT pg_input_is_valid(metadata->>'played_at', 'timestamptz')
      )
  `, [ISO_TIMESTAMPTZ_PATTERN]);
  return Number.parseInt(result.rows[0].count, 10);
}

async function loadMalformedSamples(
  client: pg.Client,
  limit: number
): Promise<MalformedMediaEventAtSample[]> {
  if (limit === 0) return [];

  const result = await client.query<MalformedMediaEventAtSample>(
    `
    SELECT source,
           metadata->>'played_at' AS "playedAt"
    FROM public.memories
    WHERE namespace = 'media'
      AND deleted_at IS NULL
      AND event_at IS NULL
      AND metadata->>'played_at' IS NOT NULL
      AND (
        metadata->>'played_at' !~ $1
        OR NOT pg_input_is_valid(metadata->>'played_at', 'timestamptz')
      )
    ORDER BY created_at, id
    LIMIT $2
    `,
    [ISO_TIMESTAMPTZ_PATTERN, limit]
  );
  return result.rows;
}

async function loadIndexState(client: pg.Client): Promise<IndexState> {
  const result = await client.query<{ exists: boolean; isValid: boolean }>(
    `
    WITH index_state AS (
      SELECT i.indisvalid
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = $1
        AND c.relkind = 'i'
    )
    SELECT EXISTS (SELECT 1 FROM index_state) AS exists,
           COALESCE((SELECT indisvalid FROM index_state), false) AS "isValid"
    `,
    [MEDIA_EVENT_AT_INDEX]
  );
  return {
    exists: result.rows[0]?.exists === true,
    isValid: result.rows[0]?.isValid === true,
  };
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

  const result = await repairMediaEventAt({
    connectionString,
    batchSize: readNumberFlag('--batch-size', DEFAULT_BATCH_SIZE),
    maxRows: readNumberFlag('--max-rows', DEFAULT_MAX_ROWS),
    malformedSampleLimit: readNumberFlag('--malformed-sample-limit', DEFAULT_MALFORMED_SAMPLE_LIMIT),
    dryRun: process.argv.includes('--dry-run'),
  });

  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('media event_at repair failed:', err);
    process.exit(1);
  });
}
