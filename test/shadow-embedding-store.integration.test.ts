import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ShadowEmbeddingStore } from '../src/shadow-embedding-store.js';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import { planEmbeddingChunks } from '../src/embedding-chunks.js';
import { LocalEmbeddingClient } from '../src/local-embedding-client.js';
import { runShadowBatch } from '../src/shadow-embedding-worker.js';
import { auditShadowPage } from '../src/shadow-embedding-audit.js';
import { readShadowEmbeddingStatus } from '../src/shadow-embedding-status.js';

const url = process.env.SHADOW_EMBEDDING_TEST_DATABASE_URL;
const vector = () => Array(768).fill(1 / Math.sqrt(768));
const limits = { maxParents: 10, maxSourceBytes: 100_000, maxTokens: 10_000, maxElapsedMs: 30_000, maxAttempts: 3 };
function fakeClient(status?: number) {
  return new LocalEmbeddingClient({ baseUrl: 'http://localhost:1234', bearerToken: 'synthetic',
    runtime: { contractId: QWEN_CONTRACT_ID, artifactSha256: QWEN_CHUNK_CONTRACT.artifactSha256,
      runtimeContract: QWEN_CHUNK_CONTRACT.runtimeContract, acceptanceReceiptSha256: 'b'.repeat(64) },
    beforeInference: async () => {}, fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      if (status) return new Response('private error body', { status, headers: { 'Retry-After': '10' } });
      const body = JSON.parse(init?.body as string);
      return String(url).endsWith('/tokenize') ? Response.json({ tokens: Array(body.content.length + 2).fill(1) })
        : Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: Array(1024).fill(1) })),
          usage: { prompt_tokens: body.input.reduce((sum: number, s: string) => sum + s.length + 2, 0) } });
    }) as typeof fetch });
}

async function fixture(run: (ctx: { pool: pg.Pool; store: ShadowEmbeddingStore; parent: string; runId: string }) => Promise<void>) {
  assert.equal(new URL(url!).pathname, '/total_recall_reembedding_test', 'dedicated test database required');
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const runId = randomUUID(), parent = randomUUID();
  try {
    assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'total_recall_reembedding_test');
    await pool.query(`INSERT INTO embedding_contracts(id,canonical_json,capture_enabled) VALUES($1,$2,true)
      ON CONFLICT(id) DO UPDATE SET capture_enabled=true`, [QWEN_CONTRACT_ID, JSON.stringify(QWEN_CHUNK_CONTRACT)]);
    await pool.query(`DO $block$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
        WHERE i.inhparent='memory_embedding_chunks'::regclass
          AND pg_get_expr(c.relpartbound,c.oid) LIKE '%${QWEN_CONTRACT_ID}%') THEN
        CREATE TABLE memory_embedding_chunks_qwen_test PARTITION OF memory_embedding_chunks
          FOR VALUES IN ('${QWEN_CONTRACT_ID}');
      END IF;
    END $block$`);
    await pool.query(`INSERT INTO embedding_runs(id,contract_id,release_sha,manifest,status)
      VALUES($1,$2,$3,'{"synthetic":true}','running')`, [runId, QWEN_CONTRACT_ID, 'a'.repeat(40)]);
    await pool.query(`INSERT INTO memories(id,content,source,namespace,client_id)
      VALUES($1,'first paragraph\n\nlast paragraph','shadow-store-test','personal','synthetic')`, [parent]);
    const store = new ShadowEmbeddingStore(pool, runId);
    await store.verifyDatabase('total_recall_reembedding_test');
    await run({ pool, store, parent, runId });
  } finally {
    await pool.query('DELETE FROM memories WHERE id=$1', [parent]);
    await pool.query('DELETE FROM embedding_work_items WHERE parent_id=$1', [parent]);
    await pool.query('DELETE FROM embedding_runs WHERE id=$1', [runId]);
    await pool.end();
  }
}

test('shadow store commits a complete manifest atomically and retains canonical vectors', { skip: !url }, async () => {
  await fixture(async ({ pool, store, parent }) => {
    const claim = (await store.claim())!; assert.equal(claim.parentId, parent);
    const source = (await store.loadSource(claim))!;
    const plan = await planEmbeddingChunks(source.text, async text => text.length + 2);
    assert.equal(await store.commitMemory(claim, source, plan, plan.chunks.map(vector)), true);
    const m = (await pool.query('SELECT is_current,chunk_count FROM memory_embedding_manifests WHERE parent_id=$1', [parent])).rows[0];
    assert.deepEqual(m, { is_current: true, chunk_count: 2 });
    assert.equal((await pool.query('SELECT embedding FROM memories WHERE id=$1', [parent])).rows[0].embedding, null);
    assert.equal(await store.claim(), null);
    assert.equal(await store.commitMemory(claim, source, plan, plan.chunks.map(vector)), false, 'duplicate commit fenced');
  });
});

