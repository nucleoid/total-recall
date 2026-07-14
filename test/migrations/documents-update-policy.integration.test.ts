import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import {
  repairDocumentChunkCounts,
  type DocumentChunkCountRepairProgress,
} from '../../scripts/repair-document-chunk-counts.js';
import { provisionDatabase } from '../../scripts/provision-db.js';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const migrationsDir = join(repoRoot, 'migrations');
const migrationPath = join(migrationsDir, '016_documents_update_policy.sql');
const KEY_A = '11111111-1111-4111-8111-111111111111';
const KEY_B = '22222222-2222-4222-8222-222222222222';

let containerId: string | undefined;
let adminUrl: string | undefined;
let ownerUrl: string | undefined;
let appUrl: string | undefined;

test.after(() => {
  if (containerId) execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
});

test('documents UPDATE policy and chunk-count repair work on clean and upgraded databases', async (t) => {
  assert.equal(existsSync(migrationPath), true, 'forward migration 016 must exist');
  await ensureDatabase();

  await t.test('upgrades the legacy policy and enforces both row checks without a table-wide repair', async () => {
    await resetDatabase();
    await applyMigrationsThrough('015_memory_event_time');
    await seedDocuments();

    await applyMigration('016_documents_update_policy.sql');

    const owner = await connect(ownerUrl!);
    try {
      const policy = await owner.query<{
        command: string;
        using_expression: string | null;
        check_expression: string | null;
      }>(`
        SELECT cmd AS command,
               qual AS using_expression,
               with_check AS check_expression
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'documents'
          AND policyname = 'namespace_update'
      `);
      assert.equal(policy.rows.length, 1);
      assert.equal(policy.rows[0].command, 'UPDATE');
      assert.match(policy.rows[0].using_expression ?? '', /namespace\s*=\s*ANY\s*\((?:public\.)?app_allowed_namespaces\(\)\)/i);
      assert.match(policy.rows[0].check_expression ?? '', /namespace\s*=\s*ANY\s*\((?:public\.)?app_allowed_namespaces\(\)\)/i);

      const counts = await owner.query<{ title: string; chunk_count: number; actual_count: number }>(`
        SELECT d.title, d.chunk_count, COUNT(m.id)::int AS actual_count
        FROM documents d
        LEFT JOIN memories m ON m.document_id = d.id
        GROUP BY d.id, d.title, d.chunk_count
        ORDER BY d.title
      `);
      assert.deepEqual(counts.rows, [
        { title: 'correct nonzero', chunk_count: 2, actual_count: 2 },
        { title: 'no chunks', chunk_count: 7, actual_count: 0 },
        { title: 'over counted', chunk_count: 9, actual_count: 1 },
        { title: 'partial document', chunk_count: 99, actual_count: 2 },
        { title: 'under counted', chunk_count: 0, actual_count: 3 },
      ]);

      await applyMigration('016_documents_update_policy.sql');
      const rerunCounts = await owner.query<{ title: string; chunk_count: number }>(
        'SELECT title, chunk_count FROM documents ORDER BY title'
      );
      assert.deepEqual(rerunCounts.rows, counts.rows.map(({ title, chunk_count }) => ({ title, chunk_count })));
    } finally {
      await owner.end();
    }

    const app = await connect(appUrl!);
    try {
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.allowed_namespaces', $1, true)", [JSON.stringify(['alpha'])]);

      const allowed = await app.query(
        `UPDATE documents SET chunk_count = chunk_count WHERE title = 'under counted'`
      );
      assert.equal(allowed.rowCount, 1);

      const denied = await app.query(
        `UPDATE documents SET chunk_count = chunk_count WHERE title = 'over counted'`
      );
      assert.equal(denied.rowCount, 0);

      await assert.rejects(
        () => app.query(`UPDATE documents SET namespace = 'beta' WHERE title = 'under counted'`),
        /row-level security policy/i
      );
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });

  await t.test('repairs owned linked-memory counts in bounded resumable batches with dry-run progress', async () => {
    await resetDatabase();
    await applyMigrationsThrough('017_document_idempotency');
    await seedApiKeys();
    await seedDocuments();

    const owner = await connect(ownerUrl!);
    try {
      await owner.query('ALTER TABLE memories ADD COLUMN deleted_at TIMESTAMPTZ');
      await owner.query('UPDATE documents SET client_id = $1', [KEY_A]);
      const underCounted = await owner.query<{ id: string }>(
        `SELECT id FROM documents WHERE title = 'under counted'`
      );
      await owner.query(
        `INSERT INTO memories (content, source, namespace, client_id, document_id, chunk_index)
         VALUES ('foreign owner', 'test', 'alpha', $1, $2, 100),
                ('foreign namespace', 'test', 'beta', $3, $2, 101)`,
        [KEY_B, underCounted.rows[0].id, KEY_A]
      );
      await owner.query(`
        UPDATE memories
        SET deleted_at = NOW()
        WHERE id = (
          SELECT m.id FROM memories m
          JOIN documents d ON d.id = m.document_id
          WHERE d.title = 'correct nonzero' AND m.client_id = d.client_id::text
          ORDER BY m.id LIMIT 1
        )
      `);
    } finally {
      await owner.end();
    }

    const dryRun = await repairDocumentChunkCounts({
      connectionString: ownerUrl!,
      batchSize: 1,
      maxRows: 1,
      dryRun: true,
    });
    assert.deepEqual(dryRun, {
      updatedRows: 0,
      remainingRows: 4,
      batches: 0,
      dryRun: true,
      complete: false,
    });

    const progress: DocumentChunkCountRepairProgress[] = [];
    const first = await repairDocumentChunkCounts({
      connectionString: ownerUrl!,
      batchSize: 1,
      maxRows: 1,
      onProgress: update => progress.push(update),
    });
    assert.equal(first.updatedRows, 1);
    assert.equal(first.batches, 1);
    assert.equal(first.remainingRows, 3);
    assert.equal(first.complete, false);
    assert.deepEqual(progress, [{ batch: 1, updatedRows: 1, remainingRows: 3 }]);

    const resumed = await repairDocumentChunkCounts({
      connectionString: ownerUrl!,
      batchSize: 2,
      maxRows: 10,
    });
    assert.equal(resumed.updatedRows, 3);
    assert.equal(resumed.batches, 2);
    assert.equal(resumed.remainingRows, 0);
    assert.equal(resumed.complete, true);

    const verify = await connect(ownerUrl!);
    try {
      const counts = await verify.query<{ title: string; chunk_count: number; actual_count: number }>(`
        SELECT d.title,
               d.chunk_count,
               COUNT(m.id) FILTER (
                 WHERE m.client_id = d.client_id::text
               )::int AS actual_count
        FROM documents d
        LEFT JOIN memories m ON m.document_id = d.id
        GROUP BY d.id, d.title, d.chunk_count
        ORDER BY d.title
      `);
      assert.deepEqual(counts.rows, [
        // Immutable ingestion cardinality includes the tombstoned physical chunk.
        { title: 'correct nonzero', chunk_count: 2, actual_count: 2 },
        { title: 'no chunks', chunk_count: 0, actual_count: 0 },
        { title: 'over counted', chunk_count: 1, actual_count: 1 },
        { title: 'partial document', chunk_count: 2, actual_count: 2 },
        { title: 'under counted', chunk_count: 4, actual_count: 4 },
      ]);
    } finally {
      await verify.end();
    }

    const retry = await repairDocumentChunkCounts({ connectionString: ownerUrl! });
    assert.deepEqual(retry, {
      updatedRows: 0,
      remainingRows: 0,
      batches: 0,
      dryRun: false,
      complete: true,
    });
  });

  await t.test('applies under a restricted migration search_path', async () => {
    await resetDatabase();
    await applyMigrationsThrough('015_memory_event_time');
    const owner = await connect(ownerUrl!);
    try {
      await owner.query('SET search_path = pg_catalog');
      await owner.query(readFileSync(migrationPath, 'utf8'));
      const policy = await owner.query<{ check_expression: string | null }>(`
        SELECT pg_get_expr(polwithcheck, polrelid) AS check_expression
        FROM pg_policy
        WHERE polrelid = 'public.documents'::regclass
          AND polname = 'namespace_update'
      `);
      assert.match(policy.rows[0].check_expression ?? '', /public\.app_allowed_namespaces/i);
    } finally {
      await owner.end();
    }
  });

  await t.test('fails visibly instead of trusting a conflicting manual policy', async () => {
    await resetDatabase();
    await applyMigrationsThrough('015_memory_event_time');
    const owner = await connect(ownerUrl!);
    try {
      await owner.query('ALTER POLICY namespace_update ON documents USING (true)');
      await assert.rejects(
        () => owner.query(readFileSync(migrationPath, 'utf8')),
        /incompatible documents UPDATE policy.*namespace_update/i
      );
    } finally {
      await owner.end();
    }
  });
});

async function ensureDatabase(): Promise<void> {
  const image = process.env.MIGRATION_TEST_IMAGE || 'pgvector/pgvector:pg16';
  containerId = execFileSync('docker', [
    'run', '--rm', '-d', '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres',
    '-p', '127.0.0.1::5432', image,
  ], { encoding: 'utf8' }).trim();
  const port = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' })
    .trim().split(':').at(-1);
  adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  ownerUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/total_recall`;
  appUrl = `postgresql://total_recall_app:total_recall_app_dev@127.0.0.1:${port}/total_recall`;

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: adminUrl });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error('PostgreSQL test container did not become ready');
}

