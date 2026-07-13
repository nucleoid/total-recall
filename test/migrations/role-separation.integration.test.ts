import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { loadMigrationInventory, runMigrations, type MigrationFile } from '../../scripts/migrate.js';
import { provisionDatabase } from '../../scripts/provision-db.js';

const repoRoot = process.cwd();
const migrationsDir = join(repoRoot, 'migrations');

function pendingMigration(version: string, sql: string): MigrationFile {
  const bytes = Buffer.from(sql);
  return {
    file: `${version}.sql`,
    version,
    number: Number(version.slice(0, 3)),
    bytes,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    sql,
  };
}

async function connect(connectionString: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

test('standalone decay DDL is retired in favour of owner-run numbered migrations', () => {
  assert.equal(existsSync(join(repoRoot, 'scripts', 'migrate-decay.ts')), false);

  const packageJson = readFileSync(join(repoRoot, 'package.json'), 'utf8');
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  const spec = readFileSync(join(repoRoot, 'SPEC.md'), 'utf8');
  const envExample = readFileSync(join(repoRoot, '.env.example'), 'utf8');
  for (const source of [packageJson, readme, spec, envExample]) {
    assert.doesNotMatch(source, /migrate-decay|migrate:decay/i);
  }

  assert.match(readme, /before (?:reading|upgrading|changing).*migration ledger/is);
  assert.match(readme, /preflight.*current_user.*current_database/is);
  assert.match(readme, /CREATE.*schema.*public/is);
  assert.match(readme, /own.*existing.*migration-managed tables/is);
  assert.match(readme, /decay:update.*maintenance.*owner.*BYPASSRLS/is);
  assert.match(spec, /schema migrations.*MIGRATION_DATABASE_URL.*runtime.*DATABASE_URL/is);
  assert.match(envExample, /owner-only.*provision.*migrate/i);
  assert.match(envExample, /operator-only.*all-row maintenance/i);
});

test('migration preflight requires schema creation and ownership without expanding the app role', async () => {
  const image = process.env.MIGRATION_TEST_IMAGE || 'pgvector/pgvector:pg16';
  const containerId = execFileSync('docker', [
    'run', '--rm', '-d',
    '-e', 'POSTGRES_USER=postgres',
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-p', '127.0.0.1::5432',
    image,
  ], { encoding: 'utf8' }).trim();

  try {
    const portLine = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' }).trim();
    const port = portLine.split(':').at(-1);
    const adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    const ownerUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/total_recall`;
    const appUrl = `postgresql://total_recall_app:app-password@127.0.0.1:${port}/total_recall`;
    const limitedUrl = `postgresql://limited_migrator:limited-password@127.0.0.1:${port}/total_recall`;

    const deadline = Date.now() + 30_000;
    while (true) {
      const probe = new pg.Client({ connectionString: adminUrl });
      try {
        await probe.connect();
        await probe.end();
        break;
      } catch (error) {
        await probe.end().catch(() => undefined);
        if (Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }

    const admin = await connect(adminUrl);
    await admin.query('CREATE DATABASE total_recall');
    await admin.end();

    const owner = await connect(ownerUrl);
    await owner.query('CREATE EXTENSION vector');
    await owner.query('CREATE EXTENSION pgcrypto');
    await provisionDatabase(owner, { appPassword: 'app-password', rotateAppPassword: false });
    const inventory = loadMigrationInventory(migrationsDir);
    await runMigrations(owner, inventory, { lockTimeoutMs: 5_000 });
    await owner.query("CREATE ROLE limited_migrator LOGIN PASSWORD 'limited-password'");
    await owner.query('GRANT CONNECT ON DATABASE total_recall TO limited_migrator');
    await owner.query('GRANT USAGE ON SCHEMA public TO limited_migrator');
    await owner.end();

    const app = await connect(appUrl);
    await app.query("SELECT set_config('app.allowed_namespaces', 'shared', false)");
    await app.query(`
      INSERT INTO memories (content, embedding, source, namespace, client_id)
      VALUES ('runtime role remains usable', $1::vector, 'test', 'shared', 'test-client')
    `, [`[${Array.from({ length: 768 }, () => '0').join(',')}]`]);
    const search = await app.query(`
      SELECT public.calculate_relevance(relevance_base_score, decay_rate, accessed_at, access_count) AS score
      FROM memories WHERE namespace = 'shared'
    `);
    assert.equal(search.rowCount, 1);
    await assert.rejects(app.query('ALTER TABLE memories ADD COLUMN app_role_ddl integer'), /must be owner|permission denied/i);
    await assert.rejects(app.query('CREATE TABLE app_role_ddl (id integer)'), /permission denied/i);
    await app.end();

    const pending = pendingMigration('021_role_preflight_probe', 'ALTER TABLE public.memories ADD COLUMN must_not_run integer;');
    const limitedWithoutCreate = await connect(limitedUrl);
    await assert.rejects(
      runMigrations(limitedWithoutCreate, [...inventory, pending], { lockTimeoutMs: 5_000 }),
      /migration authority preflight.*limited_migrator.*schema.*CREATE/is,
    );
    await limitedWithoutCreate.end();

    const grantCreate = await connect(ownerUrl);
    await grantCreate.query('GRANT CREATE ON SCHEMA public TO limited_migrator');
    await grantCreate.end();

    const limitedWithoutOwnership = await connect(limitedUrl);
    await assert.rejects(
      runMigrations(limitedWithoutOwnership, [...inventory, pending], { lockTimeoutMs: 5_000 }),
      /migration authority preflight.*limited_migrator.*memories.*owner/is,
    );
    await limitedWithoutOwnership.end();

    const verify = await connect(ownerUrl);
    assert.equal((await verify.query("SELECT to_regclass('public.app_role_ddl') AS value")).rows[0].value, null);
    assert.equal((await verify.query("SELECT to_regclass('public.must_not_run') AS value")).rows[0].value, null);
    assert.equal((await verify.query("SELECT has_schema_privilege('total_recall_app', 'public', 'CREATE') AS value")).rows[0].value, false);
    assert.equal((await verify.query("SELECT has_table_privilege('total_recall_app', 'public.memories', 'TRUNCATE') AS value")).rows[0].value, false);
    await verify.end();

    // Defense in depth: even a dangerously misprovisioned app role must never become
    // a migration role merely because it now satisfies the capability checks.
    const unsafeProvisioning = await connect(ownerUrl);
    await unsafeProvisioning.query('GRANT CREATE ON SCHEMA public TO total_recall_app');
    await unsafeProvisioning.query(`
      DO $$
      DECLARE relation_name text;
      BEGIN
        FOREACH relation_name IN ARRAY ARRAY[
          'agents', 'api_keys', 'audit_log', 'connector_credentials',
          'connector_sync_state', 'documents', 'media_events', 'memories',
          'recall_traces', 'schema_migrations', 'sync_state'
        ] LOOP
          EXECUTE format('ALTER TABLE public.%I OWNER TO total_recall_app', relation_name);
        END LOOP;
      END
      $$
    `);
    await unsafeProvisioning.end();

    const elevatedApp = await connect(appUrl);
    await assert.rejects(
      runMigrations(elevatedApp, [...inventory, pending], { lockTimeoutMs: 5_000 }),
      /total_recall_app.*runtime role.*cannot run migrations/is,
    );
    await elevatedApp.end();

    const finalCheck = await connect(ownerUrl);
    assert.equal((await finalCheck.query("SELECT to_regclass('public.must_not_run') AS value")).rows[0].value, null);
    await finalCheck.end();
  } finally {
    execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
  }
});
