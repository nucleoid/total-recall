import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import request from 'supertest';
import { loadMigrationInventory, runMigrations } from '../scripts/migrate.js';
import { provisionDatabase } from '../scripts/provision-db.js';
import { finalizeMemoryValidity } from '../scripts/finalize-memory-validity.js';
import { hashKey } from '../src/auth.js';
import { dbScopeFromAuth, setPoolForTesting, withScopedClient } from '../src/db.js';
import { ACTIVE_EMBEDDING_PROFILE } from '../src/embedding.js';
import { acceptMemory, claimIngestionJob, finalizeIngestionJob, failIngestionJob } from '../src/ingestion.js';
import { rankMemories } from '../src/search.js';
import { runIngestionWorker } from '../src/ingestion-worker.js';
import { memoryUpdate } from '../src/tools/update.js';
import { memoryForget } from '../src/tools/forget.js';
import type { AuthContext } from '../src/types.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const adminId = '33333333-3333-4333-8333-333333333333';
const auth: AuthContext = { keyId: ownerId, name: 'update-owner', namespaces: ['shared'], permissions: ['read', 'write', 'delete'], maxAccessLevel: 'secret' };
const other: AuthContext = { ...auth, keyId: otherId, name: 'update-other' };
const admin: AuthContext = { ...auth, keyId: adminId, name: 'update-worker', permissions: ['admin', 'read', 'write'] };
const vector = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0);
const embedding = { ...ACTIVE_EMBEDDING_PROFILE, vector };

