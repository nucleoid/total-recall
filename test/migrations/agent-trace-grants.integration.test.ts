import assert from 'node:assert/strict';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import pg from 'pg';
import { resolveAgent, listAgents } from '../../src/agents.js';
import { queryScoped, shutdown, type DbScope } from '../../src/db.js';
import { logTrace, listTraces } from '../../src/traces.js';
import type { AuthContext } from '../../src/types.js';

const execFile = promisify(execFileCallback);

let containerId: string | undefined;
let adminDatabaseUrl: string | undefined;
let ownerDatabaseUrl =
  process.env.TOTAL_RECALL_TEST_DATABASE_URL ??
  process.env.MIGRATION_DATABASE_URL;

let appDatabaseUrl = process.env.TOTAL_RECALL_TEST_APP_DATABASE_URL;

const skewedMigratorRole = 'issue_3_migrator';
let skewedMigratorDatabaseUrl = process.env.TOTAL_RECALL_TEST_SKEWED_MIGRATOR_DATABASE_URL;

test.after(async () => {
  if (containerId) {
    execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
  }
});

function childEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(([key, value]) => value !== undefined && !key.startsWith('='))
  ) as NodeJS.ProcessEnv;
}

async function withOwnerClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ownerDatabaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withAppClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: appDatabaseUrl });
  await client.connect();
  try {
    await client.query('SET row_security = on');
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function resetScratchDatabase(): Promise<void> {
  await ensureDatabase();
  await shutdown();

  if (adminDatabaseUrl) {
    const admin = new pg.Client({ connectionString: adminDatabaseUrl });
    await admin.connect();
    try {
      await admin.query('DROP DATABASE IF EXISTS total_recall WITH (FORCE)');
      await admin.query('CREATE DATABASE total_recall');
    } finally {
      await admin.end();
    }

    await withOwnerClient(async (client) => {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    });
    return;
  }

  await withOwnerClient(async (client) => {
    await client.query(`DROP OWNED BY ${skewedMigratorRole}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${skewedMigratorRole}`).catch(() => undefined);
    await client.query('REVOKE CONNECT ON DATABASE total_recall FROM total_recall_app').catch(() => undefined);
    await client.query('DROP OWNED BY total_recall_app').catch(() => undefined);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('DROP ROLE IF EXISTS total_recall_app');
    await client.query('CREATE SCHEMA public');
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  });
}

async function ensureDatabase(): Promise<void> {
  if (ownerDatabaseUrl && appDatabaseUrl && skewedMigratorDatabaseUrl) {
    return;
  }

  if (!containerId) {
    const image = process.env.MIGRATION_TEST_IMAGE || 'pgvector/pgvector:pg16';
    containerId = execFileSync('docker', [
      'run',
      '--rm',
      '-d',
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-p',
      '127.0.0.1::5432',
      image,
    ], { encoding: 'utf8' }).trim();

    const portLine = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' }).trim();
    const port = portLine.split(':').at(-1);
    adminDatabaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    ownerDatabaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/total_recall`;
    appDatabaseUrl = `postgresql://total_recall_app:total_recall_app_dev@127.0.0.1:${port}/total_recall`;
    skewedMigratorDatabaseUrl = `postgresql://${skewedMigratorRole}:issue_3_migrator_dev@127.0.0.1:${port}/total_recall`;
  }

  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: adminDatabaseUrl ?? ownerDatabaseUrl });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastError = err;
      try {
        await client.end();
      } catch {
        // Ignore close errors while waiting for PostgreSQL to accept connections.
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  throw lastError;
}

async function runMigrations(overrides: NodeJS.ProcessEnv = {}): Promise<void> {
  await execFile(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
    cwd: process.cwd(),
    env: childEnv({
      DATABASE_URL: appDatabaseUrl,
      MIGRATION_DATABASE_URL: ownerDatabaseUrl,
      ...overrides,
    }),
  });
}

async function runMigrationsExpectFailure(overrides: NodeJS.ProcessEnv): Promise<string> {
  try {
    await runMigrations(overrides);
  } catch (err: any) {
    return `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
  }
  assert.fail('expected migration command to fail');
}

async function applyMigrationsBefore008(): Promise<void> {
  await withOwnerClient(async (client) => {
    const migrationsDir = join(process.cwd(), 'migrations');
    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql') && file < '008_agent_trace_grants.sql')
      .sort();

    for (const file of files) {
      const version = file.replace('.sql', '');
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  });
}

async function createSkewedMigratorRole(): Promise<void> {
  await withOwnerClient(async (client) => {
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${skewedMigratorRole}') THEN
          CREATE ROLE ${skewedMigratorRole} LOGIN PASSWORD 'issue_3_migrator_dev';
        END IF;
      END $$;
    `);
    await client.query(`GRANT CONNECT ON DATABASE total_recall TO ${skewedMigratorRole}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${skewedMigratorRole}`);
    await client.query(`GRANT SELECT, INSERT ON schema_migrations TO ${skewedMigratorRole}`);
  });
}

