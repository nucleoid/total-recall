import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import pg from 'pg';
import { resolveAgent, listAgents } from '../../src/agents.js';
import { query, setNamespaceContext, shutdown } from '../../src/db.js';
import { logTrace, listTraces } from '../../src/traces.js';
import type { AuthContext } from '../../src/types.js';

const execFile = promisify(execFileCallback);

const ownerDatabaseUrl =
  process.env.TOTAL_RECALL_TEST_DATABASE_URL ??
  process.env.MIGRATION_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:55432/total_recall';

const appDatabaseUrl =
  process.env.TOTAL_RECALL_TEST_APP_DATABASE_URL ??
  'postgresql://total_recall_app:total_recall_app_dev@localhost:55432/total_recall';

const skewedMigratorRole = 'issue_3_migrator';
const skewedMigratorDatabaseUrl =
  process.env.TOTAL_RECALL_TEST_SKEWED_MIGRATOR_DATABASE_URL ??
  `postgresql://${skewedMigratorRole}:issue_3_migrator_dev@localhost:55432/total_recall`;

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
  await withOwnerClient(async (client) => {
    await client.query(`DROP OWNED BY ${skewedMigratorRole}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${skewedMigratorRole}`).catch(() => undefined);
    await client.query('REVOKE CONNECT ON DATABASE total_recall FROM total_recall_app').catch(() => undefined);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query('DROP OWNED BY total_recall_app').catch(() => undefined);
    await client.query('DROP ROLE IF EXISTS total_recall_app');
  });
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
  keyId: 'ordinary-key',
  name: 'ordinary',
  namespaces: ['shared'],
  permissions: ['read', 'write'],
};

const adminAuth: AuthContext = {
  keyId: 'admin-key',
  name: 'admin',
  namespaces: ['shared'],
  permissions: ['read', 'write', 'admin'],
};

async function exerciseRuntimePaths(label: string): Promise<void> {
  process.env.DATABASE_URL = appDatabaseUrl;
  await setNamespaceContext(['shared']);

  const agentName = `issue-3-${label}`;
  const agentId = await resolveAgent(agentName, 'llm', 'test-model', 'node-test');
  assert.match(agentId, /^[0-9a-f-]{36}$/);

  const updatedAgentId = await resolveAgent(agentName, 'llm', 'updated-model', 'node-test');
  assert.equal(updatedAgentId, agentId);

  const visibleContent = `visible-${label}`;
  const hiddenContent = `hidden-${label}`;
  await query(
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

  const visible = await query<{ id: string; content: string }>(
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
  });

  await assert.rejects(() => listAgents(ordinaryAuth), /requires 'admin'/);
  await assert.rejects(() => listTraces(ordinaryAuth, 10, 0, agentId, `session-${label}`), /requires 'admin'/);

  const agents = await listAgents(adminAuth);
  assert.equal(agents.some((agent) => agent.id === agentId), true);

  const traces = await listTraces(adminAuth, 10, 0, agentId, `session-${label}`);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].query_text, `find ${label}`);

  await shutdown();
  await setNamespaceContext([]);
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
