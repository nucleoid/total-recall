import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { checkPermission, hashKey, validateKeyReadOnly } from '../src/auth.js';
import { setPoolForTesting, withScopedClient } from '../src/db.js';
import {
  cancelUnauthorizedDelivery,
  claimWebhookDelivery,
  deliveryStillAuthorized,
  loadAuthorizedDelivery,
  markDeliveryDelivered,
  markDeliveryFailed,
  webhookWorkerScope,
} from '../src/subscriptions.js';

const WORKER = '10000000-0000-4000-8000-000000000059';
const OWNER = '20000000-0000-4000-8000-000000000059';
const SUB_SHARED = '30000000-0000-4000-8000-000000000059';
const SUB_PRIVATE = '30000000-0000-4000-8000-000000000060';
const MEMORY_A = '40000000-0000-4000-8000-000000000059';
const MEMORY_B = '40000000-0000-4000-8000-000000000060';
const MEMORY_PRIVATE = '40000000-0000-4000-8000-000000000061';
const MEMORY_C = '40000000-0000-4000-8000-000000000062';
const DELIVERY_A = '50000000-0000-4000-8000-000000000059';
const DELIVERY_B = '50000000-0000-4000-8000-000000000060';
const DELIVERY_PRIVATE = '50000000-0000-4000-8000-000000000061';
const WORKER_SECRET = 'tr_webhook_worker_integration';

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

async function waitForPostgres(url: string): Promise<pg.Client> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url });
    try { await client.connect(); return client; }
    catch { await client.end().catch(() => undefined); await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  throw new Error('PostgreSQL did not become ready');
}

