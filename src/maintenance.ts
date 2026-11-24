export interface MaintenanceQueryClient {
  query<T = any>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface TtlPurgeSummary {
  count: number;
  batches: number;
  byNamespace: Record<string, number>;
}

export interface DecaySummary {
  count: number;
  byNamespace: Record<string, number>;
  min?: string;
  max?: string;
  median?: string;
  avg?: string;
}

export const DEFAULT_TTL_PURGE_BATCH_SIZE = 1_000;
export const MAX_TTL_PURGE_BATCH_SIZE = 100_000;

export function ttlPurgeBatchSizeFromEnv(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TTL_PURGE_BATCH_SIZE;
  if (!/^\d+$/.test(value)) {
    throw new Error(`TTL_PURGE_BATCH_SIZE must be an integer between 1 and ${MAX_TTL_PURGE_BATCH_SIZE}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TTL_PURGE_BATCH_SIZE) {
    throw new Error(`TTL_PURGE_BATCH_SIZE must be an integer between 1 and ${MAX_TTL_PURGE_BATCH_SIZE}`);
  }
  return parsed;
}

/**
 * Hard-delete logically expired memories in committed, overlap-safe batches.
 * Each batch writes one aggregate, content-free audit event in the same SQL
 * statement as the deletion.
 */
export async function purgeExpiredMemories(
  client: MaintenanceQueryClient,
  batchSize = DEFAULT_TTL_PURGE_BATCH_SIZE,
): Promise<TtlPurgeSummary> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_TTL_PURGE_BATCH_SIZE) {
    throw new Error(`TTL purge batch size must be an integer between 1 and ${MAX_TTL_PURGE_BATCH_SIZE}`);
  }

  const byNamespace: Record<string, number> = {};
  let count = 0;
  let batches = 0;
  while (true) {
    const result = await client.query<{ namespace: string; count: string | number; batch_count: string | number }>(`
      WITH candidates AS MATERIALIZED (
        SELECT id
        FROM public.memories
        WHERE expires_at IS NOT NULL AND expires_at <= statement_timestamp()
        ORDER BY expires_at, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      ), deleted AS (
        DELETE FROM public.memories m
        USING candidates c
        WHERE m.id = c.id
          AND m.expires_at IS NOT NULL
          AND m.expires_at <= statement_timestamp()
        RETURNING m.namespace
      ), namespace_counts AS MATERIALIZED (
        SELECT namespace, count(*)::text AS count FROM deleted GROUP BY namespace
      ), total AS MATERIALIZED (
        SELECT count(*)::int AS count FROM deleted
      ), audited AS (
        INSERT INTO public.audit_log (client_id, action, result_count)
        SELECT 'system:maintenance', 'ttl_purge', count FROM total WHERE count > 0
        RETURNING result_count
      )
      SELECT namespace_counts.namespace, namespace_counts.count,
             audited.result_count::text AS batch_count
      FROM namespace_counts CROSS JOIN audited
      ORDER BY namespace_counts.namespace
    `, [batchSize]);

    if (result.rows.length === 0) break;
    const batchCount = Number(result.rows[0].batch_count);
    if (!Number.isSafeInteger(batchCount) || batchCount < 1 || batchCount > batchSize) {
      throw new Error('TTL purge returned an invalid batch count');
    }
    batches += 1;
    count += batchCount;
    for (const row of result.rows) {
      const namespaceCount = Number(row.count);
      byNamespace[row.namespace] = (byNamespace[row.namespace] ?? 0) + namespaceCount;
    }
  }

  return {
    count,
    batches,
    byNamespace: Object.fromEntries(Object.entries(byNamespace).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export async function updateDecayWithClient(client: MaintenanceQueryClient): Promise<DecaySummary> {
  const res = await client.query<{
    maintenance_ready: boolean;
    namespace: string | null;
    relevance_score: number | null;
  }>(`
    WITH maintenance AS MATERIALIZED (
      SELECT NOT EXISTS (
        SELECT 1 FROM public.memories
        WHERE deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > statement_timestamp())
          AND to_jsonb(memories)->>'consolidated_into_id' IS NULL
          AND relevance_base_score IS NULL
      ) AS ready
    ), updated AS (
      UPDATE public.memories
      SET relevance_score = public.calculate_relevance(relevance_base_score, decay_rate, accessed_at, access_count),
          updated_at = NOW()
      WHERE (SELECT ready FROM maintenance)
        AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > statement_timestamp())
        AND to_jsonb(memories)->>'consolidated_into_id' IS NULL
      RETURNING namespace, relevance_score
    )
    SELECT maintenance.ready AS maintenance_ready, updated.namespace, updated.relevance_score
    FROM maintenance
    LEFT JOIN updated ON TRUE
  `);

  if (res.rows[0]?.maintenance_ready === false) {
    throw new Error('Decay aborted: at least one memory has an unclassified relevance base');
  }

  const changed = res.rows.filter(
    (row): row is typeof row & { namespace: string; relevance_score: number } =>
      row.namespace !== null && row.relevance_score !== null,
  );
  const byNamespace: Record<string, number> = {};
  for (const row of changed) byNamespace[row.namespace] = (byNamespace[row.namespace] ?? 0) + 1;
  const sortedByNamespace = Object.fromEntries(Object.entries(byNamespace).sort(([a], [b]) => a.localeCompare(b)));
  const scores = changed.map(row => Number(row.relevance_score)).sort((a, b) => a - b);
  if (scores.length === 0) return { count: 0, byNamespace: sortedByNamespace };

  return {
    count: scores.length,
    byNamespace: sortedByNamespace,
    min: scores[0].toFixed(4),
    max: scores[scores.length - 1].toFixed(4),
    median: scores[Math.floor(scores.length / 2)].toFixed(4),
    avg: (scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(4),
  };
}


export interface BoundedDecayOptions {
  asOf: string;
  afterId?: string | null;
  limit: number;
  apply: boolean;
}

export interface BoundedDecaySummary extends DecaySummary {
  selected: number;
  updated: number;
  nextCursor: string | null;
  asOf: string;
  dryRun: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateBoundedDecayOptions(options: BoundedDecayOptions): BoundedDecayOptions {
  const asOf = new Date(options.asOf);
  if (!Number.isFinite(asOf.getTime()) || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(options.asOf) || asOf.getTime() > Date.now()) {
    throw new Error('Bounded decay requires an explicit non-future UTC --as-of timestamp');
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
    throw new Error('Bounded decay limit must be an integer from 1 to 1000');
  }
  if (options.afterId && !UUID_PATTERN.test(options.afterId)) throw new Error('Bounded decay cursor must be a UUID');
  return { ...options, asOf: asOf.toISOString(), afterId: options.afterId ?? null };
}

/** Materialize one stable UUID page at an explicit instant. Never deletes rows. */
export async function updateDecayBatchWithClient(
  client: MaintenanceQueryClient,
  rawOptions: BoundedDecayOptions,
): Promise<BoundedDecaySummary> {
  const options = validateBoundedDecayOptions(rawOptions);
  const lockClause = options.apply ? 'FOR UPDATE SKIP LOCKED' : '';
  const mutation = options.apply ? `, updated AS (
      UPDATE public.memories m SET relevance_score = c.computed_score, updated_at = statement_timestamp()
      FROM computed c
      WHERE m.id = c.id AND m.relevance_base_score IS NOT NULL
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
    )` : '';
  const result = await client.query<{
    id: string; namespace: string; computed_score: number; changed: boolean;
  }>(`
    WITH candidates AS MATERIALIZED (
      SELECT id, namespace, relevance_base_score, decay_rate, accessed_at, access_count,
             relevance_score, updated_at
      FROM public.memories
      WHERE relevance_base_score IS NOT NULL AND id > COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > $1::timestamptz)
        AND (expires_at IS NULL OR expires_at > statement_timestamp())
        AND superseded_at IS NULL AND valid_to IS NULL
        AND (valid_from IS NULL OR valid_from <= $1::timestamptz)
        AND (valid_from IS NULL OR valid_from <= statement_timestamp())
        AND consolidated_into_id IS NULL
      ORDER BY id LIMIT $3
      ${lockClause}
    ), computed AS MATERIALIZED (
      SELECT c.*,
        c.relevance_base_score * EXP(-COALESCE(c.decay_rate, 0.01) * GREATEST(0.0,
          EXTRACT(EPOCH FROM ($1::timestamptz - COALESCE(c.accessed_at, $1::timestamptz))) / 86400.0))
        + LEAST(GREATEST(COALESCE(c.access_count, 0) * 0.1, 0.0), 1.0) AS computed_score
      FROM candidates c
    )${mutation}
    SELECT c.id, c.namespace, c.computed_score,
      ${options.apply ? 'EXISTS (SELECT 1 FROM updated u WHERE u.id = c.id)' : 'c.relevance_score IS DISTINCT FROM c.computed_score'} AS changed
    FROM computed c ORDER BY c.id
  `, [options.asOf, options.afterId, options.limit]);
  const byNamespace: Record<string, number> = {};
  const scores: number[] = [];
  let updated = 0;
  for (const row of result.rows) {
    scores.push(Number(row.computed_score));
    if (row.changed) {
      updated += 1;
      byNamespace[row.namespace] = (byNamespace[row.namespace] ?? 0) + 1;
    }
  }
  scores.sort((a, b) => a - b);
  const summary: BoundedDecaySummary = {
    count: updated,
    selected: result.rows.length,
    updated,
    byNamespace: Object.fromEntries(Object.entries(byNamespace).sort(([a], [b]) => a.localeCompare(b))),
    nextCursor: result.rows.at(-1)?.id ?? null,
    asOf: options.asOf,
    dryRun: !options.apply,
  };
  if (scores.length > 0) Object.assign(summary, {
    min: scores[0].toFixed(4), max: scores.at(-1)!.toFixed(4),
    median: scores[Math.floor(scores.length / 2)].toFixed(4),
    avg: (scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(4),
  });
  return summary;
}
