import { pathToFileURL } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';
import { embed as productionEmbed } from '../src/embedding.js';
import {
  buildMetadata,
  buildSummary,
  buildTags,
  createMediaDateFormatter,
  resolveMediaTimeZone,
} from '../src/rollup.js';
import type { MediaEvent } from '../src/media.js';

dotenv.config();

export interface RepairMediaRollupDatesOptions {
  connectionString: string;
  timeZone?: string;
  apply?: boolean;
  batchSize?: number;
  afterPlayedAt?: Date | string;
  afterId?: string;
  service?: string;
  playedAfter?: Date | string;
  playedBefore?: Date | string;
  embed?: (content: string) => Promise<number[]>;
}

export interface RepairCheckpoint {
  playedAt: string;
  id: string;
}

export interface RepairMediaRollupDatesResult {
  dryRun: boolean;
  scanned: number;
  wouldChange: number;
  updated: number;
  unchanged: number;
  skippedConcurrent: number;
  failed: number;
  errors: string[];
  checkpoint: RepairCheckpoint | null;
}

type Candidate = MediaEvent & {
  memory_id: string;
  memory_content: string;
  memory_source: string;
  memory_tags: string[];
  memory_metadata: Record<string, unknown>;
  memory_updated_at: Date;
};

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1000;
const MAX_REPORTED_ERRORS = 1;

