import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { LocalEmbeddingClient } from '../src/local-embedding-client.js';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import { setLocalServingClientForTesting } from '../src/local-embedding-runtime.js';
import { setPoolForTesting, dbScopeFromAuth, withScopedClient } from '../src/db.js';
import { activateAttestedServing } from './shadow-embedding-fixtures.js';
import type { AuthContext } from '../src/types.js';

const url = process.env.SHADOW_EMBEDDING_TEST_DATABASE_URL;

test('durable local writes publish complete chunks before readiness and fence queued updates', { skip: !url }, async t => {
  assert.equal(new URL(url!).pathname, '/total_recall_reembedding_test');
  const owner = new pg.Pool({ connectionString: url, max: 2 });
  const appUrl = new URL(url!); appUrl.username = 'total_recall_app';
  const app = new pg.Pool({ connectionString: appUrl.toString(), max: 2 });
  const original = { ...process.env };
  const key = randomUUID(), editorKey = randomUUID(), source = `local-queue-${randomUUID()}`;
  const auth: AuthContext = { keyId: key, name: source, namespaces: ['personal'], permissions: ['read','write'], maxAccessLevel: 'normal' };
  process.env.NODE_ENV = 'test'; process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = QWEN_CONTRACT_ID;
  delete process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
  process.env.MEMORY_INGESTION_QUEUE_ENABLED = 'true'; process.env.MEMORY_INGESTION_UPDATE_ENABLED = 'true';
  process.env.MEMORY_STORE_INLINE_EMBED_MS = '0';
  let run: string | undefined;
  const subscription = randomUUID();
  let providerUnavailable=false;
  const client = new LocalEmbeddingClient({ baseUrl: 'http://localhost:1234', bearerToken: 'synthetic',
    runtime: { contractId: QWEN_CONTRACT_ID, artifactSha256: QWEN_CHUNK_CONTRACT.artifactSha256,
      runtimeContract: QWEN_CHUNK_CONTRACT.runtimeContract, acceptanceReceiptSha256: 'e'.repeat(64) },
    beforeInference: async () => {}, fetch: (async (target: string | URL | Request, init?: RequestInit) => {
      if (providerUnavailable) throw new Error('synthetic provider unavailable');
      const body = JSON.parse(String(init?.body));
      if (String(target).endsWith('/tokenize')) return Response.json({ tokens: Array(Math.max(1, Math.ceil(Buffer.byteLength(body.content)/8))).fill(1) });
      return Response.json({ data: body.input.map((_: string, index: number) => ({ index,
        embedding: Array.from({ length: QWEN_CHUNK_CONTRACT.nativeDimensions }, (_, i) => i === 0 ? 1 : 0) })),
        usage: { prompt_tokens: body.input.reduce((sum: number, input: string) => sum + Math.max(1, Math.ceil(Buffer.byteLength(input)/8)), 0) } });
    }) as typeof fetch });
  try {
    run = await activateAttestedServing(owner);
    await owner.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      VALUES($1,$2,$3,ARRAY['personal'],ARRAY['read','write'],'normal')`, [key, key, source]);
    await owner.query('ALTER TABLE memories ENABLE TRIGGER memories_subscription_enqueue');
    await owner.query('ALTER TABLE memories ENABLE TRIGGER memories_subscription_ready_enqueue');
    const unit = `[1,${Array(767).fill(0).join(',')}]`;
    await owner.query(`INSERT INTO memory_subscriptions(id,api_key_id,query_text,query_embedding,
      embedding_provider,embedding_model,embedding_dimensions,threshold,exclude_self,
      webhook_url_ciphertext,webhook_url_iv,webhook_url_tag,signing_secret_ciphertext,
      signing_secret_iv,signing_secret_tag,encryption_key_id,idempotency_key,request_hash,created_at)
      VALUES($1,$2,'target query',$3::vector,'llama.cpp',$4,768,0.9,false,
        decode('00','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),decode('00','hex'),
        decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'test',($1::uuid)::text,repeat('a',64),clock_timestamp()-interval '1 second')`,
    [subscription, key, unit, QWEN_CONTRACT_ID]);
    await owner.query("INSERT INTO subscription_namespaces(subscription_id,api_key_id,namespace) VALUES($1,$2,'personal')", [subscription,key]);
    await owner.query(`INSERT INTO subscription_embedding_targets(contract_id,subscription_id,source_sha256,formatted_tokens,embedding)
      VALUES($1,$2,encode(digest('target query','sha256'),'hex'),8,$3::vector)`, [QWEN_CONTRACT_ID,subscription,unit]);
    await owner.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      VALUES($1,$2,'local-editor',ARRAY['personal'],ARRAY['read','write'],'normal')`, [editorKey,editorKey]);
    setPoolForTesting(app); setLocalServingClientForTesting(client);
    // Dynamic imports ensure the physical active profile is selected after local activation.
    const { memoryStore, storeSchema } = await import('../src/tools/store.js');
    const { publishPreparedLocalDocument } = await import('../src/local-embedding-consumers.js');
    const { memoryUpdate } = await import('../src/tools/update.js');
    const { claimIngestionJob, embedWithinBudget, finalizeIngestionJob } = await import('../src/ingestion.js');
    const { processIngestionJob } = await import('../src/ingestion-worker.js');
    const content = `${'a'.repeat(2500)}\n\nlast paragraph`;
    const first = await memoryStore(storeSchema.parse({ content, namespace: 'personal', source, dedupe: true }), auth);
    const second = await memoryStore(storeSchema.parse({ content, namespace: 'personal', source, dedupe: true }), auth);
    assert.equal(first.state, 'queued'); assert.equal(second.state, 'queued');
    const claim = async (id: string) => {
      const job = await claimIngestionJob(dbScopeFromAuth(auth), { memoryId: id, inline: true });
      assert.ok(job); return job;
    };
    const manifest = async (id: string) => (await owner.query(`SELECT f.is_current,f.source_revision,m.revision,f.chunk_count,
      (SELECT count(*)::int FROM memory_embedding_chunks c WHERE c.parent_id=m.id AND c.contract_id=f.contract_id) AS actual
      FROM memory_embedding_manifests f JOIN memories m ON m.id=f.parent_id WHERE f.parent_id=$1`, [id])).rows[0];
    const recovered = await memoryStore(storeSchema.parse({ content: 'shadow completed before durable ingestion',
      namespace: 'personal', source, dedupe: false }), auth);
    const recoveredJob = await claim(recovered.id);
    const recoveredPrepared = await embedWithinBudget(recoveredJob.content,5000);
    await withScopedClient(dbScopeFromAuth(auth), db => publishPreparedLocalDocument(
      db,recovered.id,recoveredPrepared.localPrepared,{ ingestionLease:recoveredJob.lease_token }));
    const beforeRecovery = (await owner.query(`SELECT j.status,m.embedding IS NOT NULL AS compatibility_embedding,w.state AS shadow_state
      FROM memory_ingestion_jobs j JOIN memories m ON m.id=j.memory_id
      JOIN embedding_work_items w ON w.parent_id=m.id AND w.parent_type='memory' AND w.contract_id=$2
      WHERE j.memory_id=$1`,[recovered.id,QWEN_CONTRACT_ID])).rows[0];
    assert.deepEqual(beforeRecovery,{ status:'processing',compatibility_embedding:false,shadow_state:'complete' });
    providerUnavailable=true;
    try {
      await assert.rejects(embedWithinBudget(recoveredJob.content,5000),/synthetic provider unavailable/);
      await processIngestionJob(recoveredJob);
    } finally { providerUnavailable=false; }
    const afterRecovery = (await owner.query(`SELECT j.status,m.embedding IS NOT NULL AS compatibility_embedding,
        f.is_current,f.source_revision=m.revision AS current_revision
      FROM memory_ingestion_jobs j JOIN memories m ON m.id=j.memory_id
      JOIN memory_embedding_manifests f ON f.parent_id=m.id AND f.contract_id=$2
      WHERE j.memory_id=$1`,[recovered.id,QWEN_CONTRACT_ID])).rows[0];
    assert.deepEqual(afterRecovery,{ status:'ready',compatibility_embedding:true,is_current:true,current_revision:true });
    const firstJob = await claim(first.id), prepared = await embedWithinBudget(firstJob.content, 5000);
    assert.ok(prepared.localPrepared!.vectors.length > 1, 'all long-parent chunks retained');
    await assert.rejects(withScopedClient(dbScopeFromAuth(auth), db => publishPreparedLocalDocument(db, first.id,
      prepared.localPrepared, { ingestionLease: randomUUID() })), /embedding.publish_unauthorized/);

    await assert.rejects(finalizeIngestionJob(firstJob, { ...prepared, localPrepared: undefined }), /ingestion_vectors_required/);
    assert.equal((await finalizeIngestionJob(firstJob, prepared))?.state, 'ready');
    const current = await manifest(first.id);
    assert.equal(current.is_current, true); assert.equal(current.chunk_count, prepared.localPrepared!.vectors.length);
    assert.equal(current.actual, current.chunk_count); assert.equal(current.source_revision, current.revision);
    assert.equal((await owner.query('SELECT count(*)::int n FROM webhook_deliveries WHERE memory_id=$1', [first.id])).rows[0].n, 1);
    const secondJob = await claim(second.id);
    const deduped = await finalizeIngestionJob(secondJob, await embedWithinBudget(secondJob.content, 5000));
    assert.equal(deduped?.deduplicated, true); assert.equal(deduped?.id, first.id);

    // Every synthetic chunk has the same vector. A shared boilerplate chunk
    // must not cause the rest of a different parent to be discarded.
    const novel = await memoryStore(storeSchema.parse({ content: `${'a'.repeat(2500)}\n\nnovel queued fact`,
      namespace: 'personal', source, dedupe: true }), auth);
    const novelJob = await claim(novel.id);
    const novelResult = await finalizeIngestionJob(novelJob, await embedWithinBudget(novelJob.content, 5000));
    assert.equal(novelResult?.id, novel.id); assert.equal(novelResult?.deduplicated, false);
    process.env.MEMORY_INGESTION_QUEUE_ENABLED = 'false';
    const synchronousNovel = await memoryStore(storeSchema.parse({ content: `${'a'.repeat(2500)}\n\nanother novel fact`,
      namespace: 'personal', source, dedupe: true }), auth);
    assert.equal(synchronousNovel.deduplicated, false);
    assert.notEqual(synchronousNovel.id, first.id);
    process.env.MEMORY_INGESTION_QUEUE_ENABLED = 'true';

    const pendingUpdate = await memoryStore(storeSchema.parse({ content: 'never indexed original', namespace: 'personal', source, dedupe: false }), auth);
    await memoryUpdate({ id: pendingUpdate.id, content: 'replacement is not a creation event' }, auth);
    const replacementJob = await claim(pendingUpdate.id);
    await finalizeIngestionJob(replacementJob, await embedWithinBudget(replacementJob.content, 5000));
    assert.equal((await owner.query('SELECT count(*)::int n FROM webhook_deliveries WHERE memory_id=$1', [pendingUpdate.id])).rows[0].n, 0);
    assert.ok((await owner.query('SELECT processed_at FROM shadow_subscription_insert_events WHERE memory_id=$1', [pendingUpdate.id])).rows[0].processed_at,
      'suppressed prospective event is consumed rather than left to block convergence');

    await memoryUpdate({ id: first.id, content: 'first queued replacement' }, auth);
    const stale = await claim(first.id), staleEmbedding = await embedWithinBudget(stale.content, 5000);
    await memoryUpdate({ id: first.id, content: 'final queued replacement' }, auth);
    assert.equal(await finalizeIngestionJob(stale, staleEmbedding), null, 'old lease must not publish its chunks');
    const fresh = await claim(first.id), freshEmbedding = await embedWithinBudget(fresh.content, 5000);
    assert.equal((await finalizeIngestionJob(fresh, freshEmbedding))?.state, 'ready');
    assert.equal((await manifest(first.id)).is_current, true);
    assert.equal((await manifest(first.id)).source_revision, (await manifest(first.id)).revision);
    assert.equal((await owner.query('SELECT content FROM memories WHERE id=$1', [first.id])).rows[0].content, 'final queued replacement');

    // A queue-off update retains atomic local publication too.
    process.env.MEMORY_INGESTION_UPDATE_ENABLED = 'false';
    await memoryUpdate({ id: first.id, content: 'synchronous replacement' }, auth);
    await memoryUpdate({ id: first.id, content: 'authorized cross-key synchronous replacement' }, { ...auth, keyId: editorKey });
    const synchronous = await manifest(first.id);
    assert.equal(synchronous.is_current, true); assert.equal(synchronous.source_revision, synchronous.revision);

    for (const temporalState of ['future', 'elapsed']) {
      const inactive = await memoryStore(storeSchema.parse({ content: `inactive ${temporalState} original`,
        namespace: 'personal', source, dedupe: false }), auth);
      if (temporalState === 'future') {
        await owner.query("UPDATE memories SET valid_from=statement_timestamp()+interval '1 day' WHERE id=$1", [inactive.id]);
      } else {
        await owner.query("UPDATE memories SET valid_from=statement_timestamp()-interval '2 days',valid_to=statement_timestamp()-interval '1 day' WHERE id=$1", [inactive.id]);
      }
      const edited = await memoryUpdate({ id: inactive.id, content: `inactive ${temporalState} replacement` }, auth);
      assert.equal(edited.content, `inactive ${temporalState} replacement`);
      const inactiveManifest = await manifest(inactive.id);
      assert.ok(!inactiveManifest || !inactiveManifest.is_current, 'temporally inactive updates remain unindexed');
    }

    process.env.MEMORY_INGESTION_UPDATE_ENABLED = 'true';
    await memoryUpdate({ id: first.id, content: 'authorized cross-key queued replacement' }, { ...auth, keyId: editorKey });
    const crossKeyJob = await claim(first.id);
    assert.equal(crossKeyJob.client_id, key);
    assert.equal((await finalizeIngestionJob(crossKeyJob, await embedWithinBudget(crossKeyJob.content, 5000)))?.state, 'ready');
    const historical = await memoryStore(storeSchema.parse({ content: 'historical original', namespace: 'personal', source, dedupe: false }), auth);
    await memoryUpdate({ id: historical.id, content: 'accepted historical replacement' }, auth);
    const historicalJob = await claim(historical.id), historicalEmbedding = await embedWithinBudget(historicalJob.content, 5000);
    await owner.query('UPDATE memories SET superseded_at=statement_timestamp(),valid_to=statement_timestamp() WHERE id=$1', [historical.id]);
    assert.equal((await finalizeIngestionJob(historicalJob, historicalEmbedding))?.state, 'ready');
    assert.equal(await manifest(historical.id), undefined, 'historical completion must not reopen target visibility');

    const external = await memoryStore(storeSchema.parse({ content: 'external incomplete vector', namespace: 'personal', source, dedupe: false }), auth);
    await owner.query(`UPDATE memories SET embedding=$2::vector,embedding_provider='llama.cpp',embedding_model=$3,embedding_dimensions=768 WHERE id=$1`, [external.id,unit,QWEN_CONTRACT_ID]);
    assert.equal(await claimIngestionJob(dbScopeFromAuth(auth), { memoryId: external.id, inline: true }), null);
    assert.equal((await owner.query('SELECT status FROM memory_ingestion_jobs WHERE memory_id=$1', [external.id])).rows[0].status, 'embedding_failed',
      'an external compatibility vector without a complete target manifest must never become ready');

    const revoked = await memoryStore(storeSchema.parse({ content: 'accepted before revocation', namespace: 'personal', source, dedupe: false }), auth);
    const revokedJob = await claim(revoked.id), revokedEmbedding = await embedWithinBudget(revokedJob.content, 5000);
    await owner.query('UPDATE api_keys SET revoked_at=statement_timestamp() WHERE id=$1', [key]);
    assert.equal((await finalizeIngestionJob(revokedJob, revokedEmbedding))?.state, 'ready', 'accepted single-row completion survives key revocation');
    assert.equal((await manifest(revoked.id)).is_current, true);

  } finally {
    setPoolForTesting(null); setLocalServingClientForTesting(undefined); process.env = original;
    await app.end();
    await owner.query('DELETE FROM webhook_deliveries WHERE subscription_id=$1', [subscription]);
    await owner.query('DELETE FROM memory_subscriptions WHERE id=$1', [subscription]);
    await owner.query('DELETE FROM embedding_work_items WHERE parent_id IN (SELECT id FROM memories WHERE source=$1)', [source]);
    await owner.query('DELETE FROM memories WHERE source=$1', [source]);
    await owner.query('DELETE FROM audit_log WHERE client_id=ANY($1::text[])', [[key,editorKey]]);
    await owner.query('DELETE FROM agents WHERE api_key_id=$1', [key]);
    await owner.query('DELETE FROM api_keys WHERE id=ANY($1::uuid[])', [[key,editorKey]]);
    await owner.query('DELETE FROM embedding_serving_settings WHERE cutover_attestation_run_id=$1', [run]);
    await owner.query('DELETE FROM embedding_cutover_attestations WHERE run_id=$1', [run]).catch(() => {});
    await owner.query('DELETE FROM embedding_runs WHERE id=$1', [run]).catch(() => {});
    await owner.end();
  }
});