test('queued content updates on isolated PostgreSQL preserve durable content and fences', { timeout: 180000 }, async t => {
  execFileSync('docker', ['version'], { stdio: 'ignore' });
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
  const container = execFileSync('docker', ['run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=test-only', '-p', `127.0.0.1:${port}:5432`, process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16'], { encoding: 'utf8' }).trim();
  let owner: pg.Client | undefined; let pool: pg.Pool | undefined;
  const env = { ...process.env }; const originalFetch = globalThis.fetch;
  t.after(async () => {
    setPoolForTesting(null); await pool?.end(); await owner?.end();
    execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    process.env = env; globalThis.fetch = originalFetch;
  });
  for (let i = 0; i < 100; i++) {
    const client = new pg.Client({ connectionString: `postgresql://postgres:test-only@127.0.0.1:${port}/postgres`, connectionTimeoutMillis: 2000 });
    try { await client.connect(); owner = client; break; }
    catch { await client.end(); await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(owner);
  await owner.query('CREATE EXTENSION vector');
  await provisionDatabase(owner, { appPassword: 'app-test-only', rotateAppPassword: false });
  await runMigrations(owner, loadMigrationInventory(fileURLToPath(new URL('../migrations', import.meta.url))), { lockTimeoutMs: 5000 });
  await finalizeMemoryValidity(owner);
  pool = new pg.Pool({ connectionString: `postgresql://total_recall_app:app-test-only@127.0.0.1:${port}/postgres` }); setPoolForTesting(pool);
  for (const key of [auth, other, admin]) await owner.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level) VALUES ($1,$2,$3,$4,$5,$6)`, [key.keyId, hashKey(`tr_${key.name}`), key.name, key.namespaces, key.permissions, key.maxAccessLevel]);
  const agent = (await owner.query(`INSERT INTO agents(name,type,api_key_id) VALUES ('update-test','system',$1) RETURNING id`, [ownerId])).rows[0].id;
  process.env.MEMORY_INGESTION_QUEUE_ENABLED = 'true'; process.env.MEMORY_INGESTION_UPDATE_ENABLED = 'true'; process.env.MEMORY_STORE_INLINE_EMBED_MS = '0';
  const create = async (content: string, ready = true) => {
    const accepted = await acceptMemory({ content, namespace: 'shared', access_level: 'normal', tags: [], metadata: {}, dedupe: false }, auth, agent);
    if (ready) await finalizeIngestionJob(await claim(accepted.id), embedding);
    return accepted.id;
  };
  const claim = async (id: string, actor = auth) => {
    const job = await claimIngestionJob(dbScopeFromAuth(actor), { memoryId: id, inline: true }); assert.ok(job); return job;
  };
  const row = async (id: string) => (await owner!.query('SELECT * FROM memories WHERE id=$1', [id])).rows[0];
  const job = async (id: string) => (await owner!.query('SELECT * FROM memory_ingestion_jobs WHERE memory_id=$1', [id])).rows[0];

  await t.test('offline provider commits patch first, clears all vector identity and returns retry state', async () => {
    const id = await create('old astronomy'); let calls = 0;
    process.env.MEMORY_STORE_INLINE_EMBED_MS = '1000';
    globalThis.fetch = async () => { calls++; assert.equal((await row(id)).content, 'quasar revised'); throw new Error('offline'); };
    try {
      const result = await memoryUpdate({ id, content: 'quasar revised', tags: ['new'], metadata: { fixed: true } }, auth);
      assert.equal(result.content, 'quasar revised'); assert.deepEqual(result.tags, ['new']); assert.deepEqual(result.metadata, { fixed: true });
      assert.equal(result.ingestion?.state, 'queued'); assert.equal(calls, 1); assert.equal((await job(id)).status, 'retry_wait');
      const memory = await row(id);
      for (const field of ['embedding', 'embedding_provider', 'embedding_model', 'embedding_dimensions']) assert.equal(memory[field], null);
      assert.equal((await job(id)).kind, 'update'); assert.equal((await job(id)).dedupe, false); assert.equal((await job(id)).contradiction_eligible, false);
      const search = (query: string) => rankMemories({ query, limit: 100, threshold: 0.3 }, auth.namespaces, dbScopeFromAuth(auth), auth.maxAccessLevel, { queryVectors: [{ profile: ACTIVE_EMBEDDING_PROFILE, vector }] });
      const hits = await search('quasar');
      assert.ok(hits.some(hit => hit.id === id && hit.vec_score === null));
      assert.ok(!(await search('unmatchedterm')).some(hit => hit.id === id));
      await owner!.query('UPDATE memory_ingestion_jobs SET next_attempt_at=now() WHERE memory_id=$1', [id]);
      await finalizeIngestionJob(await claim(id), embedding);
      assert.ok((await search('unmatchedterm')).some(hit => hit.id === id && Number(hit.vec_score) > 0.9));
    } finally { process.env.MEMORY_STORE_INLINE_EMBED_MS = '0'; globalThis.fetch = originalFetch; }
  });
  await t.test('healthy inline finalize preserves updated_at and public revision', async () => {
    const id = await create('inline old'); let committed: any;
    process.env.MEMORY_STORE_INLINE_EMBED_MS = '1000';
    globalThis.fetch = async () => { committed = await row(id); return new Response(JSON.stringify({ embedding: { values: vector } }), { status: 200 }); };
    try {
      const result = await memoryUpdate({ id, content: 'inline new' }, auth);
      assert.equal(result.ingestion?.state, 'ready'); assert.equal((await row(id)).revision, committed.revision);
      assert.equal(new Date(result.updated_at).getTime(), committed.updated_at.getTime());
      assert.equal((await row(id)).updated_at.getTime(), committed.updated_at.getTime());
    } finally { process.env.MEMORY_STORE_INLINE_EMBED_MS = '0'; globalThis.fetch = originalFetch; }
  });
  await t.test('tags and metadata leave queued generation untouched and do not cancel indexing', async () => {
    const id = await create('metadata old'); await memoryUpdate({ id, content: 'metadata new' }, auth);
    const leased = await claim(id); const before = await job(id); const revision = (await row(id)).revision;
    globalThis.fetch = async () => { throw new Error('unexpected provider call'); };
    try { await memoryUpdate({ id, tags: ['tag'], metadata: { a: 1 } }, auth); }
    finally { globalThis.fetch = originalFetch; }
    assert.deepEqual(await job(id), before); assert.equal((await row(id)).revision, revision + 1);
    assert.equal((await finalizeIngestionJob(leased, embedding))?.state, 'ready');
    const plain = (await owner!.query(`INSERT INTO memories(content,source,namespace,client_id,tags,metadata) VALUES ('plain','test','shared',$1,'{}','{}') RETURNING id`, [ownerId])).rows[0].id;
    await memoryUpdate({ id: plain, tags: ['only'] }, auth); assert.equal(await job(plain), undefined);
  });
  await t.test('successive content changes including ABA fence old results and failures', async () => {
    const id = await create('start'); await memoryUpdate({ id, content: 'A' }, auth); const a = await claim(id);
    await memoryUpdate({ id, content: 'B' }, auth); const b = await claim(id);
    await memoryUpdate({ id, content: 'A' }, auth); const current = await claim(id);
    assert.notEqual(a.lease_token, current.lease_token);
    assert.equal(await finalizeIngestionJob(a, embedding), null); assert.equal(await finalizeIngestionJob(b, embedding), null);
    await failIngestionJob(a, new Error('stale')); assert.equal((await job(id)).status, 'processing');
    assert.equal((await row(id)).embedding, null); assert.equal((await finalizeIngestionJob(current, embedding))?.state, 'ready');
    assert.equal((await row(id)).content, 'A');
  });
  await t.test('pending store becomes update without creating subscription events', async () => {
    const subscription = (await owner!.query(`INSERT INTO memory_subscriptions
      (api_key_id,query_text,query_embedding,embedding_provider,embedding_model,embedding_dimensions,threshold,exclude_self,
       webhook_url_ciphertext,webhook_url_iv,webhook_url_tag,signing_secret_ciphertext,signing_secret_iv,signing_secret_tag,
       encryption_key_id,idempotency_key,request_hash)
      VALUES ($1,'fixture',$2::vector,$3,$4,768,0.5,false,'x',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),
        'x',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'test','update',repeat('a',64)) RETURNING id`, [otherId, JSON.stringify(vector), embedding.provider, embedding.model])).rows[0].id;
    await owner!.query('INSERT INTO subscription_namespaces(subscription_id,api_key_id,namespace) VALUES ($1,$2,$3)', [subscription, otherId, 'shared']);
    await owner!.query('ALTER TABLE memories ENABLE TRIGGER memories_subscription_enqueue; ALTER TABLE memories ENABLE TRIGGER memories_subscription_ready_enqueue');
    const id = await create('pending store', false); const old = await claim(id);
    await memoryUpdate({ id, content: 'updated before readiness' }, auth);
    assert.equal(await finalizeIngestionJob(old, embedding), null); await finalizeIngestionJob(await claim(id), embedding);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE memory_id=$1', [id])).rows[0].n, 0);
    const ready = await create('new stored event'); assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE memory_id=$1', [ready])).rows[0].n, 1);
    await memoryUpdate({ id: ready, content: 'ready edited' }, auth); await finalizeIngestionJob(await claim(ready), embedding);
    assert.equal((await owner!.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE memory_id=$1', [ready])).rows[0].n, 1);
  });
  await t.test('supersession with provider down commits and later historical embedding preserves links', async () => {
    const predecessor = await create('history before'); const successor = await create('history after');
    await memoryUpdate({ id: predecessor, content: 'history updated' }, auth); const pending = await claim(predecessor);
    await memoryUpdate({ id: successor, content: 'successor revised', supersedes: predecessor }, auth);
    assert.equal((await row(successor)).supersedes_id, predecessor); assert.ok((await row(predecessor)).superseded_at);
    assert.equal((await finalizeIngestionJob(pending, embedding))?.state, 'ready'); assert.ok((await row(predecessor)).superseded_at);
    await finalizeIngestionJob(await claim(successor), embedding); assert.equal((await row(successor)).supersedes_id, predecessor);
  });
  await t.test('consolidation keeps pending historical indexing without reopening visibility', async () => {
    const id = await create('member'); const summary = await create('summary');
    await memoryUpdate({ id, content: 'member updated' }, auth); const pending = await claim(id);
    // Real consolidation requires a vector and active membership. An external
    // synchronous completion can land after claim, then consolidate before ours.
    await owner!.query('BEGIN');
    try {
      await owner!.query("UPDATE memories SET memory_kind='consolidation',source='memory-consolidation' WHERE id=$1", [summary]);
      await owner!.query(`UPDATE memories SET embedding=$2::vector,embedding_provider=$3,embedding_model=$4,embedding_dimensions=768 WHERE id=$1`, [id, JSON.stringify(vector), embedding.provider, embedding.model]);
      await owner!.query(`INSERT INTO memory_consolidation_memberships(owner_key_id,namespace,canonical_id,member_id,member_revision,member_fingerprint,embedding_provider,embedding_model,embedding_dimensions,policy_hash,consolidated_at)
        SELECT $1,'shared',$2,id,revision,repeat('a',64),embedding_provider,embedding_model,768,repeat('b',64),now() FROM memories WHERE id=$3`, [ownerId, summary, id]);
      await owner!.query('UPDATE memories SET consolidated_into_id=$2, consolidated_at=now() WHERE id=$1', [id, summary]);
      await owner!.query('COMMIT');
    } catch (error) { await owner!.query('ROLLBACK'); throw error; }
    assert.equal((await finalizeIngestionJob(pending, embedding))?.state, 'ready'); assert.equal((await row(id)).consolidated_into_id, summary);
  });
  await t.test('forget, purge and expiry cannot resurrect a queued row', async () => {
    for (const action of ['forget', 'purge', 'expire']) {
      const id = await create(action); await memoryUpdate({ id, content: `${action} revised` }, auth); const pending = await claim(id);
      if (action === 'forget') await memoryForget({ ids: [id] }, auth);
      if (action === 'purge') await owner!.query('DELETE FROM memories WHERE id=$1', [id]);
      if (action === 'expire') await owner!.query("UPDATE memories SET expires_at=now()-interval '1 second' WHERE id=$1", [id]);
      assert.equal(await finalizeIngestionJob(pending, embedding), null);
      if (action === 'purge') assert.equal(await job(id), undefined); else assert.equal((await row(id)).embedding, null);
    }
  });
  await t.test('ACL and private job ownership permit another authorized namespace writer', async () => {
    const id = await create('shared old'); await memoryUpdate({ id, content: 'shared new' }, other);
    assert.equal((await job(id)).client_id, ownerId); assert.equal(await claimIngestionJob(dbScopeFromAuth(other), { memoryId: id, inline: true }), null);
    assert.equal((await finalizeIngestionJob(await claim(id), embedding))?.state, 'ready');
    assert.equal((await withScopedClient(dbScopeFromAuth(other), c => c.query('SELECT * FROM memory_ingestion_jobs WHERE memory_id=$1', [id]))).rows.length, 0);
    for (const actor of [{ ...auth, namespaces: ['private'] }, { ...auth, permissions: ['read'] }]) await assert.rejects(memoryUpdate({ id, content: 'denied' }, actor));
    await owner!.query("UPDATE memories SET access_level='secret' WHERE id=$1", [id]);
    await assert.rejects(memoryUpdate({ id, content: 'denied' }, { ...auth, maxAccessLevel: 'normal' }));
    assert.equal((await row(id)).content, 'shared new');
  });
  await t.test('REST If-Match changes at patch commit and remains valid across indexing', async () => {
    const { createApp } = await import('../src/server.js'); const app = createApp(); const id = await create('REST old');
    const before = (await row(id)).updated_at.toISOString();
    const patched = await request(app).patch(`/api/memories/${id}`).set('Authorization', `Bearer tr_${auth.name}`).set('If-Match', `"${before}"`).send({ content: 'REST new' });
    assert.equal(patched.status, 200); assert.equal(patched.body.memory.ingestion.state, 'queued');
    await finalizeIngestionJob(await claim(id), embedding);
    assert.equal((await request(app).patch(`/api/memories/${id}`).set('Authorization', `Bearer tr_${auth.name}`).set('If-Match', `"${before}"`).send({ tags: ['stale'] })).status, 409);
    assert.equal((await request(app).patch(`/api/memories/${id}`).set('Authorization', `Bearer tr_${auth.name}`).set('If-Match', `"${patched.body.memory.updated_at}"`).send({ tags: ['fresh'] })).status, 200);
  });
  await t.test('sub-gate off preserves synchronous failure and leaves job unchanged', async () => {
    const id = await create('gate old'); const before = await job(id);
    process.env.MEMORY_INGESTION_UPDATE_ENABLED = 'false'; globalThis.fetch = async () => { throw new Error('offline'); };
    try { await assert.rejects(memoryUpdate({ id, content: 'not committed' }, auth)); }
    finally { process.env.MEMORY_INGESTION_UPDATE_ENABLED = 'true'; globalThis.fetch = originalFetch; }
    assert.equal((await row(id)).content, 'gate old'); assert.deepEqual(await job(id), before);
  });
  await t.test('a paused in-flight provider cannot overwrite a newer committed generation', async () => {
    const id = await create('race old'); let reached!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    process.env.MEMORY_STORE_INLINE_EMBED_MS = '1000';
    globalThis.fetch = async () => { reached(); await resume; return new Response(JSON.stringify({ embedding: { values: vector } }), { status: 200 }); };
    const first = memoryUpdate({ id, content: 'race first' }, auth);
    try {
      await entered; process.env.MEMORY_STORE_INLINE_EMBED_MS = '0';
      await memoryUpdate({ id, tags: ['during-provider'] }, auth);
      await memoryUpdate({ id, content: 'race second' }, auth);
    } finally { release(); await first; globalThis.fetch = originalFetch; process.env.MEMORY_STORE_INLINE_EMBED_MS = '0'; }
    assert.equal((await row(id)).content, 'race second'); assert.equal((await row(id)).embedding, null);
    assert.equal((await finalizeIngestionJob(await claim(id), embedding))?.state, 'ready');
  });
  await t.test('worker retry and expired-lease recovery use the shared queue after restart', async () => {
    // Finish earlier due jobs so this once-worker canary targets only this row.
    await owner!.query("UPDATE memory_ingestion_jobs SET next_attempt_at=now()+interval '1 day' WHERE status IN ('pending','retry_wait')");
    const id = await create('worker old'); await memoryUpdate({ id, content: 'worker new' }, auth);
    const stale = await claim(id);
    await owner!.query("UPDATE memory_ingestion_jobs SET lease_expires_at=now()-interval '1 second' WHERE memory_id=$1", [id]);
    process.env.INGESTION_WORKER_API_KEY = `tr_${admin.name}`;
    globalThis.fetch = async () => { throw new Error('offline worker'); };
    try {
      assert.equal((await runIngestionWorker({ once: true, concurrency: 1, maxJobs: 1, pollMs: 100 }, new AbortController().signal)).processed, 1);
      assert.equal((await job(id)).status, 'retry_wait'); assert.equal((await job(id)).attempts, 1);
      await owner!.query('UPDATE memory_ingestion_jobs SET next_attempt_at=now() WHERE memory_id=$1', [id]);
      globalThis.fetch = async () => new Response(JSON.stringify({ embedding: { values: vector } }), { status: 200 });
      assert.equal((await runIngestionWorker({ once: true, concurrency: 1, maxJobs: 1, pollMs: 100 }, new AbortController().signal)).processed, 1);
      assert.equal((await job(id)).status, 'ready'); assert.equal((await job(id)).attempts, 2);
      assert.equal(await finalizeIngestionJob(stale, embedding), null); assert.equal((await row(id)).content, 'worker new');
    } finally { globalThis.fetch = originalFetch; }
  });
  await t.test('job persistence failure rolls back content/vector/audit atomically', async () => {
    const id = await create('rollback old'); const before = await row(id);
    const audits = (await owner!.query("SELECT count(*)::int AS n FROM audit_log WHERE memory_id=$1 AND action='memory.update'", [id])).rows[0].n;
    await owner!.query(`CREATE FUNCTION reject_update_job_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected job failure'; END $$;
      CREATE TRIGGER reject_update_job_test BEFORE UPDATE ON memory_ingestion_jobs FOR EACH ROW WHEN (NEW.memory_id='${id}') EXECUTE FUNCTION reject_update_job_test()`);
    try { await assert.rejects(memoryUpdate({ id, content: 'rollback new' }, auth), /injected job failure/); }
    finally { await owner!.query('DROP TRIGGER reject_update_job_test ON memory_ingestion_jobs; DROP FUNCTION reject_update_job_test()'); }
    assert.deepEqual(await row(id), before);
    assert.equal((await owner!.query("SELECT count(*)::int AS n FROM audit_log WHERE memory_id=$1 AND action='memory.update'", [id])).rows[0].n, audits);
  });
  await t.test('a cross-key edit preserves the creator keyed-store retry and job-before-memory order', async () => {
    const store = (content: string) => acceptMemory({ content, namespace: 'shared', access_level: 'normal', tags: [], metadata: {}, dedupe: false, idempotency_key: 'cross-key-retry' }, auth, agent);
    const accepted = await store('key original'); await finalizeIngestionJob(await claim(accepted.id), embedding);
    await memoryUpdate({ id: accepted.id, content: 'key edited by other' }, other);
    const retry = await store('key original'); assert.equal(retry.id, accepted.id); assert.equal(retry.state, 'queued');
    await memoryUpdate({ id: accepted.id, content: 'other again' }, other);
    let reached!: () => void; let release!: () => void;
    const locked = new Promise<void>(resolve => { reached = resolve; }); const resume = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    setPoolForTesting({ connect: async () => {
      const client = await pool!.connect(); return { release: (error?: Error) => client.release(error), query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        if (!held && sql.includes('WHERE j.client_id = $1 AND j.source_key = $2 FOR UPDATE')) { held = true; reached(); await resume; }
        return result;
      } };
    } } as unknown as pg.Pool);
    const storing = store('key concurrent'); let editing: Promise<unknown> | undefined;
    try {
      await locked; editing = memoryUpdate({ id: accepted.id, content: 'other concurrent' }, other);
      await new Promise(resolve => setTimeout(resolve, 100)); release();
      await Promise.all([storing, editing]);
    } finally { release(); await Promise.allSettled([storing, ...(editing ? [editing] : [])]); setPoolForTesting(pool!); }
    assert.equal((await row(accepted.id)).content, 'other concurrent');
    assert.equal((await job(accepted.id)).client_id, ownerId);
    await finalizeIngestionJob(await claim(accepted.id), embedding);
  });
  await t.test('a keyed synchronous memory with no original job remains retryable after a cross-key edit', async () => {
    const id = await create('legacy keyed');
    const sourceKey = `discord-safe:v1:${(await import('node:crypto')).createHash('sha256').update(ownerId).update('\0').update('legacy-keyed').digest('hex')}`;
    await owner!.query('UPDATE memories SET source_key=$2 WHERE id=$1; ', [id, sourceKey]);
    // Owner setup represents a pre-queue synchronous store, with no queue row.
    await owner!.query('DELETE FROM memory_ingestion_jobs WHERE memory_id=$1', [id]);
    await memoryUpdate({ id, content: 'legacy keyed edited' }, other);
    const retry = await acceptMemory({ content: 'legacy keyed retry', namespace: 'shared', access_level: 'normal', tags: [], metadata: {}, idempotency_key: 'legacy-keyed' }, auth, agent);
    assert.equal(retry.id, id); assert.equal((await job(id)).client_id, ownerId);
  });
  await t.test('nullable legacy access is normal for acceptance and embedding completion', async () => {
    const id = await create('nullable access'); await owner!.query('UPDATE memories SET access_level=NULL WHERE id=$1', [id]);
    const result = await memoryUpdate({ id, content: 'nullable revised' }, { ...auth, maxAccessLevel: 'normal' });
    assert.equal(result.ingestion?.state, 'queued'); assert.equal((await job(id)).access_level, 'normal');
    assert.equal((await finalizeIngestionJob(await claim(id), embedding))?.state, 'ready');
    assert.equal((await row(id)).access_level, null);
  });
});
