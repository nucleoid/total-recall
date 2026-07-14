import pg from 'pg';
import dotenv from 'dotenv';
import type { AuthContext } from './types.js';

dotenv.config();

const { Pool } = pg;

let pool: pg.Pool | null = null;
let poolGeneration = 0;

export interface DbScope {
  namespaces: string[];
  keyId: string;
  isAdmin?: boolean;
}

export type ScopedClient = pg.PoolClient;

export function getPool(): pg.Pool {
  if (!pool) {
    poolGeneration += 1;
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
  poolGeneration += 1;
}

/** Changes whenever this process swaps or recreates its database pool. */
export function getPoolGeneration(): number {
  return poolGeneration;
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
    // Preserve the established one-transaction contract. The session namespace
    // deny prevents inherited pooled authority before transaction-local scope.
    await client.query("SELECT set_config('app.allowed_namespaces', '', false)");
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query("SELECT set_config('app.allowed_namespaces', $1, true)", [JSON.stringify(scope.namespaces)]);
    await client.query("SELECT set_config('app.current_key_id', $1, true)", [scope.keyId]);
    await client.query("SELECT set_config('app.current_key_is_admin', $1, true)", [scope.isAdmin === true ? 'true' : 'false']);
    phase = 'callback';
    const result = await fn(client);
    phase = 'commit';
    await client.query('COMMIT');
    transactionStarted = false;
    return result;
  } catch (error) {
    const primary = error instanceof Error ? error : new Error(String(error));
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

/**
 * Hold one pool session across multiple transactions (for example while a
 * session advisory lock is held). The callback must use
 * withScopedTransactionOnClient for every RLS-protected operation.
 */
export async function withCheckedOutClient<T>(
  fn: (client: ScopedClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  let releaseError: Error | undefined;
  let setupComplete = false;
  try {
    // Deny by default before exposing a pooled session. Transaction-local scope
    // is installed separately and can never leak to the next borrower.
    await client.query("SELECT set_config('app.allowed_namespaces', '', false)");
    await client.query("SELECT set_config('app.current_key_id', '', false)");
    await client.query("SELECT set_config('app.current_key_is_admin', 'false', false)");
    setupComplete = true;
    return await fn(client);
  } catch (error) {
    const primary = error instanceof Error ? error : new Error(String(error));
    // Domain/callback failures with a successful rollback do not poison the
    // pool connection; setup failures do.
    releaseError = setupComplete && !('discardConnection' in primary) ? undefined : primary;
    throw primary;
  } finally {
    client.release(releaseError);
  }
}

/** Run one RLS-scoped transaction on an already checked-out pool session. */
export async function withScopedTransactionOnClient<T>(
  client: ScopedClient,
  scope: DbScope,
  fn: (client: ScopedClient) => Promise<T>,
): Promise<T> {
  validateScope(scope);
  let transactionStarted = false;
  let phase: 'setup' | 'callback' | 'commit' = 'setup';
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query("SELECT set_config('app.allowed_namespaces', $1, true)", [JSON.stringify(scope.namespaces)]);
    await client.query("SELECT set_config('app.current_key_id', $1, true)", [scope.keyId]);
    await client.query("SELECT set_config('app.current_key_is_admin', $1, true)", [scope.isAdmin === true ? 'true' : 'false']);
    phase = 'callback';
    const result = await fn(client);
    phase = 'commit';
    await client.query('COMMIT');
    transactionStarted = false;
    return result;
  } catch (error) {
    const primary = error instanceof Error ? error : new Error(String(error));
    let discard = phase !== 'callback';
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discard = true;
        Object.defineProperty(primary, 'rollbackError', {
          value: rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
          enumerable: false,
          configurable: true,
        });
      }
    }
    if (discard) Object.defineProperty(primary, 'discardConnection', { value: true, enumerable: false });
    throw primary;
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
    poolGeneration += 1;
  }
}
