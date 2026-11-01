import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import request from 'supertest';
import { runIngestionWorker } from '../scripts/ingestion-worker.js';
import { hashKey } from '../src/auth.js';
import { dbScopeFromAuth, setPoolForTesting, withScopedClient } from '../src/db.js';
import { ACTIVE_EMBEDDING_PROFILE, serializeEmbeddingVector, type EmbeddingResult } from '../src/embedding.js';
import { getIngestionStats, requeueIngestion } from '../src/ingestion-admin.js';
import {
  claimIngestionJob,
  finalizeIngestionJob,
  type IngestionJob,
  type IngestionJobStatus,
} from '../src/ingestion.js';
import { executeHybridSearch } from '../src/search.js';
import { memoryList } from '../src/tools/list.js';
import { memoryRecall } from '../src/tools/recall.js';
import { keyedSourceKey, memoryStore, storeSchema } from '../src/tools/store.js';
import { exportMemoryPage } from '../src/transfer/export.js';
import { parseTransferMemoryRecord } from '../src/transfer/format.js';
import type { AuthContext } from '../src/types.js';

/**
 * Real PostgreSQL (pgvector image via Docker) coverage of the durable
 * write-ahead ingestion queue (#157). Everything here runs against the
 * migrated schema under the runtime app role, with RLS enforced, the gate on,
 * and the embedding provider replaced by a scripted fetch stub so no network
 * call is made. Skipped cleanly when Docker is unavailable.
 */

const OWNER_KEY = '11111111-1111-4111-8111-111111111111';
const OTHER_KEY = '22222222-2222-4222-8222-222222222222';
const ADMIN_KEY = '33333333-3333-4333-8333-333333333333';
const WORKER_SHARED_KEY = '44444444-4444-4444-8444-444444444444';
const WORKER_ALL_KEY = '55555555-5555-4555-8555-555555555555';
const WORKER_PLAIN_KEY = '66666666-6666-4666-8666-666666666666';
const SUBSCRIBER_KEY = '77777777-7777-4777-8777-777777777777';
const SUBSCRIPTION_ID = '88888888-8888-4888-8888-888888888888';

const owner: AuthContext = {
  keyId: OWNER_KEY, name: 'owner', namespaces: ['shared', 'private'],
  permissions: ['read', 'write', 'export'], maxAccessLevel: 'normal',
};
const other: AuthContext = { ...owner, keyId: OTHER_KEY, name: 'other', permissions: ['read', 'write'] };
const admin: AuthContext = { ...owner, keyId: ADMIN_KEY, name: 'admin', permissions: ['admin', 'read', 'write'] };

const unit = (index: number): number[] => Array.from({ length: 768 }, (_, i) => (i === index ? 1 : 0));
const V_A = unit(0);
const V_B = unit(1);
const V_C = unit(2);
const V_D = unit(3);
const V_W = unit(5);
const embedding = (vector: number[]): EmbeddingResult => ({
  vector, provider: ACTIVE_EMBEDDING_PROFILE.provider, model: ACTIVE_EMBEDDING_PROFILE.model, dimensions: ACTIVE_EMBEDDING_PROFILE.dimensions,
});
const queryVectors = (vector: number[]) => ({
  trackAccess: false as const,
  queryVectors: [{ profile: { ...ACTIVE_EMBEDDING_PROFILE }, vector }],
});

type ProviderMode = { kind: 'offline' } | { kind: 'sleep' } | { kind: 'vector'; vector: number[] };

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

type JobState = {
  status: IngestionJobStatus; attempts: number; lease_token: string | null; last_error_code: string | null;
  failure_category: string | null; accepted_at: Date; ready_at: Date | null; canonical_memory_id: string | null;
  similarity: number | null; requeued_by: string | null;
};
type MemoryState = { embedded: boolean; identity: string | null; deleted: boolean; deletion_reason: string | null; content: string; expires_at: Date | null; created_at: Date };

