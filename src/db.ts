import pg from 'pg';
import dotenv from 'dotenv';
import type { AuthContext } from './types.js';

dotenv.config();

const { Pool } = pg;

let pool: pg.Pool | null = null;

export interface DbScope {
  namespaces: string[];
  keyId: string;
  isAdmin?: boolean;
}

export type ScopedClient = pg.PoolClient;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      console.error('[db] Unexpected pool error:', err.message);
    });
  }
  return pool;
}

export function dbScopeFromAuth(auth: AuthContext): DbScope {
  return {
    namespaces: auth.namespaces,
    keyId: auth.keyId,
    isAdmin: auth.permissions.includes('admin'),
  };
}

export function setPoolForTesting(testPool: pg.Pool | null): void {
  pool = testPool;
}

export async function queryUnscoped<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function queryScoped<T extends pg.QueryResultRow = any>(
  scope: DbScope,
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return withScopedClient(scope, (client) => client.query<T>(text, params));
}

export async function withScopedClient<T>(
  scope: DbScope,
  fn: (client: ScopedClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  let releaseError: Error | undefined;
  let committed = false;
  let phase: 'setup' | 'callback' | 'commit' = 'setup';

  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.allowed_namespaces', $1, true)",
      [JSON.stringify(scope.namespaces)]
    );
    await client.query(
      "SELECT set_config('app.current_key_id', $1, true)",
      [scope.keyId]
    );
    await client.query(
      "SELECT set_config('app.current_key_is_admin', $1, true)",
      [scope.isAdmin === true ? 'true' : 'false']
    );

    phase = 'callback';
    const result = await fn(client);
    phase = 'commit';
    await client.query('COMMIT');
    committed = true;
    return result;
  } catch (err) {
    const caught = err instanceof Error ? err : new Error(String(err));
    releaseError = phase === 'callback' ? undefined : caught;
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        releaseError = caught;
      }
    }
    throw err;
  } finally {
    client.release(releaseError);
  }
}

export async function shutdown(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
