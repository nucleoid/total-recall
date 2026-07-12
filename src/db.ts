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
  validateScope(scope);

  const client = await getPool().connect();
  let releaseError: Error | undefined;
  let transactionStarted = false;
  let phase: 'setup' | 'callback' | 'commit' = 'setup';

  try {
    // SET LOCAL restores the preceding session value. Deny by default first so a
    // client inherited from older session-scoped callers cannot regain authority.
    await client.query("SELECT set_config('app.allowed_namespaces', '', false)");
    await client.query('BEGIN');
    transactionStarted = true;
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
    transactionStarted = false;
    return result;
  } catch (err) {
    const primary = err instanceof Error ? err : new Error(String(err));
    releaseError = phase === 'callback' ? undefined : primary;

    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
        transactionStarted = false;
      } catch (rollbackError) {
        releaseError = primary;
        Object.defineProperty(primary, 'rollbackError', {
          value: rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
          enumerable: false,
          configurable: true,
        });
      }
    }
    throw primary;
  } finally {
    client.release(releaseError);
  }
}

function validateScope(scope: DbScope): void {
  for (const namespace of scope.namespaces) {
    if (namespace.trim().length === 0 || namespace.includes(',')) {
      throw new Error('DbScope namespace entries must be nonempty and cannot contain commas');
    }
  }
}

export async function shutdown(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
