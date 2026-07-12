import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import pg from 'pg';
import { setPoolForTesting, shutdown, withScopedClient } from '../src/db.js';

let containerId: string | undefined;

test.after(async () => {
  await shutdown();
  if (containerId) {
    execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
  }
});

test('HNSW and scope settings are transaction-local on a reused pool connection', async () => {
  const databaseUrl = await ensureDatabaseUrl();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  setPoolForTesting(pool);

  await withScopedClient({ namespaces: ['shared'], keyId: 'key-1' }, async (client) => {
    await client.query("SELECT set_config('hnsw.ef_search', $1, true)", ['456']);
    const res = await client.query<{
      hnsw: string;
      namespaces: string;
      keyId: string;
    }>(`
      SELECT
        current_setting('hnsw.ef_search') AS hnsw,
        current_setting('app.allowed_namespaces') AS namespaces,
        current_setting('app.current_key_id') AS "keyId"
    `);

    assert.equal(res.rows[0].hnsw, '456');
    assert.equal(res.rows[0].namespaces, '["shared"]');
    assert.equal(res.rows[0].keyId, 'key-1');
  });

  await assertLocalSettingsAbsent(pool);

  await assert.rejects(
    () =>
      withScopedClient({ namespaces: ['media'], keyId: 'key-2' }, async (client) => {
        await client.query("SELECT set_config('hnsw.ef_search', $1, true)", ['789']);
        throw new Error('rollback requested');
      }),
    /rollback requested/
  );

  await assertLocalSettingsAbsent(pool);
});

async function assertLocalSettingsAbsent(pool: pg.Pool): Promise<void> {
  const res = await pool.query<{
    hnsw: string | null;
    namespaces: string | null;
    keyId: string | null;
  }>(`
    SELECT
      current_setting('hnsw.ef_search', true) AS hnsw,
      current_setting('app.allowed_namespaces', true) AS namespaces,
      current_setting('app.current_key_id', true) AS "keyId"
  `);

  assertAbsent(res.rows[0].hnsw);
  assertAbsent(res.rows[0].namespaces);
  assertAbsent(res.rows[0].keyId);
}

function assertAbsent(value: string | null): void {
  assert.ok(value === null || value === '', `expected transaction-local setting to be absent, got ${value}`);
}

async function ensureDatabaseUrl(): Promise<string> {
  if (process.env.HNSW_SETTINGS_TEST_DATABASE_URL) {
    return process.env.HNSW_SETTINGS_TEST_DATABASE_URL;
  }

  const image = process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16';
  containerId = execFileSync('docker', [
    'run',
    '--rm',
    '-d',
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-p',
    '127.0.0.1::5432',
    image,
  ], { encoding: 'utf8' }).trim();

  const portLine = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' }).trim();
  const port = portLine.split(':').at(-1);
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.end();
      return url;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw lastError;
}
