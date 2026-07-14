import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const DEFAULT_MAX_ROWS = 500;
const MAX_ROWS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SpotifyProgressApproval {
  id: string;
  clientId: string;
  fingerprint: string;
}

export interface RepairSpotifyProgressOptions {
  connectionString: string;
  maxRows?: number;
  playedAfter?: Date | string;
  playedBefore?: Date | string;
  apply?: boolean;
  confirmBackup?: boolean;
  approvals?: SpotifyProgressApproval[];
}

export interface SpotifyProgressCandidate extends SpotifyProgressApproval {
  playedAt: string;
  durationMs: number;
  memoryId: string | null;
}

export interface SpotifyProgressOutcome {
  id: string;
  status: 'updated' | 'already-repaired';
  memory: 'updated' | 'unchanged' | 'missing-or-unrelated';
}

export interface RepairSpotifyProgressResult {
  dryRun: boolean;
  totalCandidates: number;
  truncated: boolean;
  candidates: SpotifyProgressCandidate[];
  updatedEvents: number;
  updatedMemories: number;
  outcomes: SpotifyProgressOutcome[];
  nextCheckpoint: string | null;
  warning: string;
}

interface CandidateRow {
  id: string;
  client_id: string;
  played_at: Date;
  duration_ms: number;
  played_ms: number;
  completed: boolean;
  memory_id: string | null;
}

export async function repairSpotifyProgress(
  options: RepairSpotifyProgressOptions,
): Promise<RepairSpotifyProgressResult> {
  const pool = new pg.Pool({ connectionString: options.connectionString, max: 1 });
  try {
    if (options.apply === true) {
      return await applyApprovals(pool, options);
    }
    const maxRows = boundedInteger(options.maxRows ?? DEFAULT_MAX_ROWS, 'maxRows', 1, MAX_ROWS);
    return await previewCandidates(pool, options, maxRows);
  } finally {
    await pool.end();
  }
}