test('edited and expired parents cannot publish stale or ineligible results', { skip: !url }, async () => {
  await fixture(async ({ pool, store, parent }) => {
    const claim = (await store.claim())!, source = (await store.loadSource(claim))!;
    const plan = await planEmbeddingChunks(source.text, async text => text.length + 2);
    await pool.query('UPDATE memories SET content=$2 WHERE id=$1', [parent, 'new revision']);
    assert.equal(await store.renew(claim), false);
    assert.equal(await store.commitMemory(claim, source, plan, plan.chunks.map(vector)), false);
    const next = (await store.claim())!, newer = (await store.loadSource(next))!;
    const nextPlan = await planEmbeddingChunks(newer.text, async text => text.length + 2);
    await pool.query("UPDATE memories SET expires_at=now()-interval '1 second' WHERE id=$1", [parent]);
    assert.equal(await store.commitMemory(next, newer, nextPlan, [vector()]), false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM memory_embedding_manifests WHERE parent_id=$1', [parent])).rows[0].n, 0);
  });
});

test('trigger-owned revision changes from metadata and tags enqueue fresh work', { skip: !url }, async () => {
  await fixture(async ({ pool, store, parent }) => {
    await runShadowBatch(store, fakeClient(), limits, async () => {});
    for (const column of ['metadata', 'tags']) {
      await pool.query(column === 'metadata'
        ? `UPDATE memories SET metadata='{"synthetic":"changed"}'::jsonb WHERE id=$1`
        : `UPDATE memories SET tags=ARRAY['synthetic-changed'] WHERE id=$1`, [parent]);
      const row = (await pool.query(`SELECT w.state,f.is_current FROM embedding_work_items w
        JOIN memory_embedding_manifests f ON f.parent_id=w.parent_id AND f.contract_id=w.contract_id
        WHERE w.parent_id=$1`, [parent])).rows[0];
      assert.deepEqual(row, { state: 'pending', is_current: false });
      assert.equal((await runShadowBatch(store, fakeClient(), limits, async () => {})).completeParents, 1);
    }
  });
});

test('future-valid parents are durably deferred and become embeddable without a source mutation', { skip: !url }, async () => {
  await fixture(async ({ pool, store, parent }) => {
    await pool.query("UPDATE memories SET valid_from=statement_timestamp()+interval '150 milliseconds' WHERE id=$1", [parent]);
    const first = await runShadowBatch(store, fakeClient(), limits, async () => {});
    assert.equal(first.excludedParents, 0);
    assert.equal(first.completeParents, 0);
    const deferred = (await pool.query(`SELECT state,error_code,attempts,next_attempt_at>=m.valid_from AS correctly_scheduled
      FROM embedding_work_items w JOIN memories m ON m.id=w.parent_id WHERE w.parent_id=$1`, [parent])).rows[0];
    assert.deepEqual(deferred, { state: 'retry', error_code: 'embedding.valid_from_deferred', attempts: 0, correctly_scheduled: true });
    await new Promise(resolve => setTimeout(resolve, 200));
    const second = await runShadowBatch(store, fakeClient(), limits, async () => {});
    assert.equal(second.completeParents, 1);
    assert.equal((await pool.query('SELECT state FROM embedding_work_items WHERE parent_id=$1', [parent])).rows[0].state, 'complete');
  });
});

test('lease expiry permits recovery and fences the abandoned owner', { skip: !url }, async () => {
  await fixture(async ({ pool, store, parent, runId }) => {
    const old = (await store.claim())!;
    const source = (await store.loadSource(old))!, plan = await planEmbeddingChunks(source.text, async text => text.length + 2);
    await pool.query("UPDATE embedding_work_items SET lease_until=now()-interval '1 second' WHERE parent_id=$1", [parent]);
    const replacement = new ShadowEmbeddingStore(pool, runId), fresh = (await replacement.claim())!;
    assert.notEqual(fresh.owner, old.owner);
    assert.notEqual(fresh.generation, old.generation);
    assert.equal(await store.settle(old, 'failed', 'embedding.test'), false);
    assert.equal(await store.commitMemory(old, source, plan, plan.chunks.map(vector)), false);
    assert.equal(await replacement.commitMemory(fresh, source, plan, plan.chunks.map(vector)), true);
  });
});

test('injected interruption rolls back partial chunks and does not advertise coverage', { skip: !url }, async () => {
  await fixture(async ({ pool, store, parent }) => {
    const claim = (await store.claim())!, source = (await store.loadSource(claim))!;
    const plan = await planEmbeddingChunks(source.text, async text => text.length + 2);
    await pool.query(`CREATE FUNCTION shadow_test_interrupt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.ordinal=1 THEN RAISE EXCEPTION 'synthetic interruption'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER shadow_test_interrupt BEFORE INSERT ON memory_embedding_chunks
      FOR EACH ROW EXECUTE FUNCTION shadow_test_interrupt()`);
    try {
      await assert.rejects(store.commitMemory(claim, source, plan, plan.chunks.map(vector)), /synthetic interruption/);
      assert.equal((await pool.query('SELECT count(*)::int n FROM memory_embedding_manifests WHERE parent_id=$1', [parent])).rows[0].n, 0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM memory_embedding_chunks WHERE parent_id=$1', [parent])).rows[0].n, 0);
      assert.equal((await pool.query('SELECT state FROM embedding_work_items WHERE parent_id=$1', [parent])).rows[0].state, 'claimed');
    } finally {
      await pool.query('DROP TRIGGER shadow_test_interrupt ON memory_embedding_chunks; DROP FUNCTION shadow_test_interrupt()');
    }
  });
});

test('finite worker commits all chunks and reports parents separately from vectors', { skip: !url }, async () => {
  await fixture(async ({ store }) => {
    const receipt = await runShadowBatch(store, fakeClient(), limits, async () => {});
    assert.equal(receipt.completeParents, 1); assert.equal(receipt.vectors, 2);
    assert.equal(receipt.failedParents, 0); assert.equal(receipt.state, 'bounded_batch_finished');
  });
});

test('worker pauses before claiming on resource failure and before inference on parent budget breach', { skip: !url }, async () => {
  await fixture(async ({ pool, store, parent, runId }) => {
    const receipt = await runShadowBatch(store, fakeClient(), limits, async () => { throw new Error('pressure'); });
    assert.equal(receipt.state, 'paused'); assert.equal(receipt.stopCode, 'embedding.resource_guard');
    assert.equal((await pool.query('SELECT state FROM embedding_work_items WHERE parent_id=$1', [parent])).rows[0].state, 'pending');
    await pool.query("UPDATE embedding_runs SET status='running' WHERE id=$1", [runId]);
    const budget = await runShadowBatch(store, fakeClient(), { ...limits, maxTokens: 1 }, async () => {});
    assert.equal(budget.stopCode, 'embedding.parent_token_budget'); assert.equal(budget.vectors, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM memory_embedding_manifests WHERE parent_id=$1', [parent])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT attempts FROM embedding_work_items WHERE parent_id=$1', [parent])).rows[0].attempts, 0,
      'planned batch boundaries do not consume a processing attempt');
  });
});

