import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { shutdown, type DbScope } from '../src/db.js';
import { resolveMaintenanceDatabaseUrl, verifyAllRowMaintenanceRole } from './maintenance-database.js';
import dotenv from 'dotenv';

dotenv.config();

export const DECAY_SCOPE: DbScope = {
  keyId: 'decay-update',
  namespaces: ['personal', 'work', 'projects', 'financial', 'shared', 'media'],
  isAdmin: true,
};

interface QueryClient {
  query<T = any>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface DecaySummary {
  count: number;
  min?: string;
  max?: string;
  median?: string;
  avg?: string;
}

export async function updateDecayWithClient(client: QueryClient): Promise<DecaySummary> {
  // The readiness check and update share one statement snapshot. The data-modifying
  // CTE cannot touch any row unless every historical base has been classified.
  const res = await client.query<{ maintenance_ready: boolean; relevance_score: number | null }>(`
    WITH maintenance AS MATERIALIZED (
      SELECT NOT EXISTS (
        SELECT 1 FROM public.memories WHERE relevance_base_score IS NULL
      ) AS ready
    ), updated AS (
      UPDATE public.memories
      SET relevance_score = public.calculate_relevance(relevance_base_score, decay_rate, accessed_at, access_count),
          updated_at = NOW()
      WHERE (SELECT ready FROM maintenance)
      RETURNING relevance_score
    )
    SELECT maintenance.ready AS maintenance_ready, updated.relevance_score
    FROM maintenance
    LEFT JOIN updated ON TRUE
  `);

  if (res.rows[0]?.maintenance_ready === false) {
    throw new Error('Decay aborted: at least one memory has an unclassified relevance base');
  }

  const scores = res.rows
    .filter((row): row is typeof row & { relevance_score: number } => row.relevance_score !== null)
    .map(row => Number(row.relevance_score))
    .sort((a, b) => a - b);
  const count = scores.length;
  if (count === 0) return { count };

  return {
    count,
    min: scores[0].toFixed(4),
    max: scores[count - 1].toFixed(4),
    median: scores[Math.floor(count / 2)].toFixed(4),
    avg: (scores.reduce((a, b) => a + b, 0) / count).toFixed(4),
  };
}

async function updateDecay() {
  const connectionString = resolveMaintenanceDatabaseUrl(process.env);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await verifyAllRowMaintenanceRole(client);
    const summary = await updateDecayWithClient(client);
    if (summary.count === 0) console.log('No memories to update.');
    else console.log(JSON.stringify(summary));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  updateDecay()
    .then(() => shutdown())
    .catch((err) => {
      console.error('Decay update failed:', err);
      shutdown().finally(() => process.exit(1));
    });
}
