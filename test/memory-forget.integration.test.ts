import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { setPoolForTesting } from '../src/db.js';
import { forgetMemories } from '../src/memory-lifecycle.js';
import type { AuthContext } from '../src/types.js';

const KEY = '22222222-2222-4222-8222-222222222222';
const SHARED = '11111111-1111-4111-8111-111111111111';
const PRIVATE = '33333333-3333-4333-8333-333333333333';
const ROLLBACK = '44444444-4444-4444-8444-444444444444';

const auth: AuthContext = {
  keyId: KEY,
  name: 'forget-integration',
  namespaces: ['shared'],
  permissions: ['delete'],
  maxAccessLevel: 'secret',
};

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

test('app-role forget is RLS-scoped, audited, idempotent, and atomic on audit failure', { timeout: 45_000 }, async t => {
  if (!dockerAvailable()) { t.skip('Docker is unavailable'); return; }
  const container = execFileSync('docker', [
    'run', '--rm', '-d',
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-p', '127.0.0.1::5432',
    process.env.MEMORY_FORGET_TEST_IMAGE || 'pgvector/pgvector:pg16',
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
    const migrationDir = join(process.cwd(), 'migrations');
    for (const file of readdirSync(migrationDir).filter(file => /^\d+_.*\.sql$/.test(file)).sort()) {
      await owner.query(readFileSync(join(migrationDir, file), 'utf8'));
    }
    await owner.query(
      `INSERT INTO api_keys (id, key_hash, name, namespaces, permissions, max_access_level)
       VALUES ($1, 'integration-hash', 'forget-integration', ARRAY['shared'], ARRAY['delete'], 'secret')`,
      [KEY],
    );
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, tags, access_level, client_id)
       VALUES ($1, 'shared', 'test', 'shared', ARRAY['x'], 'normal', $4),
              ($2, 'private', 'test', 'private', ARRAY['x'], 'normal', $4),
              ($3, 'rollback', 'test', 'shared', ARRAY['x'], 'normal', $4)`,
      [SHARED, PRIVATE, ROLLBACK, KEY],
    );

    const appPool = new pg.Pool({ connectionString: appUrl });
    setPoolForTesting(appPool);
    t.after(() => appPool.end());

    const first = await forgetMemories({ ids: [SHARED, PRIVATE], reason: 'incorrect' }, auth);
    assert.deepEqual(first, { forgotten: [SHARED], count: 1 });
    assert.deepEqual(await forgetMemories({ ids: [SHARED, PRIVATE] }, auth), { forgotten: [], count: 0 });

    const state = await owner.query(
      `SELECT id::text, deleted_at IS NOT NULL AS deleted FROM memories WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[SHARED, PRIVATE]],
    );
    assert.deepEqual(state.rows, [
      { id: SHARED, deleted: true },
      { id: PRIVATE, deleted: false },
    ]);
    const audit = await owner.query(
      `SELECT action, namespace, memory_id::text, query_text, result_count
       FROM audit_log WHERE action = 'memory.forget'`,
    );
    assert.deepEqual(audit.rows, [{ action: 'memory.forget', namespace: 'shared', memory_id: SHARED, query_text: null, result_count: null }]);

    await owner.query(`CREATE FUNCTION fail_forget_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'memory.forget' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$`);
    await owner.query('CREATE TRIGGER fail_forget_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_forget_audit()');
    await assert.rejects(forgetMemories({ ids: [ROLLBACK] }, auth), /forced audit failure/);
    assert.equal((await owner.query('SELECT deleted_at IS NULL AS active FROM memories WHERE id = $1', [ROLLBACK])).rows[0].active, true);
  } finally {
    await owner.end();
  }
});
