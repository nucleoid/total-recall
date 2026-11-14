import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import { CURRENT_PARENT_ELIGIBILITY } from '../src/shadow-embedding-store.js';
import { hashOperationalManifest, inventoryShadowPage, prepareShadowRun, requeueShadowItems,
  setShadowRunState, validateOperationalManifest } from '../src/shadow-embedding-control.js';

const url = process.env.SHADOW_EMBEDDING_TEST_DATABASE_URL;
const expectedDatabase = 'total_recall_reembedding_test';
const ids = {
  lateLow: '05000000-0000-4000-8000-000000000001',
  memory1: '10000000-0000-4000-8000-000000000001',
  memory2: '20000000-0000-4000-8000-000000000001',
  futureMemory: '25000000-0000-4000-8000-000000000001',
  memory3: '30000000-0000-4000-8000-000000000001',
  subscription1: '40000000-0000-4000-8000-000000000001',
  subscription2: '50000000-0000-4000-8000-000000000001',
  subscription3: '60000000-0000-4000-8000-000000000001',
};

function manifest() {
  return { version: 1 as const,
    approval: { reference: 'synthetic/control-integration-approval.json', sha256: 'a'.repeat(64),
      approvedBy: 'synthetic-test-operator', approvedAt: '2026-10-20T00:00:00Z' },
    source: { releaseSha: 'b'.repeat(40) },
    eligibility: { predicate: CURRENT_PARENT_ELIGIBILITY, namespaces: 'all' as const,
      includeNullVectors: true as const, activeSubscriptions: true as const },
    resources: { maxParentsPerBatch: 2, maxSourceBytesPerBatch: 100_000, maxTokensPerBatch: 10_000,
      maxElapsedMsPerBatch: 30_000, maxAttempts: 3, host: { deploymentProfile: 'linux-worker' as const,
        expectedHostname: 'synthetic-worker', diskPath: '/srv/total-recall', minAvailableMemoryBytes: 4_294_967_296,
        minAvailableDiskBytes: 107_374_182_400, maxLoadPerCpu: 1, maxSwapUsedBytes: 134_217_728,
        maxMemoryPsiAvg10: 1, maxCpuPsiAvg10: 5 }, indexBuild: { maintenanceWorkMemMb: 512,
          maxParallelMaintenanceWorkers: 2, lockTimeoutMs: 2_000, statementTimeoutMs: 600_000 } },
    runtime: { acceptanceReceiptSha256: 'c'.repeat(64), artifactSha256: QWEN_CHUNK_CONTRACT.artifactSha256,
      runtimeContract: QWEN_CHUNK_CONTRACT.runtimeContract, expectedRuntimeHost: 'gpu-1', expectedRuntimeMode: 'gpu' as const } };
}

