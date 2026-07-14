import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import {
  ensureMemorySupersessionConstraints,
  finalizeMemorySupersession,
} from '../../scripts/memory-supersession-finalizer.js';
import { finalizeMemoryValidity } from '../../scripts/finalize-memory-validity.js';

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

test('memory supersession finalization validates online and repairs interrupted unique builds', { timeout: 90_000 }, async t => {
  if (!dockerAvailable()) { t.skip('Docker is unavailable'); return; }

  const container = execFileSync('docker', [
    'run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=postgres', '-p', '127.0.0.1::5432',
    process.env.MEMORY_SUPERSESSION_INDEX_TEST_IMAGE || 'pgvector/pgvector:pg16',
  ], { encoding: 'utf8' }).trim();
  t.after(() => { try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch {} });

  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' })
    .trim().split(':').at(-1)!;
  const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const owner = await connectWhenReady(connectionString);

  try {
    await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
    await owner.query("CREATE ROLE total_recall_app LOGIN PASSWORD 'test-only-password'");
    const migrationsDir = join(process.cwd(), 'migrations');
    for (const file of readdirSync(migrationsDir).filter(name => /^\d+_.*\.sql$/.test(name)).sort()) {
      await owner.query(readFileSync(join(migrationsDir, file), 'utf8'));
    }

    assert.deepEqual(await loadConstraintStates(owner), [
      { name: 'memories_supersedes_id_fkey', valid: false },
      { name: 'memories_supersedes_not_self', valid: false },
    ]);
    assert.deepEqual(await loadIndexStates(owner), []);

    const selfId = '10000000-0000-4000-8000-000000000001';
    await assert.rejects(
      owner.query(
        `INSERT INTO memories (id, content, source, namespace, client_id, supersedes_id)
         VALUES ($1, 'self', 'test', 'shared', 'test-client', $1)`,
        [selfId],
      ),
      /memories_supersedes_not_self/,
    );
    await assert.rejects(
      owner.query(
        `INSERT INTO memories (content, source, namespace, client_id, supersedes_id)
         VALUES ('bad fk', 'test', 'shared', 'test-client', $1)`,
        ['10000000-0000-4000-8000-000000000099'],
      ),
      /memories_supersedes_id_fkey/,
    );

    // VALIDATE uses a lock compatible with an ordinary writer's ROW EXCLUSIVE lock.
    const writer = new pg.Client({ connectionString });
    const validator = new pg.Client({ connectionString });
    await writer.connect();
    await validator.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('LOCK TABLE memories IN ROW EXCLUSIVE MODE');
      await validator.query("SET lock_timeout = '2s'");
      const constraints = await ensureMemorySupersessionConstraints(validator);
      assert.equal(constraints.every(row => row.constraintValid), true);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await writer.end();
      await validator.end();
    }

    const first = await finalizeMemorySupersession({ connectionString });
    assert.equal(first.constraints.every(row => row.constraintValid), true);
    assert.deepEqual(first.indexes.map(row => [row.indexName, row.created, row.indexValid]), [
      ['memories_supersedes_id_unique', true, true],
      ['memories_superseded_at_idx', true, true],
    ]);

    const retry = await finalizeMemorySupersession({ connectionString });
    assert.deepEqual(retry.indexes.map(row => [row.created, row.indexValid]), [
      [false, true],
      [false, true],
    ]);

    const predecessor = '10000000-0000-4000-8000-000000000010';
    const successorA = '10000000-0000-4000-8000-000000000011';
    const successorB = '10000000-0000-4000-8000-000000000012';
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, client_id)
       VALUES ($1, 'predecessor', 'test', 'shared', 'test-client'),
              ($2, 'successor a', 'test', 'shared', 'test-client'),
              ($3, 'successor b', 'test', 'shared', 'test-client')`,
      [predecessor, successorA, successorB],
    );
    await owner.query('UPDATE memories SET supersedes_id = $1 WHERE id = $2', [predecessor, successorA]);
    await assert.rejects(
      owner.query('UPDATE memories SET supersedes_id = $1 WHERE id = $2', [predecessor, successorB]),
      /memories_supersedes_id_unique/,
    );

    // A cancelled/failed concurrent unique build leaves an invalid same-name
    // index. The finalizer must remove it before a retry.
    await owner.query('DROP INDEX CONCURRENTLY public.memories_supersedes_id_unique');
    await owner.query('UPDATE memories SET supersedes_id = $1 WHERE id = $2', [predecessor, successorB]);
    await assert.rejects(finalizeMemorySupersession({ connectionString }), /unique|duplicate/i);
    assert.deepEqual(
      (await loadIndexStates(owner)).find(row => row.name === 'memories_supersedes_id_unique'),
      { name: 'memories_supersedes_id_unique', valid: false },
    );

    await owner.query('DELETE FROM memories WHERE id = $1', [successorB]);
    const repaired = await finalizeMemorySupersession({ connectionString });
    assert.deepEqual(repaired.indexes.map(row => [row.created, row.indexValid]), [
      [true, true],
      [false, true],
    ]);

    // Migration 026 finalization must reuse migration 025's canonical durable
    // uniqueness index instead of certifying or creating a duplicate index.
    await finalizeMemoryValidity(owner);
    await finalizeMemoryValidity(owner);
    const supersessionIndexes = await owner.query<{ name: string; unique: boolean; ready: boolean; valid: boolean; partial: boolean }>(`
      SELECT c.relname AS name, i.indisunique AS unique, i.indisready AS ready,
             i.indisvalid AS valid, i.indpred IS NOT NULL AS partial
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND i.indrelid = 'public.memories'::regclass
        AND pg_get_indexdef(i.indexrelid, 1, true) = 'supersedes_id'
    `);
    assert.deepEqual(supersessionIndexes.rows, [{
      name: 'memories_supersedes_id_unique',
      unique: true,
      ready: true,
      valid: true,
      partial: false,
    }]);
  } finally {
    await owner.end();
  }
});

async function connectWhenReady(connectionString: string): Promise<pg.Client> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString });
    try { await client.connect(); await client.query('SELECT 1'); return client; }
    catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function loadConstraintStates(client: pg.Client): Promise<Array<{ name: string; valid: boolean }>> {
  const result = await client.query<{ name: string; valid: boolean }>(`
    SELECT conname AS name, convalidated AS valid
    FROM pg_constraint
    WHERE conrelid = 'public.memories'::regclass
      AND conname IN ('memories_supersedes_not_self', 'memories_supersedes_id_fkey')
    ORDER BY conname
  `);
  return result.rows;
}

async function loadIndexStates(client: pg.Client): Promise<Array<{ name: string; valid: boolean }>> {
  const result = await client.query<{ name: string; valid: boolean }>(`
    SELECT c.relname AS name, i.indisvalid AS valid
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('memories_supersedes_id_unique', 'memories_superseded_at_idx')
    ORDER BY c.relname
  `);
  return result.rows;
}
