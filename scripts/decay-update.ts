import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { connectMaintenanceClient, inventoryNamespaces, type QueryClient } from './lib/maintenance-db.js';

dotenv.config();

export interface DecaySummary {
  count: number;
  byNamespace: Record<string, number>;
  min?: string;
  max?: string;
  median?: string;
  avg?: string;
}

export async function updateDecayWithClient(client: QueryClient): Promise<DecaySummary> {
  // Readiness and update share one statement snapshot. No row can change while
  // any historical relevance base remains unclassified.
  const res = await client.query<{
    maintenance_ready: boolean;
    namespace: string | null;
    relevance_score: number | null;
  }>(`
    WITH maintenance AS MATERIALIZED (
      SELECT NOT EXISTS (
        SELECT 1 FROM public.memories WHERE deleted_at IS NULL AND to_jsonb(memories)->>'consolidated_into_id' IS NULL AND relevance_base_score IS NULL
      ) AS ready
    ), updated AS (
      UPDATE public.memories
      SET relevance_score = public.calculate_relevance(relevance_base_score, decay_rate, accessed_at, access_count),
          updated_at = NOW()
      WHERE (SELECT ready FROM maintenance)
        AND deleted_at IS NULL
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

async function main() {
  const { client, identity } = await connectMaintenanceClient();
  try {
    console.log('[decay] Maintenance database', identity);
    console.log('[decay] Initial namespace inventory', await inventoryNamespaces(client));
    const summary = await updateDecayWithClient(client);
    console.log('[decay] Actual updated totals', summary);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[decay] Failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