async function previewCandidates(
  pool: pg.Pool,
  options: RepairSpotifyProgressOptions,
  maxRows: number,
): Promise<RepairSpotifyProgressResult> {
  const candidates: SpotifyProgressCandidate[] = [];
  let totalCandidates = 0;
  const keys = await pool.query<{ id: string }>('SELECT id::text AS id FROM api_keys ORDER BY id');
  for (const { id: clientId } of keys.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setScope(client, clientId);
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM media_events
         WHERE client_id = $1::uuid AND service = 'spotify' AND completed IS TRUE
           AND duration_ms > 0 AND played_ms = duration_ms
           AND ($2::timestamptz IS NULL OR played_at >= $2::timestamptz)
           AND ($3::timestamptz IS NULL OR played_at <= $3::timestamptz)`,
        [clientId, options.playedAfter ?? null, options.playedBefore ?? null],
      );
      totalCandidates += Number.parseInt(count.rows[0]?.count ?? '0', 10);
      const remaining = maxRows - candidates.length;
      if (remaining > 0) {
        const page = await client.query<CandidateRow>(
          `SELECT id::text, client_id::text, played_at, duration_ms, played_ms, completed, memory_id::text
           FROM media_events
           WHERE client_id = $1::uuid AND service = 'spotify' AND completed IS TRUE
             AND duration_ms > 0 AND played_ms = duration_ms
             AND ($2::timestamptz IS NULL OR played_at >= $2::timestamptz)
             AND ($3::timestamptz IS NULL OR played_at <= $3::timestamptz)
           ORDER BY played_at, id LIMIT $4`,
          [clientId, options.playedAfter ?? null, options.playedBefore ?? null, remaining],
        );
        candidates.push(...page.rows.map(toCandidate));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return resultBase(true, totalCandidates, candidates, []);
}

async function applyApprovals(
  pool: pg.Pool,
  options: RepairSpotifyProgressOptions,
): Promise<RepairSpotifyProgressResult> {
  if (options.confirmBackup !== true) {
    throw new Error('Apply requires acknowledgement of a verified restorable backup (--confirm-backup)');
  }
  const approvals = options.approvals ?? [];
  if (approvals.length === 0) {
    throw new Error('Apply requires an explicit approval manifest containing exact event IDs and fingerprints');
  }
  const seen = new Set<string>();
  for (const approval of approvals) {
    validateApproval(approval);
    const key = `${approval.clientId}:${approval.id}`;
    if (seen.has(key)) throw new Error(`Duplicate approved event ID: ${approval.id}`);
    seen.add(key);
  }

  const outcomes: SpotifyProgressOutcome[] = [];
  let updatedEvents = 0;
  let updatedMemories = 0;
  for (const approval of approvals) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setScope(client, approval.clientId);
      const selected = await client.query<CandidateRow>(
        `SELECT id::text, client_id::text, played_at, duration_ms, played_ms, completed, memory_id::text
         FROM media_events WHERE id = $1::uuid AND client_id = $2::uuid AND service = 'spotify'
         FOR UPDATE`,
        [approval.id, approval.clientId],
      );
      const row = selected.rows[0];
      if (!row || row.duration_ms === null || row.duration_ms <= 0) {
        throw new Error(`Approved ID ${approval.id} is missing or nonmatching`);
      }
      const expectedOriginal = toCandidate({ ...row, played_ms: row.duration_ms, completed: true });
      if (expectedOriginal.fingerprint !== approval.fingerprint) {
        throw new Error(`State drift for approved ID ${approval.id}; preview and independently verify it again`);
      }

      let status: SpotifyProgressOutcome['status'];
      if (row.played_ms === null && row.completed === null) {
        status = 'already-repaired';
      } else {
        if (row.completed !== true || row.played_ms !== row.duration_ms) {
          throw new Error(`Approved ID ${approval.id} is unapproved, drifted, or no longer matches the repair predicate`);
        }
        await client.query(
          `UPDATE media_events SET played_ms = NULL, completed = NULL
           WHERE id = $1::uuid AND client_id = $2::uuid`,
          [approval.id, approval.clientId],
        );
        updatedEvents += 1;
        status = 'updated';
      }

      let memory: SpotifyProgressOutcome['memory'] = 'missing-or-unrelated';
      if (row.memory_id) {
        const updated = await client.query(
          `UPDATE memories
           SET metadata = metadata - 'played_ms' - 'completed',
               tags = ARRAY(SELECT tag FROM unnest(tags) AS tag WHERE tag <> 'completed'),
               updated_at = NOW()
           WHERE id = $1::uuid AND deleted_at IS NULL AND superseded_at IS NULL
             AND namespace = 'media' AND client_id = $2
             AND source = 'media:spotify'
             AND ((metadata ? 'played_ms') OR (metadata ? 'completed') OR 'completed' = ANY(tags))`,
          [row.memory_id, approval.clientId],
        );
        if ((updated.rowCount ?? 0) === 1) {
          updatedMemories += 1;
          memory = 'updated';
        } else {
          const linked = await client.query(
            `SELECT 1 FROM memories WHERE id = $1::uuid AND deleted_at IS NULL AND superseded_at IS NULL
             AND namespace = 'media' AND client_id = $2 AND source = 'media:spotify'`,
            [row.memory_id, approval.clientId],
          );
          memory = linked.rowCount === 1 ? 'unchanged' : 'missing-or-unrelated';
        }
      }
      outcomes.push({ id: approval.id, status, memory });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const detail = error instanceof Error ? error.message : String(error);
      const checkpoint = outcomes.at(-1)?.id ?? 'none';
      throw new Error(`${detail}. Partial failure; resumable checkpoint: ${checkpoint}`);
    } finally {
      client.release();
    }
  }

  const result = resultBase(false, approvals.length, [], outcomes);
  result.updatedEvents = updatedEvents;
  result.updatedMemories = updatedMemories;
  result.nextCheckpoint = outcomes.at(-1)?.id ?? null;
  return result;
}

function resultBase(
  dryRun: boolean,
  totalCandidates: number,
  candidates: SpotifyProgressCandidate[],
  outcomes: SpotifyProgressOutcome[],
): RepairSpotifyProgressResult {
  return {
    dryRun,
    totalCandidates,
    truncated: totalCandidates > candidates.length && dryRun,
    candidates,
    updatedEvents: 0,
    updatedMemories: 0,
    outcomes,
    nextCheckpoint: null,
    warning: 'Candidate provenance is ambiguous. Apply only event IDs independently verified as affected Spotify connector ingests.',
  };
}

function validateApproval(approval: SpotifyProgressApproval): void {
  if (!UUID_PATTERN.test(approval.id) || !UUID_PATTERN.test(approval.clientId) || !/^[a-f0-9]{64}$/.test(approval.fingerprint)) {
    throw new Error('Every approval must contain an exact event UUID, client UUID, and preview fingerprint');
  }
}

function toCandidate(row: CandidateRow): SpotifyProgressCandidate {
  const playedAt = new Date(row.played_at).toISOString();
  const memoryId = row.memory_id ?? null;
  return {
    id: row.id,
    clientId: row.client_id,
    playedAt,
    durationMs: row.duration_ms,
    memoryId,
    fingerprint: fingerprint({
      id: row.id,
      clientId: row.client_id,
      playedAt,
      durationMs: row.duration_ms,
      playedMs: row.played_ms,
      completed: row.completed,
      memoryId,
    }),
  };
}

function fingerprint(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function setScope(client: pg.PoolClient, clientId: string): Promise<void> {
  await client.query("SELECT set_config('app.allowed_namespaces', $1, true)", [JSON.stringify(['media'])]);
  await client.query("SELECT set_config('app.current_key_id', $1, true)", [clientId]);
  await client.query("SELECT set_config('app.current_key_is_admin', 'false', true)");
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function readFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const apply = process.argv.includes('--apply');
  const manifestPath = readFlag('--approval-manifest');
  const approvals = manifestPath
    ? JSON.parse(await readFile(manifestPath, 'utf8')) as SpotifyProgressApproval[]
    : undefined;
  const result = await repairSpotifyProgress({
    connectionString,
    maxRows: Number.parseInt(readFlag('--max-rows') ?? String(DEFAULT_MAX_ROWS), 10),
    playedAfter: readFlag('--played-after'),
    playedBefore: readFlag('--played-before'),
    apply,
    confirmBackup: process.argv.includes('--confirm-backup'),
    approvals,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Spotify progress repair failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