async function resetDatabase(): Promise<void> {
  const admin = await connect(adminUrl!);
  try {
    await admin.query('DROP DATABASE IF EXISTS total_recall WITH (FORCE)');
    await admin.query('CREATE DATABASE total_recall');
  } finally {
    await admin.end();
  }
  const owner = await connect(ownerUrl!);
  try {
    await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
    await owner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await provisionDatabase(owner, {
      appPassword: decodeURIComponent(new URL(appUrl!).password),
      rotateAppPassword: false,
    });
  } finally {
    await owner.end();
  }
}

async function applyMigrationsThrough(lastVersion: string): Promise<void> {
  const files = readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql') && file.replace('.sql', '') <= lastVersion)
    .sort();
  const owner = await connect(ownerUrl!);
  try {
    for (const file of files) await owner.query(readFileSync(join(migrationsDir, file), 'utf8'));
  } finally {
    await owner.end();
  }
}

async function applyMigration(file: string): Promise<void> {
  const owner = await connect(ownerUrl!);
  try {
    await owner.query(readFileSync(join(migrationsDir, file), 'utf8'));
  } finally {
    await owner.end();
  }
}

async function seedApiKeys(): Promise<void> {
  const owner = await connect(ownerUrl!);
  try {
    await owner.query(
      `INSERT INTO api_keys (id, key_hash, name, namespaces, permissions)
       VALUES ($1, 'hash-a', 'tenant-a', ARRAY['alpha','beta'], ARRAY['read','write']),
              ($2, 'hash-b', 'tenant-b', ARRAY['alpha','beta'], ARRAY['read','write'])`,
      [KEY_A, KEY_B]
    );
  } finally {
    await owner.end();
  }
}

async function seedDocuments(): Promise<void> {
  const owner = await connect(ownerUrl!);
  try {
    const documents = await owner.query<{ id: string; title: string }>(`
      INSERT INTO documents (title, source, namespace, chunk_count)
      VALUES ('under counted', 'test', 'alpha', 0),
             ('over counted', 'test', 'beta', 9),
             ('no chunks', 'test', 'alpha', 7),
             ('partial document', 'test', 'alpha', 99),
             ('correct nonzero', 'test', 'alpha', 2)
      RETURNING id, title
    `);
    const ids = Object.fromEntries(documents.rows.map(row => [row.title, row.id]));
    for (const [title, count] of [
      ['under counted', 3],
      ['over counted', 1],
      ['partial document', 2],
      ['correct nonzero', 2],
    ] as const) {
      for (let index = 0; index < count; index += 1) {
        await owner.query(
          `INSERT INTO memories (content, source, namespace, client_id, document_id, chunk_index)
           VALUES ($1, 'test', $2, $3, $4, $5)`,
          [`${title}-${index}`, title === 'over counted' ? 'beta' : 'alpha', KEY_A, ids[title], index]
        );
      }
    }
  } finally {
    await owner.end();
  }
}

async function connect(connectionString: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}