test('durable ingestion queue on real PostgreSQL: boundaries, RLS, worker scope, webhooks, visibility, latency', { timeout: 300_000 }, async t => {
  if (!dockerAvailable()) { t.skip('Docker is unavailable'); return; }

  // --- environment: gate on, provider stubbed ----------------------------------------------
  const savedEnv = {
    gate: process.env.MEMORY_INGESTION_QUEUE_ENABLED,
    budget: process.env.MEMORY_STORE_INLINE_EMBED_MS,
    timeout: process.env.EMBEDDING_TIMEOUT_MS,
    attempts: process.env.MEMORY_INGESTION_MAX_ATTEMPTS,
  };
  process.env.MEMORY_INGESTION_QUEUE_ENABLED = 'true';
  process.env.MEMORY_STORE_INLINE_EMBED_MS = '3000';
  process.env.EMBEDDING_TIMEOUT_MS = '8000';
  process.env.MEMORY_INGESTION_MAX_ATTEMPTS = '12';
  const restoreEnv = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };
  t.after(() => {
    restoreEnv('MEMORY_INGESTION_QUEUE_ENABLED', savedEnv.gate);
    restoreEnv('MEMORY_STORE_INLINE_EMBED_MS', savedEnv.budget);
    restoreEnv('EMBEDDING_TIMEOUT_MS', savedEnv.timeout);
    restoreEnv('MEMORY_INGESTION_MAX_ATTEMPTS', savedEnv.attempts);
  });

  let providerMode: ProviderMode = { kind: 'offline' };
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    providerCalls += 1;
    const mode = providerMode;
    if (mode.kind === 'offline') throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    if (mode.kind === 'sleep') {
      // Mimic undici: the request rejects with the signal's reason when aborted,
      // and otherwise waits for the provider for as long as EMBEDDING_TIMEOUT_MS.
      const signal = init?.signal;
      assert.ok(signal, 'the embedding client always passes an AbortSignal');
      await new Promise<never>((_, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return new Response(JSON.stringify({ embedding: { values: (mode as { vector: number[] }).vector } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // --- database --------------------------------------------------------------------------------
  const container = execFileSync('docker', [
    'run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=postgres', '-p', '127.0.0.1::5432',
    process.env.INGESTION_TEST_IMAGE || 'pgvector/pgvector:pg16',
  ], { encoding: 'utf8' }).trim();
  t.after(() => { setPoolForTesting(null); try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch {} });

  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)!;
  const ownerUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const appUrl = `postgresql://total_recall_app:app-password@127.0.0.1:${port}/postgres`;
  const deadline = Date.now() + 30_000;
  let ownerClient: pg.Client | undefined;
  while (Date.now() < deadline) {
    ownerClient = new pg.Client({ connectionString: ownerUrl });
    try { await ownerClient.connect(); break; }
    catch { await ownerClient.end().catch(() => undefined); ownerClient = undefined; await sleep(250); }
  }
  assert.ok(ownerClient, 'PostgreSQL did not become ready');
  const db = ownerClient;

  await db.query('CREATE EXTENSION IF NOT EXISTS vector');
  await db.query("CREATE ROLE total_recall_app LOGIN PASSWORD 'app-password'");
  const migrationDir = join(process.cwd(), 'migrations');
  for (const file of readdirSync(migrationDir).filter(file => /^\d+_.*\.sql$/.test(file)).sort()) {
    await db.query(readFileSync(join(migrationDir, file), 'utf8'));
  }

  const seedKey = (id: string, raw: string, name: string, namespaces: string[], permissions: string[]) => db.query(
    `INSERT INTO api_keys (id, key_hash, name, namespaces, permissions, max_access_level)
     VALUES ($1, $2, $3, $4, $5, 'normal')`,
    [id, hashKey(raw), name, namespaces, permissions],
  );
  await seedKey(OWNER_KEY, 'tr_owner', 'owner', ['shared', 'private'], ['read', 'write', 'export']);
  await seedKey(OTHER_KEY, 'tr_other', 'other', ['shared', 'private'], ['read', 'write']);
  await seedKey(ADMIN_KEY, 'tr_admin', 'admin', ['shared', 'private'], ['admin', 'read', 'write']);
  await seedKey(WORKER_SHARED_KEY, 'tr_worker_shared', 'worker-shared', ['shared'], ['admin', 'read']);
  await seedKey(WORKER_ALL_KEY, 'tr_worker_all', 'worker-all', ['shared', 'private'], ['admin', 'read']);
  await seedKey(WORKER_PLAIN_KEY, 'tr_worker_plain', 'worker-plain', ['shared', 'private'], ['read', 'write']);
  await seedKey(SUBSCRIBER_KEY, 'tr_subscriber', 'subscriber', ['shared'], ['read']);

  // Failure injection: owner-managed switches read by BEFORE triggers on the job
  // table so a boundary can be made to fail inside the exact transaction.
  await db.query(`
    CREATE TABLE ingestion_test_failures (stage TEXT PRIMARY KEY);
    GRANT SELECT ON ingestion_test_failures TO total_recall_app;
    CREATE FUNCTION ingestion_test_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM ingestion_test_failures WHERE stage = 'accept') THEN
        RAISE EXCEPTION 'injected accept failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER ingestion_test_fail_insert BEFORE INSERT ON memory_ingestion_jobs
      FOR EACH ROW EXECUTE FUNCTION ingestion_test_fail_insert();
    CREATE FUNCTION ingestion_test_fail_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status = 'processing' AND OLD.status <> 'processing'
         AND EXISTS (SELECT 1 FROM ingestion_test_failures WHERE stage = 'claim') THEN
        RAISE EXCEPTION 'injected claim failure';
      END IF;
      IF NEW.status IN ('ready', 'deduplicated') AND OLD.status = 'processing'
         AND EXISTS (SELECT 1 FROM ingestion_test_failures WHERE stage = 'finalize') THEN
        RAISE EXCEPTION 'injected finalize failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER ingestion_test_fail_update BEFORE UPDATE ON memory_ingestion_jobs
      FOR EACH ROW EXECUTE FUNCTION ingestion_test_fail_update();
  `);
  const failAt = (stage: 'accept' | 'claim' | 'finalize') => db.query('INSERT INTO ingestion_test_failures (stage) VALUES ($1)', [stage]);
  const heal = (stage: 'accept' | 'claim' | 'finalize') => db.query('DELETE FROM ingestion_test_failures WHERE stage = $1', [stage]);

  const appPool = new pg.Pool({ connectionString: appUrl });
  setPoolForTesting(appPool);

  // --- helpers ---------------------------------------------------------------------------------
  const store = (content: string, extra: Record<string, unknown> = {}, auth: AuthContext = owner) =>
    memoryStore(storeSchema.parse({ content, namespace: 'shared', ...extra }), auth);
  const job = async (memoryId: string): Promise<JobState | null> => {
    const result = await db.query<JobState>(
      `SELECT status, attempts, lease_token::text, last_error_code, failure_category, accepted_at, ready_at,
              canonical_memory_id::text, similarity, requeued_by
       FROM memory_ingestion_jobs WHERE memory_id = $1`,
      [memoryId],
    );
    return result.rows[0] ?? null;
  };
  const memory = async (memoryId: string): Promise<MemoryState | null> => {
    const result = await db.query<MemoryState>(
      `SELECT embedding IS NOT NULL AS embedded,
              CASE WHEN embedding_provider IS NULL THEN NULL ELSE embedding_provider || '/' || embedding_model || '/' || embedding_dimensions END AS identity,
              deleted_at IS NOT NULL AS deleted, deletion_reason, content, expires_at, created_at
       FROM memories WHERE id = $1`,
      [memoryId],
    );
    return result.rows[0] ?? null;
  };
  const auditCount = async (action: string, memoryId: string): Promise<number> => {
    const result = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM audit_log WHERE action = $1 AND memory_id = $2',
      [action, memoryId],
    );
    return result.rows[0].count;
  };
  const deliveries = async (memoryId: string): Promise<number> => {
    const result = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM webhook_deliveries WHERE memory_id = $1', [memoryId]);
    return result.rows[0].count;
  };
  const drain = (rawKey: string, embed: (content: string, signal: AbortSignal) => Promise<EmbeddingResult>, maxJobs = 100) =>
    runIngestionWorker({ once: true, maxJobs, pollMs: 100, concurrency: 1 }, {
      env: { ...process.env, INGESTION_WORKER_API_KEY: rawKey },
      embed,
    });
  const embedWith = (vector: number[]) => async (): Promise<EmbeddingResult> => embedding(vector);
  const claimAs = (auth: AuthContext, leaseMs: number) =>
    withScopedClient(dbScopeFromAuth(auth), client => claimIngestionJob(client, { leaseMs }));
  const finalizeAs = (claimed: IngestionJob, vector: number[]) =>
    withScopedClient({ namespaces: [claimed.namespace], keyId: claimed.clientId }, client =>
      finalizeIngestionJob(client, claimed, embedding(vector)));
  const expectJob = async (memoryId: string, expected: Partial<JobState>) => {
    const state = await job(memoryId);
    assert.ok(state, `job row for ${memoryId}`);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual((state as Record<string, unknown>)[key], value, `job.${key}`);
    }
    return state;
  };

  try {
    // --- kill at every boundary ------------------------------------------------------------------
    await t.test('accept, claim, embed and finalize boundaries neither lose nor duplicate the memory', async () => {
      providerMode = { kind: 'vector', vector: V_A };

      // Boundary 1: the acceptance transaction fails -> nothing acknowledged, nothing persisted.
      await failAt('accept');
      await assert.rejects(store('boundary accept failure'), /injected accept failure/);
      await heal('accept');
      const orphan = await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM memories WHERE content = 'boundary accept failure'",
      );
      assert.equal(orphan.rows[0].count, 0, 'a failed acceptance leaves no memory row');
      assert.equal(
        (await db.query<{ count: number }>("SELECT count(*)::int AS count FROM audit_log WHERE action = 'memory.store' AND client_id = $1", [OWNER_KEY])).rows[0].count,
        0, 'a failed acceptance leaves no audit row',
      );

      // Boundary 2: the API dies right after the acceptance commit, before the inline
      // claim. A zero inline budget leaves the job exactly as that crash would.
      process.env.MEMORY_STORE_INLINE_EMBED_MS = '0';
      const accepted = await store('boundary crash after accept');
      process.env.MEMORY_STORE_INLINE_EMBED_MS = '3000';
      assert.equal(accepted.state, 'queued');
      assert.equal(accepted.created, true);
      await expectJob(accepted.id, { status: 'pending', attempts: 0, lease_token: null });
      assert.equal((await memoryRecall({ id: accepted.id }, owner)).ingestion?.state, 'queued', 'accepted content is recallable before any embedding');
      const drained = await drain('tr_worker_all', embedWith(V_A));
      assert.ok(drained.ready >= 1, 'the worker finished the orphaned acceptance');
      await expectJob(accepted.id, { status: 'ready', attempts: 1, lease_token: null });
      assert.equal((await memory(accepted.id))?.embedded, true);
      assert.equal(await auditCount('memory.store', accepted.id), 1);
      assert.equal(await auditCount('memory.ingest.ready', accepted.id), 1);

      // Boundary 3: a worker dies after claiming (and after embedding) but before finalize.
      providerMode = { kind: 'offline' };
      const crashed = await store('boundary crash after claim');
      assert.equal(crashed.state, 'queued');
      const first = await claimAs(admin, 1_000);
      assert.ok(first && first.memoryId === crashed.id, 'the claim picked the only pending job');
      assert.equal(await claimAs(admin, 1_000), null, 'a live lease is not reclaimable');
      await sleep(1_300);
      const second = await claimAs(admin, 60_000);
      assert.ok(second && second.memoryId === crashed.id, 'the expired lease was reclaimed');
      assert.equal(second.attempts, 2);
      assert.notEqual(second.leaseToken, first.leaseToken);
      assert.deepEqual(await finalizeAs(first, V_A), { outcome: 'stale' }, 'the late first worker is a no-op');
      assert.equal((await memory(crashed.id))?.embedded, false);
      const landed = await finalizeAs(second, V_A);
      assert.equal(landed.outcome, 'ready');
      await expectJob(crashed.id, { status: 'ready', attempts: 2, lease_token: null });
      assert.equal(await auditCount('memory.ingest.ready', crashed.id), 1, 'exactly one ready audit after a reclaim');
      assert.deepEqual(await finalizeAs(second, V_A), { outcome: 'stale' }, 'a repeated finalize with the same lease changes nothing');
      assert.equal((await memory(crashed.id))?.identity, `${ACTIVE_EMBEDDING_PROFILE.provider}/${ACTIVE_EMBEDDING_PROFILE.model}/${ACTIVE_EMBEDDING_PROFILE.dimensions}`);

      // Boundary 4: the finalize transaction itself fails -> the vector write rolls back with it.
      const unstable = await store('boundary finalize failure');
      assert.equal(unstable.state, 'queued');
      const claimed = await claimAs(admin, 60_000);
      assert.ok(claimed && claimed.memoryId === unstable.id);
      await failAt('finalize');
      await assert.rejects(finalizeAs(claimed, V_A), /injected finalize failure/);
      assert.equal((await memory(unstable.id))?.embedded, false, 'the memory UPDATE rolled back with the job UPDATE');
      await expectJob(unstable.id, { status: 'processing', attempts: 1, lease_token: claimed.leaseToken });
      assert.equal(await auditCount('memory.ingest.ready', unstable.id), 0);
      await heal('finalize');
      assert.equal((await finalizeAs(claimed, V_A)).outcome, 'ready', 'the same lease finalizes once the fault clears');
      assert.equal(await auditCount('memory.ingest.ready', unstable.id), 1);

      // Boundary 5: the inline fast path's finalize fails -> queued, no attempt, the worker finishes.
      providerMode = { kind: 'vector', vector: V_A };
      await failAt('finalize');
      const inlineFailed = await store('boundary inline finalize failure');
      assert.equal(inlineFailed.state, 'queued');
      await expectJob(inlineFailed.id, { status: 'pending', attempts: 0, last_error_code: 'finalize_error' });
      await heal('finalize');

      // Boundary 6: the claim transaction fails -> the worker crashes out, the job is untouched.
      await failAt('claim');
      await assert.rejects(drain('tr_worker_all', embedWith(V_A)), /injected claim failure/);
      await expectJob(inlineFailed.id, { status: 'pending', attempts: 0 });
      await heal('claim');
      await drain('tr_worker_all', embedWith(V_A));
      await expectJob(inlineFailed.id, { status: 'ready', attempts: 1 });
      assert.equal(await auditCount('memory.ingest.ready', inlineFailed.id), 1);

      // Boundary 7: a caller disconnect after acceptance is safe to retry with its key.
      providerMode = { kind: 'offline' };
      const keyed = await store('boundary keyed retry', { idempotency_key: 'boundary-retry' });
      assert.equal(keyed.state, 'queued');
      providerMode = { kind: 'vector', vector: V_A };
      const retried = await store('boundary keyed retry', { idempotency_key: 'boundary-retry' });
      assert.equal(retried.id, keyed.id);
      assert.equal(retried.created, false);
      assert.equal(retried.idempotency_key_honored, true);
      assert.equal(retried.state, 'queued', 'identical content on a queued keyed row is a no-op');
      await drain('tr_worker_all', embedWith(V_A));
      assert.equal(
        (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM memories WHERE client_id = $1 AND source_key = $2', [OWNER_KEY, keyedSourceKey(OWNER_KEY, 'boundary-retry')])).rows[0].count,
        1,
      );
    });

    // --- RLS: owner-only job visibility ---------------------------------------------------------
    await t.test('job rows are visible to their owner and to admins in scope only; other readers see state alone', async () => {
      providerMode = { kind: 'offline' };
      const stored = await store('rls visibility probe');
      assert.equal(stored.state, 'queued');

      const ownerView = await memoryRecall({ id: stored.id }, owner);
      assert.equal(ownerView.ingestion?.state, 'queued');
      assert.equal(typeof ownerView.ingestion?.accepted_at, 'string');
      assert.equal(ownerView.ingestion?.attempts, 0);
      assert.equal(ownerView.ingestion?.ready_at, null);
      assert.equal(ownerView.ingestion?.next_retry_at, null);
      assert.equal(ownerView.ingestion?.failure_category, null);
      assert.equal(ownerView.ingestion?.canonical_memory_id, null);
      assert.deepEqual((await memoryRecall({ id: stored.id }, other)).ingestion, { state: 'queued' }, 'another key in the namespace learns the state only');
      assert.equal((await memoryRecall({ id: stored.id }, admin)).ingestion?.attempts, 0, 'an admin in scope sees the full object');

      const visible = (auth: AuthContext) => withScopedClient(dbScopeFromAuth(auth), async client =>
        (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM memory_ingestion_jobs WHERE memory_id = $1', [stored.id])).rows[0].count);
      assert.equal(await visible(owner), 1);
      assert.equal(await visible(other), 0, 'RLS hides another owner\'s job row');
      assert.equal(await visible(admin), 1);
      assert.equal(await visible({ ...admin, namespaces: ['private'] }), 0, 'an admin outside the namespace sees nothing');
      assert.equal(await visible({ ...owner, namespaces: ['private'] }), 0, 'the owner outside the namespace sees nothing');

      await assert.rejects(
        withScopedClient(dbScopeFromAuth(other), client =>
          client.query('DELETE FROM memory_ingestion_jobs WHERE memory_id = $1', [stored.id])),
        /permission denied/i, 'the runtime role has no DELETE grant on the job table',
      );
      await drain('tr_worker_all', embedWith(V_A));
      await expectJob(stored.id, { status: 'ready' });
    });

    // --- worker scope confinement -----------------------------------------------------------------
    await t.test('the worker claims only within its key\'s namespaces and finalizes under the owner scope', async () => {
      providerMode = { kind: 'offline' };
      const shared = await store('worker scope shared');
      const priv = await store('worker scope private', { namespace: 'private' });
      assert.equal(shared.state, 'queued');
      assert.equal(priv.state, 'queued');

      await assert.rejects(drain('tr_worker_plain', embedWith(V_A)), /admin/, 'a key without admin cannot run the worker');
      await assert.rejects(drain('tr_unknown', embedWith(V_A)), /Invalid or disabled/, 'an unknown key cannot run the worker');
      await expectJob(shared.id, { status: 'pending', attempts: 0 });

      const narrow = await drain('tr_worker_shared', embedWith(V_A));
      assert.ok(narrow.ready >= 1);
      await expectJob(shared.id, { status: 'ready', attempts: 1 });
      await expectJob(priv.id, { status: 'pending', attempts: 0 }, );
      assert.equal((await memory(priv.id))?.embedded, false, 'a namespace outside the worker key is never touched');

      const wide = await drain('tr_worker_all', embedWith(V_A));
      assert.ok(wide.ready >= 1);
      await expectJob(priv.id, { status: 'ready', attempts: 1 });
      const actors = await db.query<{ client_id: string; namespace: string }>(
        "SELECT client_id, namespace FROM audit_log WHERE action = 'memory.ingest.ready' AND memory_id = ANY($1::uuid[]) ORDER BY namespace",
        [[shared.id, priv.id]],
      );
      assert.deepEqual(actors.rows, [
        { client_id: OWNER_KEY, namespace: 'private' },
        { client_id: OWNER_KEY, namespace: 'shared' },
      ], 'finalization is attributed to the owner, never to the worker key');
      const heartbeat = await db.query<{ seen: boolean }>('SELECT ingestion_worker_seen_at IS NOT NULL AS seen FROM instance_settings WHERE singleton = true');
      assert.equal(heartbeat.rows[0].seen, true);
    });

    // --- webhook outbox exactly once --------------------------------------------------------------
    await t.test('a queued memory creates exactly one webhook outbox row when it becomes ready, with both triggers enabled', async () => {
      await db.query(`ALTER TABLE public.memories
        ENABLE TRIGGER memories_subscription_enqueue,
        ENABLE TRIGGER memories_ingestion_subscription_enqueue`);
      await db.query(
        `INSERT INTO memory_subscriptions (id, api_key_id, query_text, query_embedding, embedding_provider, embedding_model, embedding_dimensions,
           threshold, webhook_url_ciphertext, webhook_url_iv, webhook_url_tag, signing_secret_ciphertext, signing_secret_iv, signing_secret_tag,
           encryption_key_id, idempotency_key, request_hash)
         VALUES ($1, $2, 'ingestion probe', $3::vector, $4, $5, $6, 0.5, $7, $8, $9, $7, $8, $9, 'test-key', 'sub-ingestion', $10)`,
        [SUBSCRIPTION_ID, SUBSCRIBER_KEY, serializeEmbeddingVector(V_W), ACTIVE_EMBEDDING_PROFILE.provider, ACTIVE_EMBEDDING_PROFILE.model,
          ACTIVE_EMBEDDING_PROFILE.dimensions, Buffer.from([1]), Buffer.alloc(12), Buffer.alloc(16), 'a'.repeat(64)],
      );
      await db.query('INSERT INTO subscription_namespaces (subscription_id, api_key_id, namespace) VALUES ($1, $2, $3)', [SUBSCRIPTION_ID, SUBSCRIBER_KEY, 'shared']);

      providerMode = { kind: 'offline' };
      const stored = await store('webhook outbox probe');
      assert.equal(stored.state, 'queued');
      assert.equal(await deliveries(stored.id), 0, 'a queued memory does not notify before its embedding lands');

      const first = await claimAs(admin, 1_000);
      assert.ok(first && first.memoryId === stored.id);
      await sleep(1_300);
      const second = await claimAs(admin, 60_000);
      assert.ok(second && second.memoryId === stored.id);
      assert.equal((await finalizeAs(second, V_W)).outcome, 'ready');
      assert.equal(await deliveries(stored.id), 1, 'the pending to ready transition is the creation event');
      assert.deepEqual(await finalizeAs(first, V_W), { outcome: 'stale' });
      assert.equal(await deliveries(stored.id), 1, 'a late finalizer with a stale lease creates no second event');
      await db.query('UPDATE memories SET tags = ARRAY[\'retagged\'] WHERE id = $1', [stored.id]);
      assert.equal(await deliveries(stored.id), 1, 'a later update of an embedded memory is not a creation event');
      const outbox = await db.query<{ subscription_id: string; namespace: string; status: string }>(
        'SELECT subscription_id::text, namespace, status FROM webhook_deliveries WHERE memory_id = $1', [stored.id],
      );
      assert.deepEqual(outbox.rows, [{ subscription_id: SUBSCRIPTION_ID, namespace: 'shared', status: 'pending' }]);

      // dedupe:false so the inline finalize lands its own vector instead of collapsing into the row above.
      providerMode = { kind: 'vector', vector: V_W };
      const inline = await store('webhook outbox inline probe', { dedupe: false });
      assert.equal(inline.state, 'ready');
      assert.notEqual(inline.id, stored.id);
      assert.equal(await deliveries(inline.id), 1, 'an inline finalize notifies exactly once too');

      const elsewhere = await store('webhook outbox other namespace probe', { namespace: 'private', dedupe: false });
      assert.equal(elsewhere.state, 'ready');
      assert.equal(await deliveries(elsewhere.id), 0, 'a namespace without a subscription creates no event');
    });

    // --- FTS versus semantic ranking ---------------------------------------------------------------
    await t.test('full-text search finds a pending row while semantic ranking waits for its vector', async () => {
      providerMode = { kind: 'offline' };
      const stored = await store('quokkaledger pending text search probe');
      assert.equal(stored.state, 'queued');
      const scope = dbScopeFromAuth(owner);

      const text = await executeHybridSearch({ query: 'quokkaledger', limit: 10, threshold: 0.3 }, ['shared'], scope, 'normal', queryVectors(V_B));
      const pendingHit = text.find(result => result.id === stored.id);
      assert.ok(pendingHit, 'the text branch returns the unembedded row');
      assert.equal(pendingHit.ingestion?.state, 'queued');

      const semanticBefore = await executeHybridSearch({ query: 'zzqxnomatch', limit: 10, threshold: 0.3 }, ['shared'], scope, 'normal', queryVectors(V_C));
      assert.equal(semanticBefore.some(result => result.id === stored.id), false, 'no vector means no semantic rank, never a cross-space compare');

      await drain('tr_worker_all', embedWith(V_C));
      await expectJob(stored.id, { status: 'ready' });
      const semanticAfter = await executeHybridSearch({ query: 'zzqxnomatch', limit: 10, threshold: 0.3 }, ['shared'], scope, 'normal', queryVectors(V_C));
      const readyHit = semanticAfter.find(result => result.id === stored.id);
      assert.ok(readyHit, 'the row ranks semantically once its vector landed');
      assert.equal(readyHit.ingestion?.state, 'ready');
    });

    // --- recall / list / export shapes and the dedupe redirect -----------------------------------
    await t.test('recall, list and export expose pending rows content-free, and a deduplicated id resolves to its canonical row', async () => {
      providerMode = { kind: 'offline' };
      const pending = await store('shape probe pending row');
      assert.equal(pending.state, 'queued');
      const legacyId = (await db.query<{ id: string }>(
        `INSERT INTO memories (content, embedding, source, namespace, access_level, client_id, embedding_provider, embedding_model, embedding_dimensions, memory_kind, valid_from)
         VALUES ('shape probe legacy row', $1::vector, 'test', 'shared', 'normal', $2, $3, $4, $5, 'semantic', statement_timestamp())
         RETURNING id::text`,
        [serializeEmbeddingVector(V_B), OWNER_KEY, ACTIVE_EMBEDDING_PROFILE.provider, ACTIVE_EMBEDDING_PROFILE.model, ACTIVE_EMBEDDING_PROFILE.dimensions],
      )).rows[0].id;

      const listed = await memoryList({ namespace: 'shared', limit: 100, offset: 0 }, owner);
      assert.equal(listed.memories.find(row => row.id === pending.id)?.ingestion?.state, 'queued');
      assert.equal(listed.memories.find(row => row.id === legacyId)?.ingestion, null, 'a vector without a job reports null');
      assert.deepEqual((await memoryList({ namespace: 'shared', limit: 100, offset: 0 }, other)).memories.find(row => row.id === pending.id)?.ingestion, { state: 'queued' });

      const exported = await exportMemoryPage({ include_sensitive: false, acknowledge_plaintext_sensitive: false, limit: 100 }, owner);
      const records = exported.records.map(record => parseTransferMemoryRecord(record));
      const pendingRecord = records.find(record => record.content === 'shape probe pending row');
      const legacyRecord = records.find(record => record.content === 'shape probe legacy row');
      assert.equal(pendingRecord?.ingestion_state, 'queued', 'export carries a content-free state for a pending row');
      assert.ok(legacyRecord);
      assert.equal('ingestion_state' in legacyRecord, false, 'rows without a job carry no state');

      // Finish the pending probe with its own vector space position so it cannot
      // take part in the dedupe below, then land a canonical row first.
      await drain('tr_worker_all', embedWith(unit(6)));
      await expectJob(pending.id, { status: 'ready' });

      // Dedupe redirect: a canonical row lands first, then an identical vector collapses into it.
      const canonical = await store('shape probe canonical row');
      await drain('tr_worker_all', embedWith(V_D));
      await expectJob(canonical.id, { status: 'ready' });
      const duplicate = await store('shape probe duplicate row');
      assert.equal(duplicate.state, 'queued');
      const drained = await drain('tr_worker_all', embedWith(V_D));
      assert.ok(drained.deduplicated >= 1);
      const deduped = await expectJob(duplicate.id, { status: 'deduplicated', canonical_memory_id: canonical.id });
      assert.ok(deduped.similarity !== null && deduped.similarity > 0.99);
      const tombstone = await memory(duplicate.id);
      assert.equal(tombstone?.deleted, true);
      assert.equal(tombstone?.deletion_reason, 'ingestion_deduplicated');
      assert.equal(tombstone?.embedded, false, 'the collapsed row never receives a vector');
      assert.equal(await auditCount('memory.ingest.deduplicated', duplicate.id), 1);

      const redirected = await memoryRecall({ id: duplicate.id }, owner);
      assert.equal(redirected.id, canonical.id, 'the pending id resolves to the canonical row');
      assert.equal(redirected.ingestion?.state, 'deduplicated');
      assert.equal(redirected.ingestion?.canonical_memory_id, canonical.id);
      assert.ok((redirected.ingestion?.similarity ?? 0) > 0.99);
      assert.equal((await memoryRecall({ id: canonical.id }, owner)).ingestion?.state, 'ready');
      await assert.rejects(memoryRecall({ id: duplicate.id }, other), /not found or access denied/, 'a non-owner cannot resolve the collapsed id');
    });

    // --- TTL from acceptance -----------------------------------------------------------------------
    await t.test('TTL starts at acceptance and an expired memory is cancelled without a provider call', async () => {
      providerMode = { kind: 'offline' };
      const stored = await store('ttl probe', { ttl: 1 });
      assert.equal(stored.state, 'queued');
      const row = await memory(stored.id);
      assert.ok(row?.expires_at);
      const life = row.expires_at.getTime() - row.created_at.getTime();
      assert.ok(life >= 900 && life <= 1_900, `expires_at is accepted time plus the ttl (${life}ms)`);
      const accepted = await expectJob(stored.id, { status: 'pending' });
      assert.ok(Math.abs(accepted.accepted_at.getTime() - row.created_at.getTime()) < 1_000, 'accepted_at is the acceptance time');

      await sleep(1_300);
      let embeds = 0;
      const drained = await drain('tr_worker_all', async () => { embeds += 1; return embedding(V_A); });
      assert.ok(drained.cancelled >= 1);
      assert.equal(embeds, 0, 'expired content is never sent to the provider');
      await expectJob(stored.id, { status: 'cancelled', failure_category: 'expired', last_error_code: 'memory_expired' });
      await assert.rejects(memoryRecall({ id: stored.id }, owner), /not found or access denied/, 'an expired memory is logically absent');

      const stats = await getIngestionStats(admin);
      assert.equal(stats.enabled, true);
      assert.ok(stats.depth.cancelled >= 1);
      assert.ok(stats.failure_categories.expired >= 1);
      assert.ok(stats.worker.last_seen_at instanceof Date);
      assert.equal(stats.queued, 0);

      const requeued = await requeueIngestion(admin, stored.id);
      assert.equal(requeued.status, 'pending');
      assert.equal(requeued.previous_status, 'cancelled');
      await expectJob(stored.id, { status: 'pending', attempts: 0, requeued_by: ADMIN_KEY });
      assert.equal(await auditCount('ingestion.requeue', stored.id), 1);
      await assert.rejects(requeueIngestion(admin, stored.id), /cannot be requeued/, 'a pending job is a conflict');
      await drain('tr_worker_all', embedWith(V_A));
      await expectJob(stored.id, { status: 'cancelled', failure_category: 'expired' });
    });

    // --- idempotency key across states -----------------------------------------------------------
    await t.test('an idempotency key reused while queued, ready and after a content change returns one logical memory', async () => {
      providerMode = { kind: 'offline' };
      const key = 'idem-states';
      const sourceKey = keyedSourceKey(OWNER_KEY, key);
      const count = async () => (await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM memories WHERE client_id = $1 AND source_key = $2', [OWNER_KEY, sourceKey])).rows[0].count;

      const created = await store('idempotent v1', { idempotency_key: key });
      assert.equal(created.created, true);
      assert.equal(created.state, 'queued');
      const firstJob = await expectJob(created.id, { status: 'pending', attempts: 0 });

      const callsBefore = providerCalls;
      const sameQueued = await store('idempotent v1', { idempotency_key: key });
      assert.equal(sameQueued.id, created.id);
      assert.equal(sameQueued.created, false);
      assert.equal(sameQueued.state, 'queued');
      assert.equal(providerCalls, callsBefore, 'an identical replay of a queued row makes no inline attempt');
      assert.equal((await expectJob(created.id, { status: 'pending' })).accepted_at.getTime(), firstJob.accepted_at.getTime(), 'the job is untouched');

      const changedQueued = await store('idempotent v2', { idempotency_key: key });
      assert.equal(changedQueued.id, created.id);
      assert.equal(changedQueued.state, 'queued');
      const resetJob = await expectJob(created.id, { status: 'pending', attempts: 0 });
      assert.ok(resetJob.accepted_at.getTime() > firstJob.accepted_at.getTime(), 'changed content resets the job');
      assert.equal((await memory(created.id))?.content, 'idempotent v2');
      assert.equal(await count(), 1);

      await drain('tr_worker_all', embedWith(V_A));
      const readyJob = await expectJob(created.id, { status: 'ready' });
      assert.equal((await memory(created.id))?.embedded, true);

      providerMode = { kind: 'vector', vector: V_A };
      const sameReady = await store('idempotent v2', { idempotency_key: key });
      assert.equal(sameReady.id, created.id);
      assert.equal(sameReady.state, 'ready');
      assert.equal(sameReady.created, false);
      assert.equal((await expectJob(created.id, { status: 'ready' })).ready_at?.getTime(), readyJob.ready_at?.getTime(), 'identical content on a ready row does not re-queue');
      assert.equal((await memory(created.id))?.embedded, true);

      const changedReady = await store('idempotent v3', { idempotency_key: key });
      assert.equal(changedReady.id, created.id);
      assert.equal(changedReady.state, 'ready', 'the changed content re-queued and landed inline');
      const relanded = await expectJob(created.id, { status: 'ready', attempts: 0 });
      assert.ok((relanded.ready_at?.getTime() ?? 0) > (readyJob.ready_at?.getTime() ?? 0));
      const final = await memory(created.id);
      assert.equal(final?.content, 'idempotent v3');
      assert.equal(final?.embedded, true);
      assert.equal(await count(), 1, 'one physical row across every state');
      assert.equal(await auditCount('memory.store', created.id), 5, 'every keyed call is audited once');
    });

    // --- latency proof over REST -----------------------------------------------------------------
    await t.test('/api/store latency is bounded by the inline budget, not EMBEDDING_TIMEOUT_MS, once acceptance is durable', async () => {
      const { createApp } = await import('../src/server.js');
      const app = createApp();
      process.env.MEMORY_STORE_INLINE_EMBED_MS = '250';
      process.env.EMBEDDING_TIMEOUT_MS = '8000';
      providerMode = { kind: 'sleep' };

      const started = Date.now();
      const response = await request(app).post('/api/store').set('Authorization', 'Bearer tr_owner')
        .send({ content: 'latency probe during a provider hang', namespace: 'shared' });
      const elapsed = Date.now() - started;
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.state, 'queued');
      assert.equal(response.body.created, true);
      assert.equal(response.body.deduplicated, false);
      assert.equal(typeof response.body.accepted_at, 'string');
      assert.ok(elapsed < 4_000, `the request returned in ${elapsed}ms, far below the 8000ms provider timeout`);
      const row = await memory(response.body.id);
      assert.ok(row && !row.embedded, 'the memory is durable before the provider answered');
      await expectJob(response.body.id, { status: 'pending', attempts: 0, last_error_code: 'provider_timeout' });

      const detailBefore = await request(app).get(`/api/memories/${response.body.id}`).set('Authorization', 'Bearer tr_owner');
      assert.equal(detailBefore.status, 200);
      assert.equal(detailBefore.body.memory.ingestion.state, 'queued');

      await drain('tr_worker_all', embedWith(V_A));
      const detailAfter = await request(app).get(`/api/memories/${response.body.id}`).set('Authorization', 'Bearer tr_owner');
      assert.equal(detailAfter.body.memory.ingestion.state, 'ready');
      assert.equal(detailAfter.body.memory.ingestion.attempts, 1);

      process.env.MEMORY_STORE_INLINE_EMBED_MS = '0';
      providerMode = { kind: 'vector', vector: V_A };
      const callsBefore = providerCalls;
      const alwaysAsync = await request(app).post('/api/store').set('Authorization', 'Bearer tr_owner')
        .send({ content: 'latency probe always async', namespace: 'shared' });
      assert.equal(alwaysAsync.body.state, 'queued');
      assert.equal(providerCalls, callsBefore, 'a zero budget never calls the provider in the request');
      process.env.MEMORY_STORE_INLINE_EMBED_MS = '3000';

      const stats = await request(app).get('/api/ingestion/stats').set('Authorization', 'Bearer tr_admin');
      assert.equal(stats.status, 200);
      assert.equal(stats.body.enabled, true);
      assert.equal(stats.body.depth.pending, 1);
      assert.ok(stats.body.inline.attempted >= 1);
      assert.ok(stats.body.inline.queued >= 1);
      assert.doesNotMatch(JSON.stringify(stats.body), /latency probe|quokkaledger|idempotent/, 'stats never carry content');
      const forbidden = await request(app).get('/api/ingestion/stats').set('Authorization', 'Bearer tr_owner');
      assert.equal(forbidden.status, 403);
      await drain('tr_worker_all', embedWith(V_A));
    });
  } finally {
    await appPool.end().catch(() => undefined);
    await db.end().catch(() => undefined);
  }
});
