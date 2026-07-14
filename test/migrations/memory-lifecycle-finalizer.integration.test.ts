import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import {
  ensureMemoryLifecycleConstraints,
  finalizeMemoryLifecycle,
} from '../../scripts/memory-lifecycle-finalizer.js';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('memory lifecycle finalization validates online, retries idempotently, and repairs invalid indexes', { timeout: 90_000 }, async t => {
  if (!dockerAvailable()) {
    t.skip('Docker is unavailable');
    return;
  }

  const container = execFileSync('docker', [
    'run', '--rm', '-d',
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-p', '127.0.0.1::5432',
    process.env.MEMORY_LIFECYCLE_INDEX_TEST_IMAGE || 'pgvector/pgvector:pg16',
  ], { encoding: 'utf8' }).trim();
  t.after(() => {
    try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch {}
  });

  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' })
    .trim()
    .split(':')
    .at(-1)!;
  const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const owner = await connectWhenReady(connectionString);

  try {
    await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
    await owner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await owner.query("CREATE ROLE total_recall_app LOGIN PASSWORD 'test-only-password'");

    const migrationsDir = join(process.cwd(), 'migrations');
    for (const file of readdirSync(migrationsDir).filter(name => /^\d+_.*\.sql$/.test(name)).sort()) {
      await owner.query(readFileSync(join(migrationsDir, file), 'utf8'));
    }

    assert.deepEqual(await loadIndexStates(owner), []);
    assert.deepEqual(await loadConstraintStates(owner), [
      {
        name: 'memories_deleted_by_client_id_fkey',
        valid: false,
        definition: 'FOREIGN KEY (deleted_by_client_id) REFERENCES api_keys(id) ON DELETE SET NULL NOT VALID',
      },
      {
        name: 'memories_deletion_reason_length',
        valid: false,
        definition: 'CHECK (deletion_reason IS NULL OR char_length(deletion_reason) <= 512) NOT VALID',
      },
    ]);

    await assert.rejects(
      owner.query(
        `INSERT INTO memories (content, source, namespace, client_id, deletion_reason)
         VALUES ('invalid reason', 'test', 'shared', 'test-client', $1)`,
        ['x'.repeat(513)]
      ),
      /memories_deletion_reason_length/
    );
    await assert.rejects(
      owner.query(
        `INSERT INTO memories (content, source, namespace, client_id, deleted_by_client_id)
         VALUES ('invalid deleter', 'test', 'shared', 'test-client', '11111111-1111-4111-8111-111111111111')`
      ),
      /memories_deleted_by_client_id_fkey/
    );

    // Inject a pre-validation legacy violation to prove an interrupted/failed
    // finalization commits earlier constraints and can be repaired and retried.
    await owner.query('ALTER TABLE memories DROP CONSTRAINT memories_deletion_reason_length');
    await owner.query(
      `INSERT INTO memories (content, source, namespace, client_id, deletion_reason)
       VALUES ('legacy invalid reason', 'test', 'shared', 'test-client', $1)`,
      ['x'.repeat(513)]
    );
    await owner.query(`
      ALTER TABLE memories
        ADD CONSTRAINT memories_deletion_reason_length
        CHECK (deletion_reason IS NULL OR char_length(deletion_reason) <= 512)
        NOT VALID
    `);

    await assert.rejects(
      finalizeMemoryLifecycle({ connectionString }),
      /memories_deletion_reason_length/
    );
    assert.deepEqual((await loadConstraintStates(owner)).map(row => [row.name, row.valid]), [
      ['memories_deleted_by_client_id_fkey', true],
      ['memories_deletion_reason_length', false],
    ]);
    assert.deepEqual(await loadIndexStates(owner), []);

    await owner.query(
      `UPDATE memories SET deletion_reason = NULL WHERE content = 'legacy invalid reason'`
    );

    // VALIDATE CONSTRAINT takes PostgreSQL's lower lock and remains compatible
    // with an ordinary writer's ROW EXCLUSIVE table lock.
    const writer = new pg.Client({ connectionString });
    const validator = new pg.Client({ connectionString });
    await writer.connect();
    await validator.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('LOCK TABLE memories IN ROW EXCLUSIVE MODE');
      await validator.query("SET lock_timeout = '2s'");
      const constraints = await ensureMemoryLifecycleConstraints(validator);
      assert.deepEqual(constraints.map(row => [row.validated, row.constraintValid]), [
        [false, true],
        [true, true],
      ]);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await writer.end();
      await validator.end();
    }

    const first = await finalizeMemoryLifecycle({ connectionString });
    assert.deepEqual(first.constraints.map(row => [row.validated, row.constraintValid]), [
      [false, true],
      [false, true],
    ]);
    assert.deepEqual(first.indexes.map(index => [index.indexName, index.created, index.indexValid]), [
      ['memories_active_namespace_created_idx', true, true],
      ['memories_deleted_purge_idx', true, true],
    ]);

    const retry = await finalizeMemoryLifecycle({ connectionString });
    assert.deepEqual(retry.constraints.map(row => [row.validated, row.constraintValid]), [
      [false, true],
      [false, true],
    ]);
    assert.deepEqual(retry.indexes.map(index => [index.created, index.indexValid]), [
      [false, true],
      [false, true],
    ]);

    const definitions = await loadIndexDefinitions(owner);
    assert.match(definitions.memories_active_namespace_created_idx, /\(namespace, created_at DESC\).*WHERE \(deleted_at IS NULL\)/i);
    assert.match(definitions.memories_deleted_purge_idx, /\(deleted_at, id\).*WHERE \(deleted_at IS NOT NULL\)/i);

    await owner.query(
      `INSERT INTO memories (content, source, namespace, client_id)
       VALUES ('force invalid index build', 'test', 'shared', 'test-client')`
    );
    await owner.query('DROP INDEX CONCURRENTLY public.memories_active_namespace_created_idx');
    await owner.query(`
      CREATE FUNCTION public.fail_memory_lifecycle_index(uuid) RETURNS uuid
      LANGUAGE plpgsql IMMUTABLE AS $$
      BEGIN
        RAISE EXCEPTION 'forced concurrent index failure';
      END $$
    `);
    await assert.rejects(
      owner.query(`
        CREATE INDEX CONCURRENTLY memories_active_namespace_created_idx
          ON public.memories (public.fail_memory_lifecycle_index(id))
          WHERE deleted_at IS NULL
      `),
      /forced concurrent index failure/
    );

    const invalid = await loadIndexStates(owner);
    assert.deepEqual(
      invalid.find(index => index.name === 'memories_active_namespace_created_idx'),
      { name: 'memories_active_namespace_created_idx', valid: false }
    );

    const repaired = await finalizeMemoryLifecycle({ connectionString });
    assert.deepEqual(repaired.indexes.map(index => [index.created, index.indexValid]), [
      [true, true],
      [false, true],
    ]);
    assert.equal((await loadIndexStates(owner)).every(index => index.valid), true);
  } finally {
    await owner.end();
  }
});

