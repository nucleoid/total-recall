import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { loadMigrationInventory, runMigrations } from '../../scripts/migrate.js';
import { provisionDatabase } from '../../scripts/provision-db.js';
import { reconcileLegacyLedger } from '../../scripts/reconcile-legacy-ledger.js';

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

async function connectWhenReady(connectionString: string): Promise<pg.Client> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString });
    try { await client.connect(); return client; }
    catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error('PostgreSQL did not become ready', { cause: lastError });
}

test('reviewed 001/006 legacy ledger is schema-proved before atomic reconciliation', { timeout: 120_000 }, async t => {
  if (!dockerAvailable()) { t.skip('Docker is unavailable'); return; }
  const container = execFileSync('docker', [
    'run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=postgres',
    '-p', '127.0.0.1::5432', process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16',
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

  const migrationsDir = join(process.cwd(), 'migrations');
  const inventory = loadMigrationInventory(migrationsDir);
  for (const file of readdirSync(migrationsDir).filter(file => /^00[1-6]_.*\.sql$/.test(file)).sort()) {
    await owner.query(readFileSync(join(migrationsDir, file), 'utf8'));
  }
  await owner.query("INSERT INTO schema_migrations(version) VALUES ('001_initial'), ('006_media_events')");

  await owner.query('DROP INDEX public.idx_recall_traces_session');
  await assert.rejects(
    reconcileLegacyLedger(owner, inventory, { apply: false, backupConfirmed: false }),
    /schema proof failed.*required indexes/i,
  );
  await owner.query('CREATE INDEX idx_recall_traces_session ON recall_traces(session_id)');

  const preview = await reconcileLegacyLedger(owner, inventory, { apply: false, backupConfirmed: false });
  assert.deepEqual(preview, {
    mode: 'preview',
    added: ['002_documents_and_sync', '003_rls', '004_audit', '005_agent_provenance_and_traces'],
  });
  assert.equal((await owner.query(`SELECT count(*)::int AS count FROM information_schema.columns
    WHERE table_schema='public' AND table_name='schema_migrations' AND column_name='checksum'`)).rows[0].count, 0);
  await assert.rejects(
    reconcileLegacyLedger(owner, inventory, { apply: true, backupConfirmed: false }),
    /confirm-backup/i,
  );

  const applied = await reconcileLegacyLedger(owner, inventory, { apply: true, backupConfirmed: true });
  assert.equal(applied.mode, 'applied');
  const ledger = await owner.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  assert.deepEqual(ledger.rows, inventory.slice(0, 6).map(({ version, checksum }) => ({ version, checksum })));

  await runMigrations(owner, inventory, { lockTimeoutMs: 5_000, throughNumber: 7 });
  assert.equal((await owner.query("SELECT count(*)::int AS count FROM schema_migrations WHERE version='007_decay'")).rows[0].count, 1);
});
