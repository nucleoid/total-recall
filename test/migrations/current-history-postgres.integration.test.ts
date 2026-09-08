import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { loadMigrationInventory, runMigrations } from '../../scripts/migrate.js';
import { provisionDatabase } from '../../scripts/provision-db.js';

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

async function connectWhenReady(connectionString: string): Promise<pg.Client> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error('PostgreSQL did not become ready', { cause: lastError });
}

test('the complete migration history parses and executes on PostgreSQL 16', { timeout: 120_000 }, async t => {
  if (!dockerAvailable()) { t.skip('Docker is unavailable'); return; }
  const container = execFileSync('docker', [
    'run', '--rm', '-d',
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-p', '127.0.0.1::5432',
    process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16',
  ], { encoding: 'utf8' }).trim();

  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)!;
  const ownerUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const owner = await connectWhenReady(ownerUrl);
  t.after(async () => {
    await owner.end().catch(() => undefined);
    try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch {}
  });
  await owner.query('CREATE EXTENSION vector');
  await provisionDatabase(owner, { appPassword: 'test-only-app-password', rotateAppPassword: false });

  const inventory = loadMigrationInventory(fileURLToPath(new URL('../../migrations', import.meta.url)));
  await runMigrations(owner, inventory, { lockTimeoutMs: 5_000, throughNumber: 31 });
  assert.equal((await owner.query(
    "SELECT count(*)::int AS count FROM schema_migrations WHERE version = '031_memory_reflection'",
  )).rows[0].count, 1);
  assert.equal((await owner.query(
    "SELECT count(*)::int AS count FROM schema_migrations WHERE version = '032_memory_ttl'",
  )).rows[0].count, 0);
  await runMigrations(owner, inventory, { lockTimeoutMs: 5_000 });

  const ledger = await owner.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  assert.deepEqual(
    ledger.rows,
    inventory.map(({ version, checksum }) => ({ version, checksum })),
  );
  const functions = await owner.query<{ name: string }>(`
    SELECT proname AS name
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = ANY($1::text[])
    ORDER BY proname
  `, [['app_transfer_source_key_access', 'validate_memory_insight_evidence']]);
  assert.deepEqual(functions.rows.map(row => row.name), [
    'app_transfer_source_key_access',
    'validate_memory_insight_evidence',
  ]);
});