async function connectWhenReady(connectionString: string): Promise<pg.Client> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      await client.query('SELECT 1');
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  throw lastError;
}

async function loadConstraintStates(
  client: pg.Client
): Promise<Array<{ name: string; valid: boolean; definition: string }>> {
  const result = await client.query<{ name: string; valid: boolean; definition: string }>(`
    SELECT c.conname AS name,
           c.convalidated AS valid,
           pg_get_constraintdef(c.oid, true) AS definition
    FROM pg_constraint c
    WHERE c.conrelid = 'public.memories'::regclass
      AND c.conname IN (
        'memories_deleted_by_client_id_fkey',
        'memories_deletion_reason_length'
      )
    ORDER BY c.conname
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
      AND c.relname IN (
        'memories_active_namespace_created_idx',
        'memories_deleted_purge_idx'
      )
    ORDER BY c.relname
  `);
  return result.rows;
}

async function loadIndexDefinitions(client: pg.Client): Promise<Record<string, string>> {
  const result = await client.query<{ name: string; definition: string }>(`
    SELECT c.relname AS name, pg_get_indexdef(c.oid) AS definition
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN (
        'memories_active_namespace_created_idx',
        'memories_deleted_purge_idx'
      )
  `);
  return Object.fromEntries(result.rows.map(row => [row.name, row.definition]));
}