async function privilegeMap(): Promise<Record<string, boolean>> {
  return withAppClient(async (client) => {
    const result = await client.query<Record<string, boolean>>(`
      SELECT
        has_table_privilege(current_user, 'agents', 'SELECT') AS "agentsSelect",
        has_table_privilege(current_user, 'agents', 'INSERT') AS "agentsInsert",
        has_table_privilege(current_user, 'agents', 'UPDATE') AS "agentsUpdate",
        has_table_privilege(current_user, 'agents', 'DELETE') AS "agentsDelete",
        has_table_privilege(current_user, 'agents', 'TRUNCATE') AS "agentsTruncate",
        has_table_privilege(current_user, 'recall_traces', 'SELECT') AS "tracesSelect",
        has_table_privilege(current_user, 'recall_traces', 'INSERT') AS "tracesInsert",
        has_table_privilege(current_user, 'recall_traces', 'UPDATE') AS "tracesUpdate",
        has_table_privilege(current_user, 'recall_traces', 'DELETE') AS "tracesDelete",
        has_table_privilege(current_user, 'recall_traces', 'TRUNCATE') AS "tracesTruncate"
    `);
    return result.rows[0];
  });
}

async function assertRequiredPrivileges(): Promise<void> {
  assert.deepEqual(await privilegeMap(), {
    agentsSelect: true,
    agentsInsert: true,
    agentsUpdate: true,
    agentsDelete: false,
    agentsTruncate: false,
    tracesSelect: true,
    tracesInsert: true,
    tracesUpdate: false,
    tracesDelete: false,
    tracesTruncate: false,
  });
}

async function assertRuntimeRoleIsScoped(): Promise<void> {
  await withAppClient(async (client) => {
    const settings = await client.query<{ row_security: string; current_user: string; bypasses_rls: boolean }>(`
      SELECT
        current_setting('row_security') AS row_security,
        current_user,
        (rolsuper OR rolbypassrls) AS bypasses_rls
      FROM pg_roles
      WHERE rolname = current_user
    `);
    assert.equal(settings.rows[0].row_security, 'on');
    assert.equal(settings.rows[0].current_user, 'total_recall_app');
    assert.equal(settings.rows[0].bypasses_rls, false);
  });
}

const ordinaryAuth: AuthContext = {
  keyId: '00000000-0000-4000-8000-000000000001',
  name: 'ordinary',
  namespaces: ['shared'],
  permissions: ['read', 'write'],
};

const adminAuth: AuthContext = {
  keyId: '00000000-0000-4000-8000-000000000002',
  name: 'admin',
  namespaces: ['shared'],
  permissions: ['read', 'write', 'admin'],
};

async function seedRuntimeApiKeys(): Promise<void> {
  await withOwnerClient(async (client) => {
    await client.query(
      `INSERT INTO api_keys (id, key_hash, name, namespaces, permissions)
       VALUES
         ($1, 'issue-3-ordinary-hash', $2, $3, $4),
         ($5, 'issue-3-admin-hash', $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         namespaces = EXCLUDED.namespaces,
         permissions = EXCLUDED.permissions`,
      [
        ordinaryAuth.keyId,
        ordinaryAuth.name,
        ordinaryAuth.namespaces,
        ordinaryAuth.permissions,
        adminAuth.keyId,
        adminAuth.name,
        adminAuth.namespaces,
        adminAuth.permissions,
      ]
    );
  });
}

