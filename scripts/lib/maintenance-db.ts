import pg from 'pg';

export interface MaintenanceEnvironment {
  MAINTENANCE_DATABASE_URL?: string;
  MIGRATION_DATABASE_URL?: string;
  OWNER_DATABASE_URL?: string;
  DATABASE_URL?: string;
}

export interface QueryClient {
  query<T = any>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface MaintenanceIdentity {
  database: string;
  user: string;
  server: string;
}

export interface NamespaceCount {
  namespace: string;
  count: number;
}

/** Resolve owner-capable operator configuration without normalizing or exposing it. */
export function resolveMaintenanceDatabaseUrl(
  env: MaintenanceEnvironment,
  warn: (message: string) => void = console.warn,
): string {
  if (env.MAINTENANCE_DATABASE_URL?.trim()) return env.MAINTENANCE_DATABASE_URL;
  if (env.MIGRATION_DATABASE_URL?.trim()) return env.MIGRATION_DATABASE_URL;
  if (env.OWNER_DATABASE_URL?.trim()) {
    warn('OWNER_DATABASE_URL is deprecated for maintenance; use MAINTENANCE_DATABASE_URL or MIGRATION_DATABASE_URL');
    return env.OWNER_DATABASE_URL;
  }
  throw new Error('MAINTENANCE_DATABASE_URL or MIGRATION_DATABASE_URL is required (deprecated OWNER_DATABASE_URL is also accepted)');
}

/**
 * Fail closed under RLS. row_security=off does not bypass RLS: it makes a query
 * error if PostgreSQL would otherwise apply a policy, which proves capability by
 * actually reading the maintained table rather than inferring it from role flags.
 */
export async function prepareAllRowMaintenance(client: QueryClient): Promise<MaintenanceIdentity> {
  try {
    await client.query('SET row_security = off');
    const identity = await client.query<MaintenanceIdentity>(`
      SELECT current_database() AS database,
             current_user AS user,
             COALESCE(inet_server_addr()::text, 'local') || COALESCE(':' || inet_server_port()::text, '') AS server
    `);
    await client.query('SELECT count(*)::text AS count FROM public.memories');
    const row = identity.rows[0];
    if (!row) throw new Error('database identity unavailable');
    return row;
  } catch (error) {
    throw new Error('All-row maintenance preflight failed; use the table owner or a BYPASSRLS role', { cause: error });
  }
}

export async function inventoryNamespaces(client: QueryClient): Promise<NamespaceCount[]> {
  const result = await client.query<{ namespace: string; count: string | number }>(`
    SELECT namespace, count(*)::text AS count
    FROM public.memories
    GROUP BY namespace
    ORDER BY namespace
  `);
  return result.rows.map(row => ({ namespace: row.namespace, count: Number(row.count) }));
}

export async function connectMaintenanceClient(
  env: MaintenanceEnvironment = process.env,
  createClient: (connectionString: string) => pg.Client = connectionString => new pg.Client({ connectionString }),
): Promise<{ client: pg.Client; identity: MaintenanceIdentity }> {
  const connectionString = resolveMaintenanceDatabaseUrl(env);
  const client = createClient(connectionString);
  try {
    await client.connect();
    const identity = await prepareAllRowMaintenance(client);
    return { client, identity };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}