test('webhook-only key has durable scoped authority and no raw table lane', { timeout: 180_000 }, async t => {
  if (!dockerAvailable()) { t.skip('Docker is unavailable'); return; }
  const container = execFileSync('docker', [
    'run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=postgres', '-p', '127.0.0.1::5432',
    process.env.CONSOLIDATION_TEST_IMAGE || 'pgvector/pgvector:pg16',
  ], { encoding: 'utf8' }).trim();
  t.after(() => { try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch {} });
  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)!;
  const ownerUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const appUrl = `postgresql://total_recall_app:app-password@127.0.0.1:${port}/postgres`;
  const owner = await waitForPostgres(ownerUrl);
  let appPool: pg.Pool | undefined;
  try {
    await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
    await owner.query("CREATE ROLE total_recall_app LOGIN PASSWORD 'app-password'");
    for (const file of readdirSync(join(process.cwd(), 'migrations')).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort()) {
      await owner.query(readFileSync(join(process.cwd(), 'migrations', file), 'utf8'));
    }
    await owner.query(`INSERT INTO api_keys
      (id, key_hash, name, namespaces, permissions, max_access_level, enabled, expires_at)
      VALUES
        ($1::uuid, $2, 'webhook-worker', ARRAY['shared'], ARRAY['webhook_worker'], 'normal', true, statement_timestamp() + interval '1 hour'),
        ($3::uuid, 'owner-hash', 'owner', ARRAY['shared','private'], ARRAY['read','write'], 'normal', true, statement_timestamp() + interval '1 hour')`,
    [WORKER, hashKey(WORKER_SECRET), OWNER]);
    await owner.query(`INSERT INTO memories
      (id, content, source, namespace, tags, metadata, access_level, client_id, memory_kind, valid_from)
      VALUES
        ($1::uuid, 'secret body a', 'test', 'shared', '{}', '{}', 'normal', 'different-owner', 'semantic', statement_timestamp()),
        ($2::uuid, 'secret body b', 'test', 'shared', '{}', '{}', 'normal', 'different-owner', 'semantic', statement_timestamp()),
        ($3::uuid, 'private body', 'test', 'private', '{}', '{}', 'normal', 'different-owner', 'semantic', statement_timestamp()),
        ($4::uuid, 'secret body c', 'test', 'shared', '{}', '{}', 'normal', 'different-owner', 'semantic', statement_timestamp())`,
    [MEMORY_A, MEMORY_B, MEMORY_PRIVATE, MEMORY_C]);
    await owner.query(`INSERT INTO documents (title, source, namespace, tags, client_id)
      VALUES ('hidden document', 'test', 'shared', '{}', $1::uuid)`, [OWNER]);
    await owner.query(`INSERT INTO memory_subscriptions (
      id, api_key_id, query_text, query_embedding, embedding_provider, embedding_model,
      embedding_dimensions, threshold, webhook_url_ciphertext, webhook_url_iv, webhook_url_tag,
      signing_secret_ciphertext, signing_secret_iv, signing_secret_tag, encryption_key_id,
      idempotency_key, request_hash
    ) VALUES
      ($1::uuid, $3::uuid, 'shared query', array_fill(0::real, ARRAY[768])::vector,
        'gemini', 'test-model', 768, 0.5, decode('01','hex'), decode(repeat('00',12),'hex'),
        decode(repeat('00',16),'hex'), decode('02','hex'), decode(repeat('00',12),'hex'),
        decode(repeat('00',16),'hex'), 'test', 'shared-key', repeat('a',64)),
      ($2::uuid, $3::uuid, 'private query', array_fill(0::real, ARRAY[768])::vector,
        'gemini', 'test-model', 768, 0.5, decode('03','hex'), decode(repeat('00',12),'hex'),
        decode(repeat('00',16),'hex'), decode('04','hex'), decode(repeat('00',12),'hex'),
        decode(repeat('00',16),'hex'), 'test', 'private-key', repeat('b',64))`,
    [SUB_SHARED, SUB_PRIVATE, OWNER]);
    await owner.query(`INSERT INTO subscription_namespaces (subscription_id, api_key_id, namespace)
      VALUES ($1::uuid,$3::uuid,'shared'),($2::uuid,$3::uuid,'private')`, [SUB_SHARED, SUB_PRIVATE, OWNER]);
    await owner.query(`INSERT INTO webhook_deliveries
      (id, subscription_id, api_key_id, memory_id, namespace, similarity)
      VALUES
        ($1::uuid,$4::uuid,$6::uuid,$7::uuid,'shared',0.9),
        ($2::uuid,$4::uuid,$6::uuid,$8::uuid,'shared',0.8),
        ($3::uuid,$5::uuid,$6::uuid,$9::uuid,'private',0.7)`,
    [DELIVERY_A, DELIVERY_B, DELIVERY_PRIVATE, SUB_SHARED, SUB_PRIVATE, OWNER, MEMORY_A, MEMORY_B, MEMORY_PRIVATE]);

    appPool = new pg.Pool({ connectionString: appUrl, max: 4 });
    setPoolForTesting(appPool);
    const auth = await validateKeyReadOnly(WORKER_SECRET);
    assert.ok(auth);
    assert.deepEqual(auth.permissions, ['webhook_worker']);
    assert.throws(() => checkPermission(auth, 'read'), /requires 'read'/);
    assert.throws(() => checkPermission(auth, 'write'), /requires 'write'/);
    const scope = webhookWorkerScope(auth);

    for (const table of ['memories', 'documents', 'memory_subscriptions', 'subscription_namespaces', 'webhook_deliveries']) {
      const rows = await withScopedClient(scope, client => client.query(`SELECT * FROM ${table}`));
      assert.equal(rows.rowCount, 0, `${table} must be hidden from raw worker queries`);
    }
    const rawUpdate = await withScopedClient(scope, client => client.query(
      'UPDATE webhook_deliveries SET status=status WHERE id=$1::uuid', [DELIVERY_A]));
    assert.equal(rawUpdate.rowCount, 0);

    const claims = await Promise.all([
      withScopedClient(scope, claimWebhookDelivery),
      withScopedClient(scope, claimWebhookDelivery),
    ]);
    assert.equal(new Set(claims.map(claim => claim?.id)).size, 2, 'concurrent claims must be distinct');
    assert.deepEqual(new Set(claims.map(claim => claim?.id)), new Set([DELIVERY_A, DELIVERY_B]));
    const first = claims[0]!;
    const second = claims[1]!;
    const loaded = await withScopedClient(scope, client => loadAuthorizedDelivery(client, first.id));
    assert.ok(loaded);
    assert.equal(loaded.namespace, 'shared');
    assert.equal('content' in loaded, false);
    assert.equal(await withScopedClient(scope, client => markDeliveryFailed(client, loaded, {
      errorCode: 'http_503', httpStatus: 503, retryAt: new Date(0), terminal: false,
    })), true);
    const retried = await withScopedClient(scope, claimWebhookDelivery);
    assert.equal(retried?.id, first.id);
    const reloaded = await withScopedClient(scope, client => loadAuthorizedDelivery(client, retried!.id));
    assert.ok(reloaded);
    assert.equal(await withScopedClient(scope, client => markDeliveryDelivered(client, reloaded, 204)), true);
    const secondLoaded = await withScopedClient(scope, client => loadAuthorizedDelivery(client, second.id));
    assert.ok(secondLoaded);
    assert.equal(await withScopedClient(scope, client => markDeliveryFailed(client, secondLoaded, {
      errorCode: 'test_terminal', terminal: true,
    })), true);
    assert.equal((await owner.query('SELECT status FROM webhook_deliveries WHERE id=$1::uuid', [DELIVERY_PRIVATE])).rows[0].status, 'pending');

    const revokedDelivery = '50000000-0000-4000-8000-000000000062';
    await owner.query(`INSERT INTO webhook_deliveries
      (id, subscription_id, api_key_id, memory_id, namespace, similarity)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'shared',0.9)`,
    [revokedDelivery, SUB_SHARED, OWNER, MEMORY_C]);
    assert.equal((await withScopedClient(scope, claimWebhookDelivery))?.id, revokedDelivery);
    await owner.query('UPDATE api_keys SET revoked_at=statement_timestamp() WHERE id=$1::uuid', [OWNER]);
    assert.equal(await withScopedClient(scope, client => deliveryStillAuthorized(client, revokedDelivery)), false);
    assert.equal(await withScopedClient(scope, client => cancelUnauthorizedDelivery(client, revokedDelivery)), true);

    await owner.query('UPDATE api_keys SET revoked_at=statement_timestamp() WHERE id=$1::uuid', [WORKER]);
    await assert.rejects(withScopedClient(scope, claimWebhookDelivery), error => (error as { code?: string }).code === '42501');
    await owner.query(`UPDATE api_keys SET revoked_at=NULL, expires_at=statement_timestamp() - interval '1 second'
      WHERE id=$1::uuid`, [WORKER]);
    await assert.rejects(withScopedClient(scope, claimWebhookDelivery), error => (error as { code?: string }).code === '42501');
  } finally {
    setPoolForTesting(null);
    await appPool?.end().catch(() => undefined);
    await owner.end().catch(() => undefined);
  }
});
