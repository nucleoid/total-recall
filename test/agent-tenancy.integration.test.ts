import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { AuthContext } from '../src/types.js';
import { provisionDatabase } from '../scripts/provision-db.js';

type AgentsModule = typeof import('../src/agents.js') & {
  upsertSystemAgent?: (params: {
    name: string;
    type?: string;
    model?: string;
    runtime?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<import('../src/types.js').Agent>;
};

const image = process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16';
let containerId: string | null = null;
let adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
let appUrl = '';
let agents: AgentsModule;
let db: typeof import('../src/db.js');

function authForKey(keyId: string, name = keyId): AuthContext {
  return {
    keyId,
    name,
    namespaces: ['shared', 'media'],
    permissions: ['read', 'write'],
    maxAccessLevel: 'secret',
  };
}

function scopeForKey(keyId: string): import('../src/db.js').DbScope {
  return {
    keyId,
    namespaces: ['shared', 'media'],
  };
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

async function waitForPostgres(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

async function adminQuery<T extends pg.QueryResultRow = any>(sql: string, params?: unknown[]) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await client.query<T>(sql, params);
  } finally {
    await client.end();
  }
}

async function applyMigrationFile(client: pg.Client, file: string): Promise<void> {
  const sql = readFileSync(join('migrations', file), 'utf8');
  await client.query(sql);
}

async function resetDatabase(options: {
  seedBeforeTenantMigration?: (client: pg.Client) => Promise<void>;
} = {}): Promise<void> {
  await db?.shutdown();

  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await provisionDatabase(client, {
      appPassword: decodeURIComponent(new URL(appUrl).password),
      rotateAppPassword: false,
    });

    const files = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
    const tenantMigration = '010_tenant_scoped_agents.sql';
    const beforeTenant = files.filter((f) => f !== tenantMigration);

    for (const file of beforeTenant) {
      await applyMigrationFile(client, file);
    }

    if (options.seedBeforeTenantMigration) {
      await options.seedBeforeTenantMigration(client);
    }

    if (files.includes(tenantMigration)) {
      await applyMigrationFile(client, tenantMigration);
    }
  } finally {
    await client.end();
  }
}

async function createApiKey(name: string): Promise<string> {
  const res = await adminQuery<{ id: string }>(
    `INSERT INTO api_keys (key_hash, name, namespaces, permissions)
     VALUES ($1, $2, '{shared,media}', '{read,write}')
     RETURNING id`,
    [`hash-${name}-${randomUUID()}`, name]
  );
  return res.rows[0].id;
}

before(async () => {
  if (!adminUrl) {
    containerId = docker([
      'run',
      '-d',
      '--rm',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      'POSTGRES_DB=total_recall',
      '-p',
      '127.0.0.1::5432',
      image,
    ]);
    const port = docker(['port', containerId, '5432/tcp']).split(':').pop();
    adminUrl = `postgres://postgres:postgres@127.0.0.1:${port}/total_recall`;
  }

  await waitForPostgres(adminUrl);
  appUrl = adminUrl.replace(/postgres:\/\/[^:]+:[^@]+@/, 'postgres://total_recall_app:total_recall_app_dev@');
  process.env.DATABASE_URL = adminUrl;
  agents = (await import('../src/agents.js')) as AgentsModule;
  db = await import('../src/db.js');
});

beforeEach(async () => {
  await resetDatabase();
});

after(async () => {
  await db?.shutdown();
  if (containerId) {
    docker(['stop', containerId]);
  }
});

test('identical agent names under different api keys are distinct and isolated', async () => {
  const keyA = await createApiKey('key-a');
  const keyB = await createApiKey('key-b');
  const scopeA = scopeForKey(keyA);
  const scopeB = scopeForKey(keyB);

  const agentA = await agents.upsertAgent({
    name: 'codex',
    type: 'llm',
    model: 'gpt-5.5',
    api_key_id: keyA,
    metadata: { owner: 'a' },
  }, scopeA);
  const agentB = await agents.upsertAgent({
    name: 'codex',
    type: 'llm',
    model: 'claude-opus-4-8',
    api_key_id: keyB,
    metadata: { owner: 'b' },
  }, scopeB);

  assert.notEqual(agentA.id, agentB.id);
  assert.equal((await agents.getAgentByName('codex', scopeA))?.model, 'gpt-5.5');
  assert.equal((await agents.getAgentByName('codex', scopeB))?.model, 'claude-opus-4-8');

  const listA = await agents.listAgents(authForKey(keyA), scopeA);
  const listB = await agents.listAgents(authForKey(keyB), scopeB);
  assert.deepEqual(listA.map((row) => row.id), [agentA.id]);
  assert.deepEqual(listB.map((row) => row.id), [agentB.id]);
});

test('concurrent same-key upserts converge to one owned row and merge metadata', async () => {
  const keyId = await createApiKey('key-a');
  const scope = scopeForKey(keyId);

  const rows = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      agents.upsertAgent({
        name: 'parallel-agent',
        type: 'llm',
        api_key_id: keyId,
        metadata: { [`run_${i}`]: i },
      }, scope)
    )
  );

  assert.equal(new Set(rows.map((row) => row.id)).size, 1);
  const stored = await agents.getAgentByName('parallel-agent', scope);
  assert.equal(stored?.api_key_id, keyId);
  for (let i = 0; i < 8; i++) {
    assert.equal(stored?.metadata[`run_${i}`], i);
  }
});