test('fenced lifecycle settlement is reported stale rather than as a successful exclusion', { skip: !url }, async () => {
  await fixture(async ({ pool, store, parent, runId }) => {
    await pool.query("UPDATE memories SET expires_at=statement_timestamp()-interval '1 second' WHERE id=$1", [parent]);
    const originalLoad = store.loadSource.bind(store);
    store.loadSource = async claim => {
      const source = await originalLoad(claim);
      await pool.query("UPDATE embedding_work_items SET lease_until=statement_timestamp()-interval '1 second' WHERE parent_id=$1", [parent]);
      return source;
    };
    const receipt = await runShadowBatch(store, fakeClient(), limits, async () => {});
    assert.equal(receipt.excludedParents, 0);
    assert.equal(receipt.staleParents, 1);
    assert.equal((await pool.query('SELECT status FROM embedding_runs WHERE id=$1', [runId])).rows[0].status, 'running');
  });
});

test('systemic provider failure pauses run; temporary outage retries without coverage', { skip: !url }, async () => {
  await fixture(async ({ pool, store, parent, runId }) => {
    const temporary = await runShadowBatch(store, fakeClient(503), limits, async () => {});
    assert.equal(temporary.retriedParents, 1); assert.equal(temporary.completeParents, 0);
    assert.equal((await pool.query('SELECT status FROM embedding_runs WHERE id=$1', [runId])).rows[0].status, 'running');
    await pool.query('UPDATE embedding_work_items SET next_attempt_at=now() WHERE parent_id=$1', [parent]);
    const systemic = await runShadowBatch(store, fakeClient(401), limits, async () => {});
    assert.equal(systemic.state, 'paused'); assert.equal(systemic.failedParents, 1);
    assert.equal(systemic.stopCode, 'embedding.http_401');
  });
});