test('control inventory resumes across pages and trigger capture covers IDs behind the cursor', { skip: !url }, async () => {
  assert.equal(new URL(url!).pathname, `/${expectedDatabase}`, 'dedicated disposable database required');
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const client = await pool.connect();
  const key = randomUUID();
  let runId: string | undefined;
  const allParentIds = Object.values(ids);
  try {
    assert.equal((await client.query('SELECT current_database() AS db')).rows[0].db, expectedDatabase);
    // The helper provides an isolated database; reset only shadow control state so this test is rerunnable.
    await client.query('DELETE FROM subscription_embedding_targets');
    await client.query('DELETE FROM memory_embedding_chunks');
    await client.query('DELETE FROM memory_embedding_manifests');
    await client.query('DELETE FROM embedding_work_items');
    await client.query('DELETE FROM embedding_runs');
    await client.query('UPDATE embedding_contracts SET capture_enabled=false WHERE id=$1', [QWEN_CONTRACT_ID]);
    await client.query(`INSERT INTO memories(id,content,source,namespace,client_id) VALUES
      ($1,'one','control-test','personal','synthetic'),($2,'two','control-test','work','synthetic'),
      ($3,'three','control-test','my-life','synthetic')`, [ids.memory1, ids.memory2, ids.memory3]);
    await client.query(`INSERT INTO memories(id,content,source,namespace,client_id,valid_from)
      VALUES($1,'future','control-test','personal','synthetic',statement_timestamp()+interval '1 day')`, [ids.futureMemory]);
    await client.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions)
      VALUES($1::uuid,($1::uuid)::text,'control-test',ARRAY['personal'],ARRAY['read','write'])`, [key]);
    const vector = `[${Array(768).fill(1 / Math.sqrt(768)).join(',')}]`;
    for (const [index, id] of [ids.subscription1, ids.subscription2, ids.subscription3].entries()) {
      await client.query(`INSERT INTO memory_subscriptions(id,api_key_id,query_text,query_embedding,
        embedding_provider,embedding_model,embedding_dimensions,threshold,webhook_url_ciphertext,
        webhook_url_iv,webhook_url_tag,signing_secret_ciphertext,signing_secret_iv,signing_secret_tag,
        encryption_key_id,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4::vector,'gemini','gemini-embedding-2-preview',768,0.75,
        decode('00','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),
        decode('00','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'test',$5,repeat($6,64))`,
      [id, key, `query-${index}`, vector, `control-${index}`, String(index + 1)]);
    }
    const value = manifest();
    const envelope = validateOperationalManifest(value, hashOperationalManifest(value));
    const prepared = await prepareShadowRun(client, expectedDatabase, envelope);
    runId = prepared.id;
    assert.equal(prepared.status, 'prepared'); assert.equal(prepared.captureEnabled, false);
    await assert.rejects(setShadowRunState(client, expectedDatabase, runId!, envelope, 'start'), /inventory_incomplete/);

    const first = await inventoryShadowPage(client, expectedDatabase, runId!, envelope, 2);
    assert.equal(first.parentType, 'memory'); assert.equal(first.inserted, 2);
    const writer=await pool.connect();let begins=0,second;
    try {
      const inventoryClient=Object.create(client) as pg.PoolClient;
      inventoryClient.query=(async(...args:any[])=>{if(args[0]==='BEGIN'&&++begins===2)await writer.query(`INSERT INTO memories(id,content,source,namespace,client_id)
          VALUES($1,'captured after cursor','control-test','shared','synthetic')`,[ids.lateLow]);return (client.query as any)(...args);}) as any;
      second=await inventoryShadowPage(inventoryClient, expectedDatabase, runId!, envelope, 2);
    } finally { writer.release(); }
    assert.equal(second.parentType, 'memory'); assert.equal(second.inserted, 2, 'normal cursor includes future-valid candidates');
    const third = await inventoryShadowPage(client, expectedDatabase, runId!, envelope, 2);
    assert.equal(third.parentType, 'subscription'); assert.equal(third.inserted, 2);
    const fourth = await inventoryShadowPage(client, expectedDatabase, runId!, envelope, 2);
    assert.equal(fourth.parentType, 'subscription'); assert.equal(fourth.inserted, 1);
    const final = await inventoryShadowPage(client, expectedDatabase, runId!, envelope, 2);
    assert.equal(final.inventory_complete, true);
    const queued = await client.query(`SELECT parent_type,parent_id FROM embedding_work_items
      WHERE parent_id=ANY($1::uuid[]) ORDER BY parent_id`, [allParentIds]);
    assert.equal(queued.rows.length, 8);
    assert.ok(queued.rows.some(row => row.parent_id === ids.lateLow), 'trigger captured UUID below saved cursor');
    assert.ok(queued.rows.some(row => row.parent_id === ids.futureMemory), 'future-valid preexisting row is durably inventoried');

    const drifted = manifest(); drifted.resources.maxParentsPerBatch = 3;
    const driftedEnvelope = validateOperationalManifest(drifted, hashOperationalManifest(drifted));
    await assert.rejects(setShadowRunState(client, expectedDatabase, runId!, driftedEnvelope, 'start'), /run_manifest_identity/);
    await setShadowRunState(client, expectedDatabase, runId!, envelope, 'start');
    await client.query(`UPDATE embedding_work_items SET state='failed',error_code='embedding.synthetic'
      WHERE contract_id=$1 AND parent_type='memory' AND parent_id=$2`, [QWEN_CONTRACT_ID, ids.memory1]);
    await assert.rejects(requeueShadowItems(client, expectedDatabase, runId!, envelope, 'memory', [ids.memory1]), /requeue_run_state/);
    await setShadowRunState(client, expectedDatabase, runId!, envelope, 'pause');
    assert.deepEqual((await requeueShadowItems(client, expectedDatabase, runId!, envelope, 'memory', [ids.memory1])).requeued, [ids.memory1]);
    assert.equal((await setShadowRunState(client, expectedDatabase, runId!, envelope, 'resume')).status, 'running');
  } finally {
    if (runId) await client.query("UPDATE embedding_runs SET status='paused' WHERE id=$1 AND status='running'", [runId]);
    await client.query('DELETE FROM memory_subscriptions WHERE id=ANY($1::uuid[])', [[ids.subscription1, ids.subscription2, ids.subscription3]]);
    await client.query('DELETE FROM memories WHERE id=ANY($1::uuid[])', [[ids.lateLow, ids.memory1, ids.memory2, ids.futureMemory, ids.memory3]]);
    await client.query('DELETE FROM embedding_work_items WHERE parent_id=ANY($1::uuid[])', [allParentIds]);
    if (runId) await client.query('DELETE FROM embedding_runs WHERE id=$1', [runId]);
    await client.query('DELETE FROM api_keys WHERE id=$1', [key]);
    client.release(); await pool.end();
  }
});
