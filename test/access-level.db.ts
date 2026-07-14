import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { accessLevelSql } from '../src/auth.js';
import { listAgents } from '../src/agents.js';
import { dbScopeFromAuth, shutdown } from '../src/db.js';
import { memoryList } from '../src/tools/list.js';
import { memoryRecall } from '../src/tools/recall.js';
import { memoryStats } from '../src/tools/stats.js';
import { memoryStore } from '../src/tools/store.js';
import type { AuthContext } from '../src/types.js';

let containerId: string | undefined;
let databaseUrl = process.env.DATABASE_URL;

async function ensureDatabaseUrl(): Promise<string> {
  if (databaseUrl) return databaseUrl;

  const image = process.env.ACCESS_LEVEL_TEST_IMAGE || 'pgvector/pgvector:pg16';
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
  const adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/total_recall_access_test`;

  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const admin = new pg.Client({ connectionString: adminUrl });
    try {
      await admin.connect();
      await admin.query('CREATE DATABASE total_recall_access_test');
      await admin.end();
      process.env.DATABASE_URL = databaseUrl;
      return databaseUrl;
    } catch (err) {
      lastError = err;
      try {
        await admin.end();
      } catch {
        // Ignore close errors while waiting for PostgreSQL to accept connections.
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  throw lastError;
}

databaseUrl = await ensureDatabaseUrl();
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
if (!/^total_recall_access_test(?:_|$)/.test(databaseName)) {
  throw new Error(
    `Refusing to run destructive DB test against database '${databaseName}'. ` +
    'Use a disposable database named total_recall_access_test or total_recall_access_test_*.'
  );
}

const { Client } = pg;
const client = new Client({ connectionString: databaseUrl });

const namespaces = ['personal', 'work', 'projects', 'financial', 'shared'];
const auth = (maxAccessLevel: AuthContext['maxAccessLevel']): AuthContext => ({
  keyId: `key-${maxAccessLevel}`,
  name: `key-${maxAccessLevel}`,
  namespaces,
  permissions: ['read', 'write', 'admin'],
  maxAccessLevel,
});

async function setup(): Promise<Record<string, string>> {
  await client.connect();
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await client.query('DROP TABLE IF EXISTS memories');
  await client.query('DROP TABLE IF EXISTS agents');
  await client.query(`
    CREATE TABLE agents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'llm',
      model TEXT,
      runtime TEXT,
      parent_agent_id UUID,
      api_key_id TEXT,
      metadata JSONB DEFAULT '{}',
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await client.query(`CREATE UNIQUE INDEX agents_api_key_name_idx ON agents (api_key_id, name) WHERE api_key_id IS NOT NULL`);
  await client.query(`
    CREATE TABLE memories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      namespace TEXT NOT NULL DEFAULT 'shared',
      tags TEXT[] DEFAULT '{}',
      metadata JSONB DEFAULT '{}',
      access_level TEXT DEFAULT 'normal',
      client_id TEXT NOT NULL,
      agent_id UUID REFERENCES agents(id),
      document_id UUID,
      chunk_index INT,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      accessed_at TIMESTAMPTZ DEFAULT NOW(),
      access_count INT DEFAULT 0
    )
  `);

  const agentRes = await client.query(
    `INSERT INTO agents (name, type, api_key_id)
     VALUES ('agent-a', 'llm', 'key-normal'), ('agent-b', 'llm', 'key-normal')
     RETURNING id, name`
  );
  const agentA = agentRes.rows.find((r) => r.name === 'agent-a').id;
  const agentB = agentRes.rows.find((r) => r.name === 'agent-b').id;
  const documentId = '00000000-0000-0000-0000-000000000101';

  const inserted = await client.query(`
    INSERT INTO memories (content, source, namespace, tags, metadata, access_level, client_id, agent_id, document_id, chunk_index)
    VALUES
      ('normal memory', 'test', 'shared', '{}', '{}', 'normal', 'key-normal', $1, $3, 0),
      ('sensitive memory', 'test', 'shared', '{}', '{}', 'sensitive', 'key-normal', $1, NULL, NULL),
      ('secret memory', 'test', 'shared', '{}', '{}', 'secret', 'key-normal', $2, $3, 1),
      ('unknown memory', 'test', 'shared', '{}', '{}', 'classified', 'key-normal', $2, NULL, NULL),
      ('null memory', 'test', 'shared', '{}', '{}', NULL, 'key-normal', $2, NULL, NULL)
    RETURNING id, content
  `, [agentA, agentB, documentId]);

  return Object.fromEntries(inserted.rows.map((row) => [row.content, row.id]));
}

try {
  const ids = await setup();

  const normalList = await memoryList({ limit: 20, offset: 0 }, auth('normal'));
  assert.deepEqual(
    normalList.memories.map((row: any) => row.content).sort(),
    ['normal memory', 'null memory'].sort()
  );
  assert.equal(normalList.total, 2);

  const sensitiveList = await memoryList({ limit: 20, offset: 0 }, auth('sensitive'));
  assert.deepEqual(
    sensitiveList.memories.map((row: any) => row.content).sort(),
    ['normal memory', 'null memory', 'sensitive memory'].sort()
  );
  assert.equal(sensitiveList.total, 3);

  const secretList = await memoryList({ limit: 20, offset: 0 }, auth('secret'));
  assert.deepEqual(
    secretList.memories.map((row: any) => row.content).sort(),
    ['normal memory', 'null memory', 'sensitive memory', 'secret memory'].sort()
  );
  assert.equal(secretList.total, 4);

  await assert.rejects(
    () => memoryRecall({ id: ids['secret memory'] }, auth('normal')),
    /Memory not found or access denied/
  );
  assert.equal((await memoryRecall({ id: ids['secret memory'] }, auth('secret'))).content, 'secret memory');

  const normalDocument = await memoryRecall(
    { document_id: '00000000-0000-0000-0000-000000000101' },
    auth('normal')
  );
  assert.deepEqual(normalDocument.map((row: any) => row.content), ['normal memory']);

  const stats = await memoryStats({}, auth('normal'));
  assert.equal(stats.total_memories, 2);
  assert.deepEqual(stats.by_namespace, [{ namespace: 'shared', count: 2 }]);

  const normalAuth = auth('normal');
  const agents = await listAgents(normalAuth, dbScopeFromAuth(normalAuth));
  assert.deepEqual(
    agents.map((row: any) => ({ name: row.name, count: row.memory_count })).sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: 'agent-a', count: 1 }, { name: 'agent-b', count: 1 }]
  );

  const candidateRes = await client.query(
    `SELECT content FROM memories m
     WHERE namespace = ANY($1) AND ${accessLevelSql('m.access_level', '$2')}
     ORDER BY content`,
    [namespaces, 'secret']
  );
  assert.deepEqual(
    candidateRes.rows.map((row) => row.content),
    ['normal memory', 'null memory', 'secret memory', 'sensitive memory']
  );

  await assert.rejects(
    () => memoryStore({
      content: 'blocked secret',
      namespace: 'shared',
      source: 'test',
      tags: [],
      metadata: {},
      access_level: 'secret',
    }, auth('normal')),
    /Access level denied/
  );

  console.log('db-backed access-level matrix passed');
} finally {
  await shutdown();
  await client.end();
  if (containerId) {
    execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
  }
}
