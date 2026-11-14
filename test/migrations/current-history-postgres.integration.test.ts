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
  await runMigrations(owner, inventory, { lockTimeoutMs: 5_000, throughNumber: 48 });
  const retainedLineage = (await owner.query(
    'SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version',
  )).rows;
  await runMigrations(owner, inventory, { lockTimeoutMs: 5_000 });
  assert.deepEqual((await owner.query(
    'SELECT version, checksum, applied_at FROM schema_migrations WHERE version < $1 ORDER BY version',
    ['049'],
  )).rows, retainedLineage, 'appending ingestion must not rewrite applied shadow migration identities');

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

  await t.test('separate ingestion 037/038 history is rejected without rewriting or replaying it', async () => {
    await owner.query('CREATE DATABASE divergent_ingestion_history_test');
    const divergent = await connectWhenReady(ownerUrl.replace(/\/postgres$/, '/divergent_ingestion_history_test'));
    try {
      await divergent.query('CREATE EXTENSION vector');
      await runMigrations(divergent, inventory, { lockTimeoutMs: 5_000, throughNumber: 36 });
      for (const [current, original] of [
        ['049_memory_ingestion_queue', '037_memory_ingestion_queue'],
        ['050_memory_ingestion_update_kind', '038_memory_ingestion_update_kind'],
      ]) {
        const migration = inventory.find(item => item.version === current)!;
        await divergent.query(migration.sql);
        await divergent.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',
          [original, migration.checksum]);
      }
      const before = (await divergent.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
      await assert.rejects(runMigrations(divergent, inventory, { lockTimeoutMs: 5_000 }),
        /Unknown applied migration 037_memory_ingestion_queue/);
      assert.deepEqual((await divergent.query('SELECT * FROM schema_migrations ORDER BY version')).rows, before);
      assert.equal((await divergent.query("SELECT to_regclass('public.embedding_contracts') AS relation")).rows[0].relation, null);
      assert.equal((await divergent.query('SELECT count(*)::int AS count FROM memory_ingestion_jobs')).rows[0].count, 0);
    } finally {
      await divergent.end();
    }
  });
});
