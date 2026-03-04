import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

let pool: pg.Pool | null = null;
let _currentNamespaces: string[] = [];

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
    if (_currentNamespaces.length > 0) {
      await client.query(
        `SELECT set_config('app.allowed_namespaces', $1, false)`,
        [_currentNamespaces.join(',')]
      );
    }
    return await client.query<T>(text, params);
  } finally {
    client.release();
  }
}

export async function withClient<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    if (_currentNamespaces.length > 0) {
      await client.query(
        `SELECT set_config('app.allowed_namespaces', $1, false)`,
        [_currentNamespaces.join(',')]
      );
    }
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function shutdown(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function setNamespaceContext(namespaces: string[]): Promise<void> {
  _currentNamespaces = namespaces;
}

export function getCurrentNamespaces(): string[] {
  return _currentNamespaces;
}
