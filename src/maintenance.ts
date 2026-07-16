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