test('nonzero subscription query targets are captured, embedded, committed and invalidated on edit', { skip: !url }, async () => {
  await fixture(async ({ pool, store }) => {
    await store.settle((await store.claim())!, 'excluded', 'embedding.synthetic_skip');
    const key = randomUUID(), subscription = randomUUID();
    try {
      await pool.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions)
        VALUES($1::uuid,($1::uuid)::text,'synthetic-subscription',ARRAY['personal'],ARRAY['read','write'])`, [key]);
      await pool.query(`INSERT INTO memory_subscriptions(id,api_key_id,query_text,query_embedding,
        embedding_provider,embedding_model,embedding_dimensions,threshold,webhook_url_ciphertext,
        webhook_url_iv,webhook_url_tag,signing_secret_ciphertext,signing_secret_iv,signing_secret_tag,
        encryption_key_id,idempotency_key,request_hash)
        VALUES($1,$2,'find this fact',$3::vector,'gemini','gemini-embedding-2-preview',768,0.75,
        decode('00','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),
        decode('00','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'test','test',repeat('a',64))`,
      [subscription, key, `[${vector().join(',')}]`]);
      const receipt = await runShadowBatch(store, fakeClient(), limits, async () => {});
      assert.equal(receipt.completeParents, 1); assert.equal(receipt.vectors, 1);
      assert.equal((await pool.query('SELECT count(*)::int n FROM subscription_embedding_targets WHERE subscription_id=$1', [subscription])).rows[0].n, 1);
      await pool.query("UPDATE memory_subscriptions SET query_text='changed fact' WHERE id=$1", [subscription]);
      assert.equal((await pool.query('SELECT count(*)::int n FROM subscription_embedding_targets WHERE subscription_id=$1', [subscription])).rows[0].n, 0);
      assert.equal((await pool.query('SELECT state FROM embedding_work_items WHERE parent_id=$1', [subscription])).rows[0].state, 'pending');
    } finally {
      await pool.query('DELETE FROM memory_subscriptions WHERE id=$1', [subscription]);
      await pool.query('DELETE FROM embedding_work_items WHERE parent_id=$1', [subscription]);
      await pool.query('DELETE FROM api_keys WHERE id=$1', [key]);
    }
  });
});

test('independent audit checks actual chunks rather than trusting ledger success', { skip: !url }, async () => {
  await fixture(async ({ pool, store, parent }) => {
    await runShadowBatch(store, fakeClient(), limits, async () => {});
    const connection = await pool.connect();
    try {
      const verified = await auditShadowPage(connection, 'total_recall_reembedding_test');
      assert.equal(verified.parents.find(p => p.parentId === parent)?.state, 'verified_current');
      assert.ok(!JSON.stringify(verified).includes('first paragraph'), 'receipt excludes source text');
      await pool.query('DELETE FROM memory_embedding_chunks WHERE parent_id=$1 AND ordinal=0', [parent]);
      const summary = await readShadowEmbeddingStatus(connection, 'total_recall_reembedding_test');
      assert.equal(summary.coverageSummaryOnly, true);
      assert.equal(summary.completion, 'not_evaluated');
      const broken = await auditShadowPage(connection, 'total_recall_reembedding_test');
      assert.equal(broken.parents.find(p => p.parentId === parent)?.state, 'stale');
      assert.equal((await pool.query('SELECT state FROM embedding_work_items WHERE parent_id=$1', [parent])).rows[0].state, 'pending',
        'chunk mutation immediately invalidates the manifest and queues repair');
    } finally { connection.release(); }
  });
});

test('audit rejects code-point splits even if stored byte hashes match the damaged spans', { skip: !url }, async () => {
  await fixture(async ({ pool, store, parent }) => {
    const text = '🙂\n\nsecond';
    await pool.query('UPDATE memories SET content=$2 WHERE id=$1', [parent, text]);
    await runShadowBatch(store, fakeClient(), limits, async () => {});
    await pool.query(`UPDATE memory_embedding_chunks SET core_end=1,
      chunk_sha256=encode(digest(substring(convert_to($2,'UTF8') FROM 1 FOR 1),'sha256'),'hex')
      WHERE parent_id=$1 AND ordinal=0`, [parent, text]);
    await pool.query(`UPDATE memory_embedding_chunks SET core_start=1,
      chunk_sha256=encode(digest(substring(convert_to($2,'UTF8') FROM 2),'sha256'),'hex')
      WHERE parent_id=$1 AND ordinal=1`, [parent, text]);
    assert.equal((await pool.query('SELECT is_current FROM memory_embedding_manifests WHERE parent_id=$1', [parent])).rows[0].is_current, false);
    assert.equal((await pool.query('SELECT state FROM embedding_work_items WHERE parent_id=$1', [parent])).rows[0].state, 'pending');
    await assert.rejects(pool.query('UPDATE memory_embedding_manifests SET is_current=true WHERE parent_id=$1', [parent]),
      /invalid byte sequence|embedding\.current_manifest_invalid/);
    const connection = await pool.connect();
    try {
      const receipt = await auditShadowPage(connection, 'total_recall_reembedding_test');
      assert.equal(receipt.parents.find(p => p.parentId === parent)?.state, 'stale');
    } finally { connection.release(); }
  });
});
