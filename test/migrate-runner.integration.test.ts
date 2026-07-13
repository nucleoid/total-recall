import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import pg from 'pg';
import {
  isCompatibleAppliedChecksum,
  loadMigrationInventory,
  parseMigrationLockTimeout,
  resolveMigrationDatabaseUrl,
  runMigrations,
} from '../scripts/migrate.js';

function migrationDirectory(files: Record<string, string | Buffer>): string {
  const directory = mkdtempSync(join(tmpdir(), 'total-recall-migrations-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents);
  }
  return directory;
}

test('inventory hashes exact bytes, sorts numerically, and permits numeric gaps', () => {
  const first = Buffer.from('SELECT 1;\r\n');
  const inventory = loadMigrationInventory(migrationDirectory({
    '010_later.sql': 'SELECT 10;\n',
    '001_first.sql': first,
  }));

  assert.deepEqual(inventory.map(item => item.version), ['001_first', '010_later']);
  assert.equal(inventory[0].checksum, createHash('sha256').update(first).digest('hex'));
  assert.equal(inventory[0].sql, 'SELECT 1;\r\n');
});

test('inventory rejects duplicate numeric prefixes and malformed names', () => {
  assert.throws(
    () => loadMigrationInventory(migrationDirectory({
      '001_first.sql': 'SELECT 1',
      '001_other.sql': 'SELECT 2',
    })),
    /duplicate migration number 001/i,
  );
  assert.throws(
    () => loadMigrationInventory(migrationDirectory({ '1_bad.sql': 'SELECT 1' })),
    /invalid migration filename/i,
  );
});

test('inventory rejects invalid UTF-8 rather than executing replacement text', () => {
  assert.throws(
    () => loadMigrationInventory(migrationDirectory({
      '001_invalid.sql': Buffer.from([0x53, 0x45, 0x4c, 0x45, 0x43, 0x54, 0x20, 0xff]),
    })),
    /valid UTF-8/i,
  );
});

test('migration lock timeout is bounded and validated', () => {
  assert.equal(parseMigrationLockTimeout(undefined), 30_000);
  assert.equal(parseMigrationLockTimeout('1250'), 1250);
  for (const invalid of ['', '0', '-1', '1.5', '600001', 'wat']) {
    assert.throws(() => parseMigrationLockTimeout(invalid), /MIGRATION_LOCK_TIMEOUT_MS/i);
  }
});

test('migration runner requires the owner-only URL without a runtime fallback', () => {
  assert.equal(
    resolveMigrationDatabaseUrl({ MIGRATION_DATABASE_URL: 'postgresql://owner@db/custom' }),
    'postgresql://owner@db/custom',
  );
  assert.throws(
    () => resolveMigrationDatabaseUrl({ DATABASE_URL: 'postgresql://total_recall_app@db/custom' }),
    /MIGRATION_DATABASE_URL.*required/i,
  );
});

test('the reviewed 003 sanitization is the only accepted applied-checksum transition', () => {
  for (const legacy003 of [
    '453417ae58829f930186b2a034b592db3df644a4045e5afcd87a67c4e0d6b615',
    '3fc2cdc1814ab6da989106733a2b78da175263bb66a747fdc49800a80395aac5',
  ]) {
    assert.equal(isCompatibleAppliedChecksum('003_rls', legacy003), true);
  }
  assert.equal(isCompatibleAppliedChecksum('003_rls', '0'.repeat(64)), false);
  assert.equal(
    isCompatibleAppliedChecksum('004_audit', '453417ae58829f930186b2a034b592db3df644a4045e5afcd87a67c4e0d6b615'),
    false,
  );
});

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const createdDatabases: string[] = [];

async function temporaryDatabase(): Promise<string> {
  if (!databaseUrl) throw new Error('MIGRATION_TEST_DATABASE_URL is required');
  const name = `migration_test_${process.pid}_${createdDatabases.length}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  createdDatabases.push(name);
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.href;
}

async function connected(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

after(async () => {
  if (!databaseUrl) return;
  const admin = await connected(databaseUrl);
  for (const name of createdDatabases) {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [name]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  }
  await admin.end();
});

test('two empty-database migrators serialize and record exact checksums once', { skip: !databaseUrl }, async () => {
  const url = await temporaryDatabase();
  const directory = migrationDirectory({
    '001_first.sql': 'CREATE TABLE first_marker (id integer PRIMARY KEY);',
    '003_gap.sql': 'INSERT INTO first_marker VALUES (1);',
  });
  const inventory = loadMigrationInventory(directory);
  const first = await connected(url);
  const second = await connected(url);

  await Promise.all([
    runMigrations(first, inventory, { lockTimeoutMs: 2_000 }),
    runMigrations(second, inventory, { lockTimeoutMs: 2_000 }),
  ]);
  await Promise.all([first.end(), second.end()]);

  const check = await connected(url);
  const ledger = await check.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
  assert.deepEqual(ledger.rows, inventory.map(({ version, checksum }) => ({ version, checksum })));
  assert.equal((await check.query('SELECT count(*)::int AS count FROM first_marker')).rows[0].count, 1);
  await check.end();
});

test('legacy checksums baseline atomically and byte drift blocks all pending work', { skip: !databaseUrl }, async () => {
  const url = await temporaryDatabase();
  const directory = migrationDirectory({
    '001_first.sql': 'CREATE TABLE original_marker (id integer);\n',
    '002_pending.sql': 'CREATE TABLE applied_after_baseline (id integer);',
  });
  const setup = await connected(url);
  await setup.query('CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  await setup.query("INSERT INTO schema_migrations(version) VALUES ('001_first')");
  await setup.end();
  const warnings: string[] = [];

  const runner = await connected(url);
  await runMigrations(runner, loadMigrationInventory(directory), {
    lockTimeoutMs: 2_000,
    warn: message => warnings.push(message),
  });
  await runner.end();
  assert.match(warnings.join('\n'), /cannot detect edits made before this baseline/i);

  writeFileSync(join(directory, '001_first.sql'), 'CREATE TABLE original_marker (id integer);\r\n');
  writeFileSync(join(directory, '003_must_not_run.sql'), 'CREATE TABLE must_not_run (id integer);');
  const driftRunner = await connected(url);
  await assert.rejects(
    runMigrations(driftRunner, loadMigrationInventory(directory), { lockTimeoutMs: 2_000 }),
    /checksum mismatch.*001_first/i,
  );
  await driftRunner.end();
  const check = await connected(url);
  assert.equal((await check.query("SELECT to_regclass('public.must_not_run') AS marker")).rows[0].marker, null);
  await check.end();
});

test('two first-upgrade runners serialize checksum baseline and pending work', { skip: !databaseUrl }, async () => {
  const url = await temporaryDatabase();
  const directory = migrationDirectory({
    '001_legacy.sql': 'SELECT 1;',
    '002_pending.sql': 'CREATE TABLE after_concurrent_baseline (id integer);',
  });
  const inventory = loadMigrationInventory(directory);
  const setup = await connected(url);
  await setup.query('CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  await setup.query("INSERT INTO schema_migrations(version) VALUES ('001_legacy')");
  await setup.end();
  const first = await connected(url);
  const second = await connected(url);

  await Promise.all([
    runMigrations(first, inventory, { lockTimeoutMs: 2_000 }),
    runMigrations(second, inventory, { lockTimeoutMs: 2_000 }),
  ]);
  await Promise.all([first.end(), second.end()]);

  const check = await connected(url);
  const ledger = await check.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
  assert.deepEqual(ledger.rows, inventory.map(({ version, checksum }) => ({ version, checksum })));
  await check.end();
});

test('unknown applied history and malformed checksums fail before pending SQL', { skip: !databaseUrl }, async () => {
  for (const ledger of [
    { version: '001_renamed_or_missing', checksum: null },
    { version: '001_first', checksum: 'not-a-sha256' },
  ]) {
    const url = await temporaryDatabase();
    const directory = migrationDirectory({
      '001_first.sql': 'SELECT 1;',
      '002_pending.sql': 'CREATE TABLE must_not_run (id integer);',
    });
    const setup = await connected(url);
    await setup.query('CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz DEFAULT now(), checksum text)');
    await setup.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [ledger.version, ledger.checksum]);
    await setup.end();

    const runner = await connected(url);
    await assert.rejects(runMigrations(runner, loadMigrationInventory(directory), { lockTimeoutMs: 2_000 }), /unknown applied migration|malformed checksum/i);
    await runner.end();
    const check = await connected(url);
    assert.equal((await check.query("SELECT to_regclass('public.must_not_run') AS marker")).rows[0].marker, null);
    await check.end();
  }
});

test('a migration cannot back-fill a numeric gap below applied history', { skip: !databaseUrl }, async () => {
  const url = await temporaryDatabase();
  const directory = migrationDirectory({
    '002_late_backfill.sql': 'CREATE TABLE must_not_run (id integer);',
    '003_already_applied.sql': 'SELECT 3;',
  });
  const inventory = loadMigrationInventory(directory);
  const setup = await connected(url);
  await setup.query('CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz DEFAULT now(), checksum text)');
  await setup.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [inventory[1].version, inventory[1].checksum]);
  await setup.end();

  const runner = await connected(url);
  await assert.rejects(runMigrations(runner, inventory, { lockTimeoutMs: 2_000 }), /out-of-order.*002_late_backfill/i);
  await runner.end();
  const check = await connected(url);
  assert.equal((await check.query("SELECT to_regclass('public.must_not_run') AS marker")).rows[0].marker, null);
  await check.end();
});

test('the ledger create remains idempotent against non-runner creators', () => {
  const source = readFileSync(new URL('../scripts/migrate.ts', import.meta.url), 'utf8');
  assert.match(source, /CREATE TABLE IF NOT EXISTS schema_migrations/i);
});

test('the current migration history applies on PostgreSQL 16 with checksums', { skip: !databaseUrl }, async () => {
  const url = await temporaryDatabase();
  const runner = await connected(url);
  await runner.query('CREATE EXTENSION vector');
  const inventory = loadMigrationInventory(fileURLToPath(new URL('../migrations', import.meta.url)));
  await runMigrations(runner, inventory, { lockTimeoutMs: 5_000 });
  const ledger = await runner.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
  assert.equal(ledger.rowCount, inventory.length);
  assert.deepEqual(new Map(ledger.rows.map(row => [row.version, row.checksum])), new Map(inventory.map(row => [row.version, row.checksum])));
  await runner.end();
});

test('held lock times out without ledger changes and failed migration rolls back and releases', { skip: !databaseUrl }, async () => {
  const url = await temporaryDatabase();
  const blocker = await connected(url);
  await blocker.query('SELECT pg_advisory_lock($1, $2)', [1414676812, 1296650834]);
  const timedRunner = await connected(url);
  await assert.rejects(
    runMigrations(timedRunner, loadMigrationInventory(migrationDirectory({ '001_first.sql': 'SELECT 1;' })), { lockTimeoutMs: 50 }),
    /timed out waiting for migration advisory lock/i,
  );
  await timedRunner.end();
  await blocker.query('SELECT pg_advisory_unlock($1, $2)', [1414676812, 1296650834]);
  await blocker.end();

  const failedDirectory = migrationDirectory({
    '001_broken.sql': 'CREATE TABLE rolled_back (id integer); SELECT this_is_invalid;',
  });
  const failing = await connected(url);
  await assert.rejects(runMigrations(failing, loadMigrationInventory(failedDirectory), { lockTimeoutMs: 500 }), /this_is_invalid/i);
  await failing.end();

  const check = await connected(url);
  assert.equal((await check.query("SELECT to_regclass('public.rolled_back') AS marker")).rows[0].marker, null);
  assert.equal((await check.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, 0);
  await check.end();

  const recovery = await connected(url);
  await runMigrations(recovery, loadMigrationInventory(migrationDirectory({
    '001_forward_recovery.sql': 'CREATE TABLE recovered (id integer);',
  })), { lockTimeoutMs: 500 });
  await recovery.end();
});

test('operator docs define immutable history, baseline trust, lock timeout, and audited recovery', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(envExample, /MIGRATION_LOCK_TIMEOUT_MS=30000/);
  assert.match(readme, /migration files are immutable/i);
  assert.match(readme, /cannot detect edits made before.*baseline/is);
  assert.match(readme, /MIGRATION_LOCK_TIMEOUT_MS/);
  assert.match(readme, /restore the exact migration file.*forward repair/is);
  assert.match(readme, /rolling back to the old runner.*ignores checksums/is);
});
