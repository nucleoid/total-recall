interface MaintenanceEnvironment {
  MAINTENANCE_DATABASE_URL?: string;
  MIGRATION_DATABASE_URL?: string;
}

interface QueryClient {
  query<T = any>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Maintenance never inherits DATABASE_URL: that connection is the RLS-scoped
 * runtime role. MIGRATION_DATABASE_URL is an owner-capable compatibility fallback.
 */
export function resolveMaintenanceDatabaseUrl(env: MaintenanceEnvironment): string {
  const connectionString = env.MAINTENANCE_DATABASE_URL || env.MIGRATION_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'MAINTENANCE_DATABASE_URL is required (MIGRATION_DATABASE_URL is the owner-capable compatibility fallback)',
    );
  }
  return connectionString;
}

export async function verifyAllRowMaintenanceRole(client: QueryClient): Promise<void> {
  const verification = await client.query<{ all_rows: boolean }>(`
    SELECT r.rolsuper
        OR r.rolbypassrls
        OR pg_has_role(r.oid, c.relowner, 'USAGE') AS all_rows
    FROM pg_roles r
    JOIN pg_class c ON c.oid = 'public.memories'::regclass
    WHERE r.rolname = current_user
  `);
  if (verification.rows[0]?.all_rows !== true) {
    throw new Error('Maintenance connection must be superuser, own public.memories directly or by membership, or have BYPASSRLS');
  }
}
