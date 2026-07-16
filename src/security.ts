import type { PoolClient } from 'pg';
import { getPool } from './db.js';
import type { AuthContext, RateLimitResult } from './types.js';

export class RateLimitExceededError extends Error {
  readonly code = 'rate_limit_exceeded';
  readonly result: RateLimitResult;

  constructor(result: RateLimitResult) {
    super('Rate limit exceeded');
    this.name = 'RateLimitExceededError';
    this.result = result;
  }
}

export class RateLimitUnavailableError extends Error {
  readonly code = 'rate_limit_unavailable';

  constructor(cause?: unknown) {
    super('Rate limit service unavailable', cause === undefined ? undefined : { cause });
    this.name = 'RateLimitUnavailableError';
  }
}

type UsageRow = {
  now: Date;
  minute_start: Date;
  day_start: string | Date;
  minute_count: number | string;
  day_count: number | string;
};

/**
 * Atomically charge one logical operation to both fixed UTC windows. The key
 * advisory lock makes the check-and-increment exact across processes; a denied
 * operation increments neither counter.
 */
export async function consumeRateLimit(
  auth: Pick<AuthContext, 'keyId' | 'requestsPerMinute' | 'requestsPerDay'>,
  options: { now?: Date; client?: PoolClient } = {},
): Promise<RateLimitResult> {
  const rpm = auth.requestsPerMinute ?? null;
  const daily = auth.requestsPerDay ?? null;
  if (rpm === null && daily === null) return unlimitedResult();

  if (options.client) return consumeOnClient(options.client, auth.keyId, rpm, daily, options.now);

  const client = await getPool().connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    const result = await consumeOnClient(client, auth.keyId, rpm, daily, options.now);
    await client.query('COMMIT');
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the primary failure */ }
    }
    if (error instanceof RateLimitExceededError) throw error;
    throw new RateLimitUnavailableError(error);
  } finally {
    client.release();
  }
}

async function consumeOnClient(
  client: PoolClient,
  keyId: string,
  rpm: number | null,
  daily: number | null,
  now?: Date,
): Promise<RateLimitResult> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`api-key-quota:${keyId}`]);
  const state = await client.query<UsageRow>(
    `WITH bounds AS (
       SELECT COALESCE($2::timestamptz, statement_timestamp()) AS now
     )
     SELECT b.now,
            (date_trunc('minute', b.now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS minute_start,
            (b.now AT TIME ZONE 'UTC')::date AS day_start,
            COALESCE((SELECT request_count FROM api_key_minute_usage
                      WHERE api_key_id = $1::uuid
                        AND window_start = (date_trunc('minute', b.now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')), 0) AS minute_count,
            COALESCE((SELECT request_count FROM api_key_daily_usage
                      WHERE api_key_id = $1::uuid AND window_start = (b.now AT TIME ZONE 'UTC')::date), 0) AS day_count
     FROM bounds b`,
    [keyId, now ?? null],
  );
  const row = state.rows[0];
  if (!row) throw new Error('Quota state query returned no row');

  const minuteCount = Number(row.minute_count);
  const dayCount = Number(row.day_count);
  const minuteDenied = rpm !== null && minuteCount >= rpm;
  const dayDenied = daily !== null && dayCount >= daily;
  const result = quotaResult(row, rpm, daily, minuteCount, dayCount, !minuteDenied && !dayDenied);
  if (!result.allowed) throw new RateLimitExceededError(result);

  if (rpm !== null) {
    await client.query(
      `INSERT INTO api_key_minute_usage (api_key_id, window_start, request_count)
       VALUES ($1::uuid, $2, 1)
       ON CONFLICT (api_key_id, window_start)
       DO UPDATE SET request_count = api_key_minute_usage.request_count + 1`,
      [keyId, row.minute_start],
    );
  }
  if (daily !== null) {
    await client.query(
      `INSERT INTO api_key_daily_usage (api_key_id, window_start, request_count)
       VALUES ($1::uuid, $2, 1)
       ON CONFLICT (api_key_id, window_start)
       DO UPDATE SET request_count = api_key_daily_usage.request_count + 1`,
      [keyId, row.day_start],
    );
  }
  return result;
}

function quotaResult(
  row: UsageRow,
  rpm: number | null,
  daily: number | null,
  minuteCount: number,
  dayCount: number,
  allowed: boolean,
): RateLimitResult {
  const nowMs = new Date(row.now).getTime();
  const minuteResetAt = new Date(new Date(row.minute_start).getTime() + 60_000);
  const dayString = typeof row.day_start === 'string'
    ? row.day_start.slice(0, 10)
    : new Date(row.day_start).toISOString().slice(0, 10);
  const dayResetAt = new Date(`${dayString}T00:00:00.000Z`);
  dayResetAt.setUTCDate(dayResetAt.getUTCDate() + 1);
  return {
    allowed,
    minute: rpm === null ? null : {
      limit: rpm,
      remaining: Math.max(0, rpm - minuteCount - (allowed ? 1 : 0)),
      resetAt: minuteResetAt,
    },
    day: daily === null ? null : {
      limit: daily,
      remaining: Math.max(0, daily - dayCount - (allowed ? 1 : 0)),
      resetAt: dayResetAt,
    },
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(Math.max(
      rpm !== null && minuteCount >= rpm ? minuteResetAt.getTime() - nowMs : 0,
      daily !== null && dayCount >= daily ? dayResetAt.getTime() - nowMs : 0,
    ) / 1000)),
  };
}

function unlimitedResult(): RateLimitResult {
  return { allowed: true, minute: null, day: null, retryAfterSeconds: 0 };
}

/** Delete closed windows while retaining a bounded operational history. */
export function rateLimitRetentionDaysFromEnv(value = process.env.RATE_LIMIT_USAGE_RETENTION_DAYS): number {
  if (value === undefined || value === '') return 7;
  if (!/^\d+$/.test(value)) throw new Error('RATE_LIMIT_USAGE_RETENTION_DAYS must be a positive integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 3650) {
    throw new Error('RATE_LIMIT_USAGE_RETENTION_DAYS must be an integer from 1 to 3650');
  }
  return parsed;
}

export async function cleanupRateLimitUsage(retentionDays = rateLimitRetentionDaysFromEnv()): Promise<void> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('retentionDays must be a positive integer');
  await getPool().query(
    `WITH minute_cleanup AS (
       DELETE FROM api_key_minute_usage WHERE window_start < NOW() - $1::int * interval '1 day'
     )
     DELETE FROM api_key_daily_usage WHERE window_start < (NOW() AT TIME ZONE 'UTC')::date - $1::int`,
    [retentionDays],
  );
}
