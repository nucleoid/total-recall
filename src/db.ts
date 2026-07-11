import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import dotenv from 'dotenv';
import type { AuthContext } from './types.js';

dotenv.config();

const { Pool } = pg;

interface DbContext {
  keyId: string | null;
  namespaces: string[];
}

let pool: pg.Pool | null = null;
const contextStorage = new AsyncLocalStorage<DbContext>();
let fallbackContext: DbContext = { keyId: null, namespaces: [] };

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

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await applyContext(client);
    const result = await client.query<T>(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function withClient<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await applyContext(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function applyContext(client: pg.PoolClient): Promise<void> {
  const context = getDbContext();
  if (context.namespaces.length > 0) {
    await client.query(
      `SELECT set_config('app.allowed_namespaces', $1, true)`,
      [context.namespaces.join(',')]
    );
  }
  if (context.keyId) {
    await client.query(
      `SELECT set_config('app.current_key_id', $1, true)`,
      [context.keyId]
    );
  }
}

function getDbContext(): DbContext {
  return contextStorage.getStore() ?? fallbackContext;
}

export async function shutdown(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function setNamespaceContext(namespaces: string[]): Promise<void> {
  const current = getDbContext();
  const next = { ...current, namespaces };
  fallbackContext = next;
  contextStorage.enterWith(next);
}

export function getCurrentNamespaces(): string[] {
  return getDbContext().namespaces;
}

export async function setKeyContext(keyId: string | null): Promise<void> {
  const current = getDbContext();
  const next = { ...current, keyId };
  fallbackContext = next;
  contextStorage.enterWith(next);
}

export async function setAuthContext(auth: Pick<AuthContext, 'keyId' | 'namespaces'>): Promise<void> {
  const next = { keyId: auth.keyId, namespaces: [...auth.namespaces] };
  fallbackContext = next;
  contextStorage.enterWith(next);
}

export function getCurrentKeyId(): string | null {
  return getDbContext().keyId;
}

export async function runWithAuthContext<T>(
  auth: Pick<AuthContext, 'keyId' | 'namespaces'>,
  fn: () => Promise<T>
): Promise<T> {
  return contextStorage.run({ keyId: auth.keyId, namespaces: [...auth.namespaces] }, fn);
}
