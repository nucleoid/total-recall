import { getPoolGeneration, queryScoped, withScopedClient, type DbScope, type ScopedClient } from './db.js';

let availableGeneration = -1;
/** Schema availability survives acceptance rollback; cache only positive discovery. */
export async function ingestionSchemaAvailable(scope: DbScope, client?: ScopedClient): Promise<boolean> {
  const generation = getPoolGeneration();
  if (availableGeneration === generation) return true;
  const sql = "SELECT to_regclass('public.memory_ingestion_jobs') IS NOT NULL AS present";
  const result = client ? await client.query(sql) : await queryScoped(scope, sql);
  const present = result.rows[0]?.present === true;
  if (present) availableGeneration = generation;
  return present;
}

/** LEFT JOIN owner-private detail, with a namespace-scoped state-only projection for other readers. */
export async function attachIngestion<T extends { id: string }>(rows: T[], scope: DbScope, existingClient?: ScopedClient): Promise<T[]> {
  if (!rows.length || !await ingestionSchemaAvailable(scope, existingClient)) return rows;
  const load = async (client: ScopedClient) => {
    const result = await client.query(`SELECT ids.id, app_memory_ingestion_state(ids.id) AS state,
      CASE WHEN j.client_id = app_current_key_id() THEN jsonb_build_object(
        'state', j.status, 'accepted_at', j.accepted_at, 'ready_at', j.ready_at, 'attempts', j.attempts,
        'next_retry_at', CASE WHEN j.status = 'retry_wait' THEN j.next_attempt_at ELSE NULL END,
        'failure_category', j.failure_category, 'canonical_memory_id', j.canonical_memory_id, 'similarity', j.similarity
      ) ELSE NULL END AS detail
      FROM unnest($1::uuid[]) ids(id) LEFT JOIN memory_ingestion_jobs j ON j.memory_id = ids.id`, [rows.map(row => row.id)]);
    const statuses = new Map(result.rows.map(row => [row.id, row.detail ?? (row.state ? { state: row.state } : undefined)]));
    return rows.map(row => statuses.get(row.id) ? { ...row, ingestion: statuses.get(row.id) } : row);
  };
  return existingClient ? load(existingClient) : withScopedClient(scope, load);
}
export async function ingestionAlias(id: string, scope: DbScope): Promise<string | undefined> {
  if (!await ingestionSchemaAvailable(scope)) return undefined;
  const result = await queryScoped(scope, `SELECT canonical_memory_id FROM memory_ingestion_jobs
    WHERE memory_id = $1 AND status = 'deduplicated' AND client_id = app_current_key_id()`, [id]);
  return result.rows[0]?.canonical_memory_id;
}