test('parent lookup is scoped to the same api key', async () => {
  const keyA = await createApiKey('key-a');
  const keyB = await createApiKey('key-b');
  const scopeA = scopeForKey(keyA);
  const scopeB = scopeForKey(keyB);

  const parentA = await agents.upsertAgent({ name: 'parent', type: 'llm', api_key_id: keyA }, scopeA);
  const childBWithoutParent = await agents.upsertAgent({
    name: 'child-without-local-parent',
    type: 'llm',
    parent_agent_name: 'parent',
    api_key_id: keyB,
  }, scopeB);
  assert.equal(childBWithoutParent.parent_agent_id, null);

  const parentB = await agents.upsertAgent({ name: 'parent', type: 'llm', api_key_id: keyB }, scopeB);
  const childB = await agents.upsertAgent({
    name: 'child-with-local-parent',
    type: 'llm',
    parent_agent_name: 'parent',
    api_key_id: keyB,
  }, scopeB);

  assert.equal(parentA.api_key_id, keyA);
  assert.equal(childB.parent_agent_id, parentB.id);
});

test('trusted null-owner system upsert is idempotent and cannot be claimed by authenticated upsert', async () => {
  assert.equal(typeof agents.upsertSystemAgent, 'function');
  const keyId = await createApiKey('key-a');

  const systemRows = await Promise.all(
    Array.from({ length: 5 }, () =>
      agents.upsertSystemAgent!({ name: 'file-watcher', type: 'system', runtime: 'total-recall-watcher' })
    )
  );
  assert.equal(new Set(systemRows.map((row) => row.id)).size, 1);
  assert.equal(systemRows[0].api_key_id, null);

  const owned = await agents.upsertAgent(
    { name: 'file-watcher', type: 'system', api_key_id: keyId },
    scopeForKey(keyId)
  );
  assert.notEqual(owned.id, systemRows[0].id);

  const res = await adminQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM agents WHERE name = 'file-watcher' AND api_key_id IS NULL`
  );
  assert.equal(res.rows[0].count, '1');
});

test('tenant migration preserves existing ids and foreign-key references', async () => {
  if (!existsSync(join('migrations', '010_tenant_scoped_agents.sql'))) {
    assert.fail('tenant-scoped agents migration is missing');
  }

  let ids!: {
    apiKeyId: string;
    agentId: string;
    memoryId: string;
    traceId: string;
    auditId: string;
    mediaId: string;
  };

  await resetDatabase({
    seedBeforeTenantMigration: async (client) => {
      const key = await client.query<{ id: string }>(
        `INSERT INTO api_keys (key_hash, name, namespaces, permissions)
         VALUES ('hash-preserve', 'preserve', '{shared,media}', '{read,write}')
         RETURNING id`
      );
      const agent = await client.query<{ id: string }>(
        `INSERT INTO agents (name, type, api_key_id) VALUES ('preserved-agent', 'llm', $1) RETURNING id`,
        [key.rows[0].id]
      );
      const memory = await client.query<{ id: string }>(
        `INSERT INTO memories (content, source, namespace, client_id, agent_id)
         VALUES ('hello', 'test', 'shared', 'client', $1) RETURNING id`,
        [agent.rows[0].id]
      );
      const trace = await client.query<{ id: string }>(
        `INSERT INTO recall_traces (agent_id, query_text) VALUES ($1, 'hello') RETURNING id`,
        [agent.rows[0].id]
      );
      const audit = await client.query<{ id: string }>(
        `INSERT INTO audit_log (client_id, action, agent_id) VALUES ('client', 'test', $1) RETURNING id`,
        [agent.rows[0].id]
      );
      const media = await client.query<{ id: string }>(
        `INSERT INTO media_events (service, service_id, event_type, title, played_at, client_id, agent_id)
         VALUES ('test', '1', 'play', 'Song', NOW(), $1, $2) RETURNING id`,
        [key.rows[0].id, agent.rows[0].id]
      );
      ids = {
        apiKeyId: key.rows[0].id,
        agentId: agent.rows[0].id,
        memoryId: memory.rows[0].id,
        traceId: trace.rows[0].id,
        auditId: audit.rows[0].id,
        mediaId: media.rows[0].id,
      };
    },
  });

  const res = await adminQuery(
    `SELECT
       (SELECT agent_id FROM memories WHERE id = $1) AS memory_agent_id,
       (SELECT agent_id FROM recall_traces WHERE id = $2) AS trace_agent_id,
       (SELECT agent_id FROM audit_log WHERE id = $3) AS audit_agent_id,
       (SELECT agent_id FROM media_events WHERE id = $4) AS media_agent_id,
       (SELECT api_key_id FROM agents WHERE id = $5) AS agent_api_key_id`,
    [ids.memoryId, ids.traceId, ids.auditId, ids.mediaId, ids.agentId]
  );

  assert.deepEqual(res.rows[0], {
    memory_agent_id: ids.agentId,
    trace_agent_id: ids.agentId,
    audit_agent_id: ids.agentId,
    media_agent_id: ids.agentId,
    agent_api_key_id: ids.apiKeyId,
  });
});

test('tenant migration replaces the old full composite agent index on upgraded databases', async () => {
  await resetDatabase({
    seedBeforeTenantMigration: async (client) => {
      await client.query('CREATE UNIQUE INDEX idx_agents_api_key_name_unique ON agents (api_key_id, name)');
    },
  });

  const indexes = await adminQuery<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'agents'
     ORDER BY indexname`
  );

  assert.equal(indexes.rows.some((row) => row.indexname === 'idx_agents_api_key_name_unique'), false);
  assert.equal(
    indexes.rows.some((row) =>
      row.indexname === 'agents_api_key_name_owned_key' &&
      row.indexdef.includes('WHERE (api_key_id IS NOT NULL)')
    ),
    true
  );
  assert.equal(
    indexes.rows.some((row) =>
      row.indexname === 'agents_name_system_key' &&
      row.indexdef.includes('WHERE (api_key_id IS NULL)')
    ),
    true
  );
});

