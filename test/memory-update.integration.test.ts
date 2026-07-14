import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { setPoolForTesting } from '../src/db.js';
import { memoryUpdate } from '../src/tools/update.js';
import { memoryRecall } from '../src/tools/recall.js';
import { hybridSearch } from '../src/search.js';
import type { AuthContext } from '../src/types.js';

const KEY = '22222222-2222-4222-8222-222222222222';
const OLD = '11111111-1111-4111-8111-111111111111';
const CURRENT = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const auth: AuthContext = {
  keyId: KEY,
  name: 'update-integration',
  namespaces: ['shared'],
  permissions: ['read', 'write'],
  maxAccessLevel: 'secret',
};

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

test('memory update creates durable, revisioned, immutable supersession history', { timeout: 45_000 }, async t => {
  if (!dockerAvailable()) { t.skip('Docker is unavailable'); return; }
  const container = execFileSync('docker', [
    'run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=postgres', '-p', '127.0.0.1::5432',
    process.env.MEMORY_UPDATE_TEST_IMAGE || 'pgvector/pgvector:pg16',
  ], { encoding: 'utf8' }).trim();
  t.after(() => { setPoolForTesting(null); try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch {} });

  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)!;
  const ownerUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const appUrl = `postgresql://total_recall_app:app-password@127.0.0.1:${port}/postgres`;
  const deadline = Date.now() + 30_000;
  let owner: pg.Client | undefined;
  while (Date.now() < deadline) {
    owner = new pg.Client({ connectionString: ownerUrl });
    try { await owner.connect(); break; }
    catch { await owner.end().catch(() => undefined); owner = undefined; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.ok(owner, 'PostgreSQL did not become ready');

  try {
    await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
    await owner.query("CREATE ROLE total_recall_app LOGIN PASSWORD 'app-password'");
    for (const file of readdirSync(join(process.cwd(), 'migrations')).filter(file => /^\d+_.*\.sql$/.test(file)).sort()) {
      await owner.query(readFileSync(join(process.cwd(), 'migrations', file), 'utf8'));
    }
    await owner.query(
      `INSERT INTO api_keys (id, key_hash, name, namespaces, permissions, max_access_level)
       VALUES ($1, 'update-hash', 'update-integration', ARRAY['shared'], ARRAY['read','write'], 'secret')`,
      [KEY],
    );
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, tags, metadata, access_level, client_id)
       VALUES ($1, 'User lived in Denver', 'test', 'shared', ARRAY['profile'], '{}', 'normal', $4),
              ($2, 'User lives in Austin', 'test', 'shared', ARRAY['profile'], '{}', 'normal', $4),
              ($3, 'Other current fact', 'test', 'shared', ARRAY[]::text[], '{}', 'normal', $4)`,
      [OLD, CURRENT, OTHER, KEY],
    );

    const appPool = new pg.Pool({ connectionString: appUrl });
    setPoolForTesting(appPool);
    t.after(() => appPool.end());

    const updated = await memoryUpdate({ id: CURRENT, tags: ['profile', 'location'], supersedes: OLD }, auth);
    assert.equal(updated.supersedes_id, OLD);
    assert.equal(updated.revision, 1);

    const state = await owner.query(
      `SELECT id::text, supersedes_id::text, superseded_at IS NOT NULL AS superseded, revision
       FROM memories WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[OLD, CURRENT]],
    );
    assert.deepEqual(state.rows, [
      { id: OLD, supersedes_id: null, superseded: true, revision: 1 },
      { id: CURRENT, supersedes_id: OLD, superseded: false, revision: 1 },
    ]);

    const historical = await memoryRecall({ id: OLD }, auth);
    assert.equal(historical.is_superseded, true);
    assert.equal(historical.superseded_by_id, CURRENT);
    await assert.rejects(memoryUpdate({ id: OLD, tags: [] }, auth), /not found or access denied/i);
    await assert.rejects(memoryUpdate({ id: OTHER, supersedes: OLD }, auth), /not found|already has a successor/i);

    globalThis.fetch = async () => new Response(
      JSON.stringify({ embedding: { values: Array(768).fill(0) } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const contentUpdate = await memoryUpdate({ id: OTHER, content: 'Other fact changed' }, auth);
    assert.equal(contentUpdate.content, 'Other fact changed');
    assert.equal(contentUpdate.revision, 1);
    const embedded = await owner.query(
      'SELECT embedding IS NOT NULL AS present, embedding_provider, embedding_model, embedding_dimensions FROM memories WHERE id = $1',
      [OTHER],
    );
    assert.deepEqual(embedded.rows[0], {
      present: true,
      embedding_provider: 'gemini',
      embedding_model: 'gemini-embedding-2-preview',
      embedding_dimensions: 768,
    });

    const search = await hybridSearch(
      { query: 'User', threshold: 0, limit: 10 },
      ['shared'],
      { namespaces: ['shared'], keyId: KEY },
      'secret',
    );
    const oldResult = search.find(row => row.id === OLD)!;
    const currentResult = search.find(row => row.id === CURRENT)!;
    assert.equal(oldResult.is_superseded, true);
    assert.equal(oldResult.superseded_by_id, CURRENT);
    assert.ok(currentResult.final_score > oldResult.final_score, 'history is demoted before final ordering');

    const audits = await owner.query(
      `SELECT action, memory_id::text FROM audit_log
       WHERE action IN ('memory.update', 'belief.supersede') ORDER BY action`,
    );
    assert.deepEqual(audits.rows, [
      { action: 'belief.supersede', memory_id: OLD },
      { action: 'memory.update', memory_id: CURRENT },
      { action: 'memory.update', memory_id: OTHER },
    ]);

    await owner.query('UPDATE memories SET deleted_at = NOW() WHERE id = $1', [CURRENT]);
    const afterDelete = await memoryRecall({ id: OLD }, auth);
    assert.equal(afterDelete.is_superseded, true);
    assert.equal(afterDelete.superseded_by_id, null);
    await assert.rejects(owner.query('DELETE FROM memories WHERE id = $1', [OLD]), /foreign key/i);
  } finally {
    await owner.end();
  }
});