export async function repairMediaRollupDates(
  options: RepairMediaRollupDatesOptions
): Promise<RepairMediaRollupDatesResult> {
  const batchSize = boundedInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize', 1, MAX_BATCH_SIZE);
  if ((options.afterPlayedAt === undefined) !== (options.afterId === undefined)) {
    throw new Error('--after-played-at and --after-id must be supplied together');
  }

  const formatter = createMediaDateFormatter(resolveMediaTimeZone(options.timeZone ?? process.env.MEDIA_TIME_ZONE));
  const embed = options.embed ?? productionEmbed;
  const client = new pg.Client({ connectionString: options.connectionString });
  const result: RepairMediaRollupDatesResult = {
    dryRun: options.apply !== true,
    scanned: 0,
    wouldChange: 0,
    updated: 0,
    unchanged: 0,
    skippedConcurrent: 0,
    failed: 0,
    errors: [],
    checkpoint: options.afterPlayedAt === undefined ? null : {
      playedAt: validDate(options.afterPlayedAt, 'afterPlayedAt').toISOString(),
      id: options.afterId!,
    },
  };

  let afterPlayedAt = options.afterPlayedAt === undefined ? null : validDate(options.afterPlayedAt, 'afterPlayedAt');
  let afterId = options.afterId ?? null;
  await client.connect();
  try {
    scan: while (true) {
      const rows = await loadCandidates(client, {
        batchSize,
        afterPlayedAt,
        afterId,
        service: options.service,
        playedAfter: options.playedAfter === undefined ? null : validDate(options.playedAfter, 'playedAfter'),
        playedBefore: options.playedBefore === undefined ? null : validDate(options.playedBefore, 'playedBefore'),
      });
      if (rows.length === 0) break;

      for (const row of rows) {
        result.scanned++;
        try {
          const rowPlayedAt = validDate(row.played_at, 'played_at');
          const content = buildSummary(row, formatter);
          if (content === row.memory_content) {
            result.unchanged++;
          } else {
            result.wouldChange++;
            if (!result.dryRun) {
              const vector = await embed(content);
              const outcome = await applyIfUnchanged(
                client,
                row,
                content,
                vector,
                buildTags(row),
                buildMetadata(row)
              );
              if (outcome === 'updated') {
                result.updated++;
              } else {
                result.skippedConcurrent++;
                break scan;
              }
            }
          }
          afterPlayedAt = rowPlayedAt;
          afterId = row.id;
          result.checkpoint = { playedAt: rowPlayedAt.toISOString(), id: row.id };
        } catch (error) {
          result.failed++;
          if (result.errors.length < MAX_REPORTED_ERRORS) {
            result.errors.push(`event ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
          break scan;
        }
      }
    }
    return result;
  } finally {
    await client.end();
  }
}

interface CandidatePage {
  batchSize: number;
  afterPlayedAt: Date | null;
  afterId: string | null;
  service?: string;
  playedAfter: Date | null;
  playedBefore: Date | null;
}

async function loadCandidates(client: pg.Client, page: CandidatePage): Promise<Candidate[]> {
  await client.query('BEGIN');
  try {
    await setMediaAdminScope(client);
    const response = await client.query<Candidate>(
      `SELECT e.*,
              m.content AS memory_content,
              m.source AS memory_source,
              m.tags AS memory_tags,
              m.metadata AS memory_metadata,
              m.updated_at AS memory_updated_at
         FROM media_events e
         JOIN memories m ON m.id = e.memory_id
        WHERE m.namespace = 'media'
          AND m.source = 'media:' || e.service
          AND ($1::timestamptz IS NULL OR (e.played_at, e.id) > ($1::timestamptz, $2::uuid))
          AND ($3::text IS NULL OR e.service = $3)
          AND ($4::timestamptz IS NULL OR e.played_at >= $4)
          AND ($5::timestamptz IS NULL OR e.played_at <= $5)
        ORDER BY e.played_at, e.id
        LIMIT $6`,
      [page.afterPlayedAt, page.afterId, page.service ?? null, page.playedAfter, page.playedBefore, page.batchSize]
    );
    await client.query('COMMIT');
    return response.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function applyIfUnchanged(
  client: pg.Client,
  captured: Candidate,
  content: string,
  vector: number[],
  tags: string[],
  metadata: Record<string, unknown>
): Promise<'updated' | 'concurrent'> {
  await client.query('BEGIN');
  try {
    await setMediaAdminScope(client);
    const locked = await client.query<Candidate>(
      `SELECT e.*,
              m.content AS memory_content,
              m.source AS memory_source,
              m.tags AS memory_tags,
              m.metadata AS memory_metadata,
              m.updated_at AS memory_updated_at
         FROM media_events e
         JOIN memories m ON m.id = e.memory_id
        WHERE e.id = $1
          AND m.id = $2
          AND m.namespace = 'media'
          AND m.source = 'media:' || e.service
        FOR UPDATE OF m`,
      [captured.id, captured.memory_id]
    );
    const current = locked.rows[0];
    if (!current || fingerprint(current) !== fingerprint(captured)) {
      await client.query('ROLLBACK');
      return 'concurrent';
    }

    await client.query(
      `UPDATE memories
          SET content = $1,
              embedding = $2::vector,
              tags = $3,
              metadata = $4,
              updated_at = NOW()
        WHERE id = $5`,
      [content, `[${vector.join(',')}]`, tags, JSON.stringify(metadata), captured.memory_id]
    );
    await client.query('COMMIT');
    return 'updated';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function setMediaAdminScope(client: pg.Client): Promise<void> {
  await client.query("SELECT set_config('app.allowed_namespaces', $1, true)", [JSON.stringify(['media'])]);
  await client.query("SELECT set_config('app.current_key_id', '', true)");
  await client.query("SELECT set_config('app.current_key_is_admin', 'true', true)");
}

function fingerprint(row: Candidate): string {
  const fields = {
    event: {
      id: row.id, service: row.service, service_id: row.service_id, event_type: row.event_type,
      title: row.title, artist: row.artist, album: row.album, show: row.show, season: row.season,
      episode: row.episode, year: row.year, genres: row.genres, duration_ms: row.duration_ms,
      played_ms: row.played_ms, completed: row.completed, played_at: validDate(row.played_at, 'played_at').toISOString(),
      metadata: row.metadata, client_id: row.client_id, agent_id: row.agent_id, memory_id: row.memory_id,
    },
    memory: {
      id: row.memory_id, content: row.memory_content, source: row.memory_source,
      tags: row.memory_tags, metadata: row.memory_metadata,
      updated_at: validDate(row.memory_updated_at, 'memory_updated_at').toISOString(),
    },
  };
  return JSON.stringify(fields);
}

function validDate(value: Date | string, name: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${name}: ${String(value)}`);
  return date;
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const batchSize = flag('--batch-size');
  const output = await repairMediaRollupDates({
    connectionString: process.env.DATABASE_URL,
    timeZone: process.env.MEDIA_TIME_ZONE,
    apply: process.argv.includes('--apply'),
    batchSize: batchSize === undefined ? undefined : Number.parseInt(batchSize, 10),
    afterPlayedAt: flag('--after-played-at'),
    afterId: flag('--after-id'),
    service: flag('--service'),
    playedAfter: flag('--played-after'),
    playedBefore: flag('--played-before'),
  });
  console.log(JSON.stringify(output));
  if (output.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('media rollup date repair failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