test('non-admin app role cannot list trusted null-owner system agents through RLS', async () => {
  const keyId = await createApiKey('key-a');
  await agents.upsertSystemAgent!({ name: 'file-watcher', type: 'system', runtime: 'total-recall-watcher' });

  const client = new pg.Client({ connectionString: appUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_key_id', $1, true)", [keyId]);
    await client.query("SELECT set_config('app.current_key_is_admin', 'false', true)");
    const res = await client.query(`SELECT id FROM agents WHERE name = 'file-watcher'`);
    assert.equal(res.rowCount, 0);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
});

test('app role can create trusted null-owner system agents through the security definer function', async () => {
  const client = new pg.Client({ connectionString: appUrl });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT id, name, api_key_id
       FROM upsert_system_agent('runtime-watcher', 'system', NULL, 'total-recall-watcher', '{}'::jsonb)`
    );
    assert.equal(res.rowCount, 1);
    assert.equal(res.rows[0].name, 'runtime-watcher');
    assert.equal(res.rows[0].api_key_id, null);
  } finally {
    await client.end();
  }

  const count = await adminQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM agents
     WHERE name = 'runtime-watcher' AND api_key_id IS NULL`
  );
  assert.equal(count.rows[0].count, '1');
});

test('app role can use tenant-scoped agent indexes', async () => {
  if (!existsSync(join('migrations', '010_tenant_scoped_agents.sql'))) {
    assert.fail('tenant-scoped agents migration is missing');
  }
  const keyId = await createApiKey('app-role');
  const client = new pg.Client({ connectionString: appUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_key_id', $1, true)", [keyId]);
    await client.query("SELECT set_config('app.current_key_is_admin', 'false', true)");
    const res = await client.query(
      `INSERT INTO agents (name, type, api_key_id)
       VALUES ('app-owned-agent', 'llm', $1)
       ON CONFLICT (api_key_id, name) WHERE api_key_id IS NOT NULL
       DO UPDATE SET last_seen_at = NOW()
       RETURNING id, api_key_id`,
      [keyId]
    );
    assert.equal(res.rows[0].api_key_id, keyId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
});
