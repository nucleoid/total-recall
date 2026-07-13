import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { setPoolForTesting, shutdown } from '../../src/db.js';
import type { AuthContext } from '../../src/types.js';
import { createDocumentIdempotencyIndex } from '../../scripts/document-idempotency-index.js';
import { provisionDatabase } from '../../scripts/provision-db.js';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const migrationsDir = join(repoRoot, 'migrations');
const zeroVector = `[${Array.from({ length: 768 }, () => '0').join(',')}]`;
const KEY_A = '11111111-1111-4111-8111-111111111111';
const KEY_B = '22222222-2222-4222-8222-222222222222';

let containerId: string | undefined;
let adminUrl: string | undefined;
let ownerUrl = process.env.MIGRATION_TEST_DATABASE_URL;
let appUrl = process.env.MIGRATION_TEST_APP_DATABASE_URL;

const auth = (keyId: string, namespaces = ['alpha', 'beta']): AuthContext => ({
  keyId,
  name: keyId === KEY_A ? 'tenant-a' : 'tenant-b',
  namespaces,
  permissions: ['read', 'write'],
  maxAccessLevel: 'normal',
});

test.after(async () => {
  await shutdown();
  if (containerId) execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
});

test('real PostgreSQL enforces document idempotency migration, RLS, concurrency, CHECK, rollback, and completeness', async (t) => {
  await ensureDatabase();
  await resetDatabase();
  await applyMigrationsThrough('017_document_idempotency');
  await seedApiKeys();

  await t.test('CHECK accepts only the canonical versioned lowercase SHA-256 format', async () => {
    const owner = await ownerClient();
    try {
      for (const invalid of ['a'.repeat(64), `sha256:v1:${'A'.repeat(64)}`, 'sha256:v2:' + 'a'.repeat(64)]) {
        await assert.rejects(
          () => owner.query(
            `INSERT INTO documents (title, source, namespace, client_id, idempotency_key, request_hash)
             VALUES ('invalid', 'test', 'alpha', $1, $2, $3)`,
            [KEY_A, `invalid-${invalid.slice(0, 8)}`, invalid]
          ),
          /documents_request_hash_format_chk/
        );
      }
      await owner.query(
        `INSERT INTO documents (title, source, namespace, client_id, idempotency_key, request_hash)
         VALUES ('valid', 'test', 'alpha', $1, 'valid-hash', $2)`,
        [KEY_A, `sha256:v1:${'a'.repeat(64)}`]
      );
    } finally {
      await owner.end();
    }
  });

  await t.test('online operation builds a valid namespace-scoped partial unique index', async () => {
    const first = await createDocumentIdempotencyIndex({ connectionString: ownerUrl! });
    assert.equal(first.indexExists, true);
    assert.equal(first.indexValid, true);
    const retry = await createDocumentIdempotencyIndex({ connectionString: ownerUrl! });
    assert.equal(retry.created, false);
    assert.equal(retry.indexValid, true);
  });

  process.env.GEMINI_API_KEY = '';
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ embeddings: [[...Array.from({ length: 768 }, () => 0)]] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )) as typeof fetch;

  const appPool = new pg.Pool({ connectionString: appUrl, max: 8 });
  setPoolForTesting(appPool);
  const { memoryStoreDocument, StoreDocumentConflictError } = await import('../../src/tools/store-document.js');
  const { memoryStore, storeSchema } = await import('../../src/tools/store.js');

  await t.test('memory keyed reuse moves authorized namespaces and normalizes hidden RLS conflicts', async () => {
    const elevatedAuth = { ...auth(KEY_A), maxAccessLevel: 'secret' as const };
    const first = await memoryStore(storeSchema.parse({
      content: 'before move', namespace: 'alpha', access_level: 'normal', idempotency_key: 'memory-move',
    }), elevatedAuth);
    const moved = await memoryStore(storeSchema.parse({
      content: 'after move', namespace: 'beta', access_level: 'sensitive', idempotency_key: 'memory-move',
    }), elevatedAuth);
    assert.equal(moved.id, first.id);
    assert.equal(moved.idempotency_key_honored, true);

    const owner = await ownerClient();
    try {
      const row = await owner.query<{ namespace: string; access_level: string; created_at: Date }>(
        'SELECT namespace, access_level, created_at FROM memories WHERE id = $1',
        [first.id]
      );
      assert.deepEqual(
        { namespace: row.rows[0].namespace, access_level: row.rows[0].access_level },
        { namespace: 'beta', access_level: 'sensitive' }
      );

      await memoryStore(storeSchema.parse({
        content: 'hidden original', namespace: 'beta', idempotency_key: 'memory-hidden',
      }), elevatedAuth);
      await assert.rejects(
        () => memoryStore(storeSchema.parse({
          content: 'probe', namespace: 'alpha', idempotency_key: 'memory-hidden',
        }), { ...elevatedAuth, namespaces: ['alpha'] }),
        (error: unknown) => error instanceof Error && error.message === 'Access denied to existing idempotent memory'
      );
    } finally {
      await owner.end();
    }
  });

  await t.test('same key is isolated by namespace and owner while RLS denies ungranted namespaces', async () => {
    const base = {
      title: 'scoped', content: 'one chunk', tags: [], source: 'test', idempotency_key: 'scope-key',
    };
    const alpha = await memoryStoreDocument({ ...base, namespace: 'alpha' }, auth(KEY_A));
    const beta = await memoryStoreDocument({ ...base, namespace: 'beta' }, auth(KEY_A));
    const tenantB = await memoryStoreDocument({ ...base, namespace: 'alpha' }, auth(KEY_B));
    assert.notEqual(alpha.document_id, beta.document_id);
    assert.notEqual(alpha.document_id, tenantB.document_id);
    await assert.rejects(
      () => memoryStoreDocument({ ...base, namespace: 'beta', idempotency_key: 'denied' }, auth(KEY_A, ['alpha'])),
      /Access denied/
    );

    const app = await appClient();
    try {
      await setScope(app, KEY_A, ['alpha']);
      const visible = await app.query<{ namespace: string }>(
        `SELECT namespace FROM documents WHERE idempotency_key = 'scope-key' ORDER BY namespace`
      );
      assert.deepEqual(visible.rows.map(row => row.namespace), ['alpha', 'alpha']);
    } finally {
      await app.query('ROLLBACK').catch(() => undefined);
      await app.end();
    }
  });

  await t.test('real concurrent identical retries converge through the partial-index ON CONFLICT path', async () => {
    const params = {
      title: 'concurrent', content: 'same request', namespace: 'alpha', tags: ['b', 'a'], source: 'test',
      idempotency_key: 'concurrent-same',
    };
    const [left, right] = await Promise.all([
      memoryStoreDocument(params, auth(KEY_A)),
      memoryStoreDocument({ ...params, tags: ['a', 'b', 'a'] }, auth(KEY_A)),
    ]);
    assert.equal(left.document_id, right.document_id);
    assert.equal(left.chunks_stored, 1);

    const owner = await ownerClient();
    try {
      const counts = await owner.query<{ documents: number; memories: number }>(
        `SELECT COUNT(DISTINCT d.id)::int AS documents, COUNT(m.id)::int AS memories
         FROM documents d LEFT JOIN memories m ON m.document_id = d.id
         WHERE d.client_id = $1 AND d.namespace = 'alpha' AND d.idempotency_key = 'concurrent-same'`,
        [KEY_A]
      );
      assert.deepEqual(counts.rows[0], { documents: 1, memories: 1 });
    } finally {
      await owner.end();
    }
  });

  await t.test('concurrent changed requests produce one typed conflict and preserve the winner', async () => {
    const common = {
      title: 'race', namespace: 'alpha', tags: [], source: 'test', idempotency_key: 'concurrent-changed',
    };
    const settled = await Promise.allSettled([
      memoryStoreDocument({ ...common, content: 'left' }, auth(KEY_A)),
      memoryStoreDocument({ ...common, content: 'right' }, auth(KEY_A)),
    ]);
    assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = settled.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof StoreDocumentConflictError);

    const owner = await ownerClient();
    try {
      const count = await owner.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM documents
         WHERE client_id = $1 AND namespace = 'alpha' AND idempotency_key = 'concurrent-changed'`,
        [KEY_A]
      );
      assert.equal(count.rows[0].count, 1);
    } finally {
      await owner.end();
    }
  });

  await t.test('a real chunk INSERT failure rolls back the document and every prior chunk', async () => {
    const owner = await ownerClient();
    try {
      await owner.query(`
        CREATE OR REPLACE FUNCTION fail_second_atomicity_chunk() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.source = 'rollback-test' AND NEW.chunk_index = 1 THEN
            RAISE EXCEPTION 'injected chunk failure';
          END IF;
          RETURN NEW;
        END $$
      `);
      await owner.query(`
        CREATE TRIGGER fail_second_atomicity_chunk
        BEFORE INSERT ON memories FOR EACH ROW EXECUTE FUNCTION fail_second_atomicity_chunk()
      `);
    } finally {
      await owner.end();
    }

    await assert.rejects(
      () => memoryStoreDocument({
        title: 'rollback', content: `first ${'x'.repeat(2100)}\n\nsecond ${'y'.repeat(2100)}`,
        namespace: 'alpha', tags: [], source: 'rollback-test', idempotency_key: 'rollback-key',
      }, auth(KEY_A)),
      /injected chunk failure/
    );

    const verify = await ownerClient();
    try {
      const docs = await verify.query(`SELECT 1 FROM documents WHERE idempotency_key = 'rollback-key'`);
      const memories = await verify.query(`SELECT 1 FROM memories WHERE source = 'rollback-test'`);
      assert.equal(docs.rowCount, 0);
      assert.equal(memories.rowCount, 0);
      await verify.query('DROP TRIGGER fail_second_atomicity_chunk ON memories');
      await verify.query('DROP FUNCTION fail_second_atomicity_chunk()');
    } finally {
      await verify.end();
    }
  });

  await t.test('strict linked-memory completeness rejects a later partial document', async () => {
    const params = {
      title: 'complete', content: `first ${'x'.repeat(2100)}\n\nsecond ${'y'.repeat(2100)}`,
      namespace: 'alpha', tags: [], source: 'test', idempotency_key: 'completeness-key',
    };
    const stored = await memoryStoreDocument(params, auth(KEY_A));
    const owner = await ownerClient();
    try {
      await owner.query(
        `DELETE FROM memories WHERE document_id = $1 AND chunk_index = 1`,
        [stored.document_id]
      );
    } finally {
      await owner.end();
    }
    await assert.rejects(
      () => memoryStoreDocument(params, auth(KEY_A)),
      (error: unknown) => error instanceof StoreDocumentConflictError && /incomplete/i.test(error.message)
    );
  });

  await appPool.end();
  setPoolForTesting(null);
});

async function ensureDatabase() {
  if (ownerUrl && appUrl) return;
  const image = process.env.MIGRATION_TEST_IMAGE || 'pgvector/pgvector:pg16';
  containerId = execFileSync('docker', [
    'run', '--rm', '-d', '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres',
    '-p', '127.0.0.1::5432', image,
  ], { encoding: 'utf8' }).trim();
  const port = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
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

async function resetDatabase() {
  if (!adminUrl) throw new Error('document idempotency DB test requires its disposable Docker database');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query('DROP DATABASE IF EXISTS total_recall WITH (FORCE)');
    await admin.query('CREATE DATABASE total_recall');
  } finally {
    await admin.end();
  }
  const owner = await ownerClient();
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

async function applyMigrationsThrough(lastVersion: string) {
  const files = readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql') && file.replace('.sql', '') <= lastVersion)
    .sort();
  const owner = await ownerClient();
  try {
    for (const file of files) await owner.query(readFileSync(join(migrationsDir, file), 'utf8'));
  } finally {
    await owner.end();
  }
}

async function seedApiKeys() {
  const owner = await ownerClient();
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

async function ownerClient() {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  return client;
}

async function appClient() {
  const client = new pg.Client({ connectionString: appUrl });
  await client.connect();
  return client;
}

async function setScope(client: pg.Client, keyId: string, namespaces: string[]) {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.allowed_namespaces', $1, true)", [JSON.stringify(namespaces)]);
  await client.query("SELECT set_config('app.current_key_id', $1, true)", [keyId]);
  await client.query("SELECT set_config('app.current_key_is_admin', 'false', true)");
}
