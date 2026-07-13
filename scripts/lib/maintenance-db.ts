import pg from 'pg';

export interface MaintenanceEnvironment {
  REEMBED_DATABASE_URL?: string;
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

export type MaintenanceDatabaseSource = keyof MaintenanceEnvironment;

export interface MaintenanceDatabaseConfig {
  connectionString: string;
  source: MaintenanceDatabaseSource;
}

export interface MaintenanceDatabaseOptions {
  allowReembedOverride?: boolean;
}

/** Resolve owner-capable operator configuration without normalizing or exposing it. */
export function resolveMaintenanceDatabaseConfig(
  env: MaintenanceEnvironment,
  warn: (message: string) => void = console.warn,
  options: MaintenanceDatabaseOptions = {},
): MaintenanceDatabaseConfig {
  if (options.allowReembedOverride && env.REEMBED_DATABASE_URL?.trim()) {
    return { connectionString: env.REEMBED_DATABASE_URL, source: 'REEMBED_DATABASE_URL' };
  }
  if (env.MAINTENANCE_DATABASE_URL?.trim()) return { connectionString: env.MAINTENANCE_DATABASE_URL, source: 'MAINTENANCE_DATABASE_URL' };
  if (env.MIGRATION_DATABASE_URL?.trim()) return { connectionString: env.MIGRATION_DATABASE_URL, source: 'MIGRATION_DATABASE_URL' };
  if (env.OWNER_DATABASE_URL?.trim()) {
    warn('OWNER_DATABASE_URL is deprecated for maintenance; use MAINTENANCE_DATABASE_URL or MIGRATION_DATABASE_URL');
    return { connectionString: env.OWNER_DATABASE_URL, source: 'OWNER_DATABASE_URL' };
  }
  if (env.DATABASE_URL?.trim()) return { connectionString: env.DATABASE_URL, source: 'DATABASE_URL' };
  throw new Error('MAINTENANCE_DATABASE_URL, MIGRATION_DATABASE_URL, OWNER_DATABASE_URL, or DATABASE_URL is required');
}

export function resolveMaintenanceDatabaseUrl(
  env: MaintenanceEnvironment,
  warn: (message: string) => void = console.warn,
): string {
  return resolveMaintenanceDatabaseConfig(env, warn).connectionString;
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

export type MaintenanceClientFactory = (connectionString: string) => pg.Client;

export async function connectMaintenanceClient(
  env: MaintenanceEnvironment = process.env,
  createClient: MaintenanceClientFactory = connectionString => new pg.Client({ connectionString }),
  options: MaintenanceDatabaseOptions = {},
): Promise<{ client: pg.Client; identity: MaintenanceIdentity; source: MaintenanceDatabaseSource }> {
  const { connectionString, source } = resolveMaintenanceDatabaseConfig(env, console.warn, options);
  const client = createClient(connectionString);
  try {
    await client.connect();
    const identity = await prepareAllRowMaintenance(client);
    return { client, identity, source };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

export async function withMaintenanceClient<T>(
  env: MaintenanceEnvironment,
  operation: (client: pg.Client, identity: MaintenanceIdentity, source: MaintenanceDatabaseSource) => Promise<T>,
  createClient?: MaintenanceClientFactory,
  options: MaintenanceDatabaseOptions = {},
): Promise<T> {
  const { client, identity, source } = await connectMaintenanceClient(env, createClient, options);
  try {
    return await operation(client, identity, source);
  } finally {
    await client.end();
  }
}
