import { pathToFileURL } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';
import { prepareAllRowMaintenance } from './lib/maintenance-db.js';

dotenv.config();

export interface ValidityBackfillClient {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface ValidityBackfillOptions {
  batchSize: number;
  maxBatches: number;
  log?: (message: string) => void;
}

export interface ValidityBackfillResult {
  updated: number;
  batches: number;
  pending: number;
}

type PreflightRow = {
  missingCreatedAt: string;
  invalidInterval: string;
  conflictingLifecycle: string;
  linkedBoundaryMissing: string;
};

/** Bounded, idempotent, and resumable. Every UPDATE is its own transaction. */
export async function backfillMemoryValidity(
  client: ValidityBackfillClient,
  options: ValidityBackfillOptions,
): Promise<ValidityBackfillResult> {
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 10_000) {
    throw new Error('MEMORY_VALIDITY_BATCH_SIZE must be an integer from 1 to 10000');
  }
  if (!Number.isSafeInteger(options.maxBatches) || options.maxBatches < 1 || options.maxBatches > 100_000) {
    throw new Error('MEMORY_VALIDITY_MAX_BATCHES must be an integer from 1 to 100000');
  }

  const preflight = await client.query<PreflightRow>(`
    SELECT
      count(*) FILTER (WHERE m.created_at IS NULL)::text AS "missingCreatedAt",
      count(*) FILTER (
        WHERE COALESCE(m.valid_to, m.superseded_at) IS NOT NULL
          AND COALESCE(m.valid_to, m.superseded_at) <= CASE
            WHEN m.supersedes_id IS NOT NULL THEN predecessor.superseded_at
            ELSE COALESCE(m.valid_from, m.created_at)
          END
      )::text AS "invalidInterval",
      count(*) FILTER (
        WHERE m.valid_to IS NOT NULL
          AND m.valid_to IS DISTINCT FROM m.superseded_at
      )::text AS "conflictingLifecycle",
      count(*) FILTER (
        WHERE m.supersedes_id IS NOT NULL
          AND predecessor.superseded_at IS NULL
      )::text AS "linkedBoundaryMissing"
    FROM public.memories m
    LEFT JOIN public.memories predecessor ON predecessor.id = m.supersedes_id
  `);
  const state = preflight.rows[0];
  const inconsistencies = Number(state?.missingCreatedAt ?? 0) +
    Number(state?.invalidInterval ?? 0) + Number(state?.conflictingLifecycle ?? 0) +
    Number(state?.linkedBoundaryMissing ?? 0);
  options.log?.(
    `Validity preflight: missing_created_at=${state?.missingCreatedAt ?? '0'} ` +
    `invalid_interval=${state?.invalidInterval ?? '0'} ` +
    `conflicting_lifecycle=${state?.conflictingLifecycle ?? '0'} ` +
    `linked_boundary_missing=${state?.linkedBoundaryMissing ?? '0'}`,
  );
  if (inconsistencies > 0) {
    throw new Error('Memory validity preflight found inconsistent lifecycle data; no rows were changed');
  }

  let updated = 0;
  let batches = 0;
  while (batches < options.maxBatches) {
    const result = await client.query<{ id: string }>(`
      WITH batch AS (
        SELECT m.id, predecessor.superseded_at AS predecessor_boundary
        FROM public.memories m
        LEFT JOIN public.memories predecessor ON predecessor.id = m.supersedes_id
        WHERE m.valid_from IS NULL
           OR m.valid_to IS DISTINCT FROM m.superseded_at
           OR (m.supersedes_id IS NOT NULL
               AND m.valid_from IS DISTINCT FROM predecessor.superseded_at)
        ORDER BY m.id
        LIMIT $1
        FOR UPDATE OF m SKIP LOCKED
      )
      UPDATE public.memories m
      SET valid_from = CASE
            WHEN m.supersedes_id IS NOT NULL THEN batch.predecessor_boundary
            ELSE COALESCE(m.valid_from, m.created_at)
          END,
          valid_to = m.superseded_at
      FROM batch
      WHERE m.id = batch.id
      RETURNING m.id
    `, [options.batchSize]);
    const count = result.rows.length;
    if (count === 0) break;
    batches += 1;
    updated += count;
    options.log?.(`Validity backfill batch ${batches}: updated=${count} total=${updated}`);
  }

  const remaining = await client.query<{ pending: string }>(`
    SELECT count(*)::text AS pending
    FROM public.memories m
    LEFT JOIN public.memories predecessor ON predecessor.id = m.supersedes_id
    WHERE m.valid_from IS NULL
       OR m.valid_to IS DISTINCT FROM m.superseded_at
       OR (m.supersedes_id IS NOT NULL
           AND m.valid_from IS DISTINCT FROM predecessor.superseded_at)
  `);
  const pending = Number(remaining.rows[0]?.pending ?? 0);
  options.log?.(`Validity backfill complete: updated=${updated} batches=${batches} pending=${pending}`);
  return { updated, batches, pending };
}

function parseBounded(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

async function main(): Promise<void> {
  const connectionString = process.env.MIGRATION_DATABASE_URL?.trim();
  if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required for validity backfill');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await prepareAllRowMaintenance(client);
    const result = await backfillMemoryValidity(client, {
      batchSize: parseBounded(process.env.MEMORY_VALIDITY_BATCH_SIZE, 1000, 1, 10_000, 'MEMORY_VALIDITY_BATCH_SIZE'),
      maxBatches: parseBounded(process.env.MEMORY_VALIDITY_MAX_BATCHES, 100, 1, 100_000, 'MEMORY_VALIDITY_MAX_BATCHES'),
      log: console.log,
    });
    if (result.pending > 0) {
      throw new Error(`${result.pending} rows remain; rerun the bounded backfill before finalization`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Memory validity backfill failed:', error);
    process.exitCode = 1;
  });
}
