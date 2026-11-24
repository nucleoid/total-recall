import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { setPoolForTesting, withScopedClient } from '../src/db.js';

const KEY = '10000000-0000-4000-8000-000000000055';
const MEMORY = '20000000-0000-4000-8000-000000000055';

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

test('reflection key can lock authorized evidence but cannot update it', { timeout: 120_000 }, async t => {
  if (!dockerAvailable()) { t.skip('Docker is unavailable'); return; }
  const container = execFileSync('docker', [
    'run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=postgres', '-p', '127.0.0.1::5432',
    process.env.CONSOLIDATION_TEST_IMAGE || 'pgvector/pgvector:pg16',
  ], { encoding: 'utf8' }).trim();
  t.after(() => { try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch {} });
  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)!;
  const ownerUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const appUrl = `postgresql://total_recall_app:app-password@127.0.0.1:${port}/postgres`;
  let owner: pg.Client | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    owner = new pg.Client({ connectionString: ownerUrl });
    try { await owner.connect(); break; }
    catch { await owner.end().catch(() => undefined); owner = undefined; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(owner, 'PostgreSQL did not become ready');
  let appPool: pg.Pool | undefined;
  try {
    await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
    await owner.query("CREATE ROLE total_recall_app LOGIN PASSWORD 'app-password'");
    for (const file of readdirSync(join(process.cwd(), 'migrations')).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort()) {
      await owner.query(readFileSync(join(process.cwd(), 'migrations', file), 'utf8'));
    }
    await owner.query(`INSERT INTO api_keys
      (id, key_hash, name, namespaces, permissions, max_access_level, enabled)
      VALUES ($1::uuid, 'reflection-lock-test', 'reflection-lock-test', ARRAY['work','insights'],
        ARRAY['read','reflection'], 'secret', true)`, [KEY]);
    await owner.query(`INSERT INTO memories
      (id, content, source, namespace, tags, metadata, access_level, client_id, memory_kind, valid_from)
      VALUES ($1::uuid, 'synthetic evidence', 'test', 'work', ARRAY[]::text[], '{}'::jsonb,
        'secret', 'test-owner', 'semantic', statement_timestamp())`, [MEMORY]);
    appPool = new pg.Pool({ connectionString: appUrl, max: 2 });
    setPoolForTesting(appPool);
    const scope = { keyId: KEY, namespaces: ['work', 'insights'] };
    const locked = await withScopedClient(scope, client => client.query(
      'SELECT id FROM memories WHERE id=$1::uuid AND namespace=$2 FOR SHARE', [MEMORY, 'work']));
    assert.deepEqual(locked.rows.map(row => row.id), [MEMORY]);
    await assert.rejects(withScopedClient(scope, client => client.query(
      'UPDATE memories SET tags=tags WHERE id=$1::uuid RETURNING id', [MEMORY])),
    error => (error as { code?: string }).code === '42501');
    const unchanged = await owner.query('SELECT tags, access_level FROM memories WHERE id=$1::uuid', [MEMORY]);
    assert.deepEqual(unchanged.rows[0], { tags: [], access_level: 'secret' });
  } finally {
    setPoolForTesting(null);
    await appPool?.end().catch(() => undefined);
    await owner.end().catch(() => undefined);
  }
});