async function exerciseRuntimePaths(label: string): Promise<void> {
  process.env.DATABASE_URL = appDatabaseUrl;
  await seedRuntimeApiKeys();
  const ordinaryScope: DbScope = { namespaces: ordinaryAuth.namespaces, keyId: ordinaryAuth.keyId };
  const adminScope: DbScope = { namespaces: adminAuth.namespaces, keyId: adminAuth.keyId };

  const agentName = `issue-3-${label}`;
  const agentId = await resolveAgent(agentName, 'llm', 'test-model', 'node-test', undefined, ordinaryAuth.keyId, ordinaryScope);
  assert.match(agentId, /^[0-9a-f-]{36}$/);

  const updatedAgentId = await resolveAgent(agentName, 'llm', 'updated-model', 'node-test', undefined, ordinaryAuth.keyId, ordinaryScope);
  assert.equal(updatedAgentId, agentId);

  const visibleContent = `visible-${label}`;
  const hiddenContent = `hidden-${label}`;
  await queryScoped(
    ordinaryScope,
    `INSERT INTO memories (content, source, namespace, client_id, agent_id)
     VALUES ($1, 'integration-test', 'shared', 'issue-3-client', $2)`,
    [visibleContent, agentId]
  );
  await withOwnerClient(async (client) => {
    await client.query(
      `INSERT INTO memories (content, source, namespace, client_id, agent_id)
       VALUES ($1, 'integration-test', 'private', 'issue-3-client', $2)`,
      [hiddenContent, agentId]
    );
  });

  const visible = await queryScoped<{ id: string; content: string }>(
    ordinaryScope,
    `SELECT id, content FROM memories WHERE source = 'integration-test' ORDER BY content`
  );
  assert.deepEqual(visible.rows.map((row) => row.content), [visibleContent]);

  await logTrace({
    sessionId: `session-${label}`,
    agentId,
    clientId: 'issue-3-client',
    queryText: `find ${label}`,
    memoryIds: visible.rows.map((row: any) => row.id),
    resultCount: visible.rows.length,
  }, ordinaryScope);

  await assert.rejects(() => listAgents(ordinaryAuth, ordinaryScope), /requires 'admin'/);
  await assert.rejects(() => listTraces(ordinaryAuth, ordinaryScope, 10, 0, agentId, `session-${label}`), /requires 'admin'/);

  const agents = await listAgents(adminAuth, adminScope);
  assert.equal(agents.some((agent) => agent.id === agentId), true);

  const traces = await listTraces(adminAuth, adminScope, 10, 0, agentId, `session-${label}`);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].query_text, `find ${label}`);

  await shutdown();
}

test('migrations use owner credentials while runtime DATABASE_URL stays app-scoped', async () => {
  await resetScratchDatabase();

  await runMigrations();

  await withOwnerClient(async (client) => {
    const migrations = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM schema_migrations');
    assert.equal(Number(migrations.rows[0].count) > 0, true);
  });
});

test('agent and trace privileges are repaired on clean installs and already-applied 005 upgrades', async () => {
  await shutdown();
  await resetScratchDatabase();
  await runMigrations();
  await assertRequiredPrivileges();
  await assertRuntimeRoleIsScoped();
  await exerciseRuntimePaths('clean');

  await resetScratchDatabase();
  await applyMigrationsBefore008();
  const beforeRepair = await privilegeMap();
  assert.equal(beforeRepair.agentsSelect, false);
  assert.equal(beforeRepair.tracesInsert, false);

  await runMigrations();
  await assertRequiredPrivileges();
  await assertRuntimeRoleIsScoped();

  await withOwnerClient(async (client) => {
    const applied = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM schema_migrations
       WHERE version = '008_agent_trace_grants'`
    );
    assert.equal(applied.rows[0].count, '1');
  });
  await exerciseRuntimePaths('upgrade');
});

test('migration rejects runtime and non-owner roles before grant repair', async () => {
  await resetScratchDatabase();
  await applyMigrationsBefore008();

  const appRoleFailure = await runMigrationsExpectFailure({
    DATABASE_URL: appDatabaseUrl,
    MIGRATION_DATABASE_URL: undefined,
  });
  assert.match(appRoleFailure, /total_recall_app is the runtime role and cannot run migrations/);
  assert.match(appRoleFailure, /Set MIGRATION_DATABASE_URL/);

  await resetScratchDatabase();
  await applyMigrationsBefore008();
  await createSkewedMigratorRole();

  const ownerSkewFailure = await runMigrationsExpectFailure({
    DATABASE_URL: appDatabaseUrl,
    MIGRATION_DATABASE_URL: skewedMigratorDatabaseUrl,
  });
  assert.match(ownerSkewFailure, /008_agent_trace_grants/);
  assert.match(ownerSkewFailure, /cannot grant required privileges/);
  assert.match(ownerSkewFailure, /original schema owner or a superuser/);

  await withOwnerClient(async (client) => {
    const applied = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM schema_migrations
       WHERE version = '008_agent_trace_grants'`
    );
    assert.equal(applied.rows[0].count, '0');
  });
});

test('documented environment separates owner migrations from runtime app role', async () => {
  const envExample = await readFile(join(process.cwd(), '.env.example'), 'utf8');
  const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8');

  assert.match(envExample, /^MIGRATION_DATABASE_URL=postgresql:\/\/total_recall:/m);
  assert.match(envExample, /^DATABASE_URL=postgresql:\/\/total_recall_app:/m);
  assert.match(readme, /MIGRATION_DATABASE_URL/);
  assert.match(readme, /fallback only works when DATABASE_URL is an owner-capable/);
  assert.match(readme, /DATABASE_URL=postgresql:\/\/total_recall_app:/);
  assert.match(readme, /Agent and trace listing endpoints are admin-only/);
});
