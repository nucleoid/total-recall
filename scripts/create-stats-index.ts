import { pathToFileURL } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const STATS_INDEX_NAME = 'memories_stats_active_cover_idx';

export interface CreateStatsIndexResult {
  indexName: string;
  created: boolean;
  indexExists: boolean;
  indexValid: boolean;
}

type IndexState = { exists: boolean; isValid: boolean };

export async function createStatsIndex(connectionString: string): Promise<CreateStatsIndexResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    const before = await loadIndexState(client);
    if (before.exists && !before.isValid) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public.${STATS_INDEX_NAME}`);
    }

    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ${STATS_INDEX_NAME}
        ON public.memories (namespace, access_level)
        INCLUDE (
          source, document_id, created_at, expires_at, origin_namespace,
          deleted_at, consolidated_into_id
        )
    `);
    const after = await loadIndexState(client);

    return {
      indexName: STATS_INDEX_NAME,
      created: !before.exists || !before.isValid,
      indexExists: after.exists,
      indexValid: after.isValid,
    };
  } finally {
    await client.end();
  }
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
    [STATS_INDEX_NAME],
  );
  return {
    exists: result.rows[0]?.exists === true,
    isValid: result.rows[0]?.isValid === true,
  };
}

async function main(): Promise<void> {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required');
  console.log(JSON.stringify(await createStatsIndex(connectionString)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('stats index build failed:', error);
    process.exit(1);
  });
}
