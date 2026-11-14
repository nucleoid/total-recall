import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { loadMigrationInventory, runMigrations } from '../scripts/migrate.js';
import { provisionDatabase } from '../scripts/provision-db.js';
import { finalizeMemoryValidity } from '../scripts/finalize-memory-validity.js';
import { hashKey } from '../src/auth.js';
import { setPoolForTesting } from '../src/db.js';
import { memoryStoreDocument } from '../src/tools/store-document.js';
import type { AuthContext } from '../src/types.js';

const auth: AuthContext = { keyId: '11111111-1111-4111-8111-111111111111', name: 'document-owner', namespaces: ['shared'], permissions: ['read','write','delete'], maxAccessLevel: 'secret' };
const vector = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0);
const params = (count: number, key?: string) => ({ title: 'synthetic document', content: 'quasar '.repeat(Math.ceil(count * 2000 / 7)).slice(0, count * 2000), namespace: 'shared', source: 'test', tags: [], ...(key ? { idempotency_key: key } : {}) });

test('document queue acceptance and batching on disposable PostgreSQL', { timeout: 180000 }, async t => {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port; server.close(error => error ? reject(error) : resolve(port));
    });
  });
  const container = execFileSync('docker', ['run','--rm','-d','-e','POSTGRES_PASSWORD=test-only','-p',`127.0.0.1:${port}:5432`,process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16'], { encoding: 'utf8' }).trim();
  let owner: pg.Client | undefined; let pool: pg.Pool | undefined;
  const env = { ...process.env }; const originalFetch = globalThis.fetch;
  t.after(async () => {
    setPoolForTesting(null); await pool?.end(); await owner?.end();
    execFileSync('docker',['rm','-f',container], { stdio: 'ignore' }); process.env = env; globalThis.fetch = originalFetch;
  });
  for (let i = 0; i < 100; i++) {
    const client = new pg.Client({ connectionString: `postgresql://postgres:test-only@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    try { await client.connect(); owner = client; break; } catch { await client.end(); await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(owner);
  await owner.query('CREATE EXTENSION vector');
  await provisionDatabase(owner, { appPassword: 'app-test-only', rotateAppPassword: false });
  await runMigrations(owner, loadMigrationInventory(fileURLToPath(new URL('../migrations', import.meta.url))), { lockTimeoutMs: 5000 });
  await finalizeMemoryValidity(owner);
  pool = new pg.Pool({ connectionString: `postgresql://total_recall_app:app-test-only@127.0.0.1:${port}/postgres` }); setPoolForTesting(pool);
  await owner.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level) VALUES ($1,$2,$3,$4,$5,$6)`, [auth.keyId,hashKey('tr_document-owner'),auth.name,auth.namespaces,auth.permissions,auth.maxAccessLevel]);
  process.env.MEMORY_INGESTION_QUEUE_ENABLED = 'true'; process.env.MEMORY_INGESTION_DOCUMENT_ENABLED = 'true'; process.env.MEMORY_STORE_INLINE_EMBED_MS = '1000';

  await t.test('provider offline acknowledges all durable chunks before contacting provider', async () => {
    globalThis.fetch = async () => {
      const counts = (await owner!.query(`SELECT d.chunk_count, count(m.id)::int AS chunks FROM documents d JOIN memories m ON m.document_id=d.id GROUP BY d.id`)).rows;
      assert.equal(counts.length, 1); assert.equal(counts[0].chunk_count, 2); assert.equal(counts[0].chunks, 2);
      throw new Error('provider offline');
    };
    const result = await memoryStoreDocument(params(2,'offline'),auth);
    assert.equal((result as any).state,'queued');
    const jobs = (await owner!.query('SELECT * FROM memory_ingestion_jobs WHERE document_id=$1', [result.document_id])).rows;
    assert.equal(jobs.length,2); assert.ok(jobs.every(job => job.kind === 'document' && !job.dedupe && !job.contradiction_eligible));
    assert.equal((await owner!.query('SELECT count(*)::int AS count FROM memories WHERE document_id=$1 AND embedding IS NULL',[result.document_id])).rows[0].count,2);
  });
  await t.test('small documents use exactly one batch call and large ones make no inline call', async () => {
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++; assert.match(String(url),/batchEmbedContents/);
      const body = JSON.parse(String(options?.body)); assert.equal(body.requests.length,3);
      return new Response(JSON.stringify({ embeddings: body.requests.map(() => ({ values: vector })) }));
    };
    assert.equal((await memoryStoreDocument(params(3),auth) as any).state,'ready'); assert.equal(calls,1);
    assert.equal((await memoryStoreDocument(params(40),auth) as any).state,'queued'); assert.equal(calls,1);
  });
});
