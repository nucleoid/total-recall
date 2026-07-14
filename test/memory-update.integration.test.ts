import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { finalizeMemorySupersession } from '../scripts/memory-supersession-finalizer.js';
import { setPoolForTesting } from '../src/db.js';
import { memoryList } from '../src/tools/list.js';
import { memoryRecall } from '../src/tools/recall.js';
import { memoryUpdate } from '../src/tools/update.js';
import type { AuthContext } from '../src/types.js';

const KEY = '22222222-2222-4222-8222-222222222222';
const OLD = '11111111-1111-4111-8111-111111111111';
const CURRENT = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const vector = (x = 1, y = 0): number[] => [x, y, ...Array(766).fill(0)];
const vectorText = (values: number[]): string => `[${values.join(',')}]`;

const auth: AuthContext = {
  keyId: KEY,
  name: 'update-integration',
  namespaces: ['shared'],
  permissions: ['read', 'write'],
  maxAccessLevel: 'secret',
};
const normalAuth: AuthContext = { ...auth, name: 'normal-reader', maxAccessLevel: 'normal' };

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function embeddingResponse(values = vector()): Response {
  return new Response(JSON.stringify({ embedding: { values } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function isCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error &&
    (error as Error & { code?: string }).code === code;
}

test('memory update enforces online-finalized, private, atomic, revisioned supersession history', { timeout: 120_000 }, async t => {
  if (!dockerAvailable()) { t.skip('Docker is unavailable'); return; }
  const originalDemotionGate = process.env.SUPERSEDED_SEARCH_DEMOTION_ENABLED;
  process.env.SUPERSEDED_SEARCH_DEMOTION_ENABLED = 'true';
  const { hybridSearch } = await import('../src/search.js');
  const originalFetch = globalThis.fetch;
  const container = execFileSync('docker', [
    'run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=postgres', '-p', '127.0.0.1::5432',
    process.env.MEMORY_UPDATE_TEST_IMAGE || 'pgvector/pgvector:pg16',
  ], { encoding: 'utf8' }).trim();
  t.after(() => { try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch {} });

  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)!;
  const ownerUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const appUrl = `postgresql://total_recall_app:app-password@127.0.0.1:${port}/postgres`;
  const deadline = Date.now() + 30_000;
  let owner: pg.Client | undefined;
  while (Date.now() < deadline) {
    owner = new pg.Client({ connectionString: ownerUrl });
    try { await owner.connect(); break; }
    catch { await owner.end().catch(() => undefined); owner = undefined; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.ok(owner, 'PostgreSQL did not become ready');

  let appPool: pg.Pool | undefined;
  try {
    await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
    await owner.query("CREATE ROLE total_recall_app LOGIN PASSWORD 'app-password'");
    for (const file of readdirSync(join(process.cwd(), 'migrations')).filter(file => /^\d+_.*\.sql$/.test(file)).sort()) {
      await owner.query(readFileSync(join(process.cwd(), 'migrations', file), 'utf8'));
    }
    const finalization = await finalizeMemorySupersession({ connectionString: ownerUrl });
    assert.equal(finalization.constraints.every(row => row.constraintValid), true);
    assert.equal(finalization.indexes.every(row => row.indexValid), true);

    await owner.query(
      `INSERT INTO api_keys (id, key_hash, name, namespaces, permissions, max_access_level)
       VALUES ($1, 'update-hash', 'update-integration', ARRAY['shared','private'], ARRAY['read','write'], 'secret')`,
      [KEY],
    );
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, tags, metadata, access_level, client_id)
       VALUES ($1, 'User lived in Denver', 'test', 'shared', ARRAY['profile'], '{}', 'normal', $4),
              ($2, 'User lives in Austin', 'test', 'shared', ARRAY['profile'], '{}', 'normal', $4),
              ($3, 'Other current fact', 'test', 'shared', ARRAY[]::text[], '{}', 'normal', $4)`,
      [OLD, CURRENT, OTHER, KEY],
    );

    appPool = new pg.Pool({ connectionString: appUrl });
    setPoolForTesting(appPool);

    const updated = await memoryUpdate({ id: CURRENT, tags: ['profile', 'location'], supersedes: OLD }, auth);
    assert.equal(updated.supersedes_id, OLD);
    assert.equal(updated.revision, 1);

    const state = await owner.query(
      `SELECT id::text, supersedes_id::text, superseded_at IS NOT NULL AS superseded, revision
       FROM memories WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[OLD, CURRENT]],
    );
    assert.deepEqual(state.rows, [
      { id: OLD, supersedes_id: null, superseded: true, revision: 1 },
      { id: CURRENT, supersedes_id: OLD, superseded: false, revision: 1 },
    ]);

    const historical = await memoryRecall({ id: OLD }, auth);
    assert.equal(historical.is_superseded, true);
    assert.equal(historical.superseded_by_id, CURRENT);
    await assert.rejects(memoryUpdate({ id: OLD, tags: [] }, auth), isCode('memory_not_found'));
    await assert.rejects(memoryUpdate({ id: OTHER, supersedes: OLD }, auth), /not found|already has a successor/i);

    let providerCalls = 0;
    globalThis.fetch = async () => { providerCalls++; return embeddingResponse(); };
    const contentUpdate = await memoryUpdate({ id: OTHER, content: 'Other fact changed' }, auth);
    assert.equal(contentUpdate.content, 'Other fact changed');
    assert.equal(contentUpdate.revision, 1);
    assert.equal(providerCalls, 1, 'changed content embeds exactly once');

    providerCalls = 0;
    globalThis.fetch = async () => { providerCalls++; throw new Error('provider must not be called'); };
    const unchanged = await memoryUpdate({ id: OTHER, content: 'Other fact changed' }, auth);
    assert.equal(unchanged.revision, 1);
    assert.equal(providerCalls, 0, 'unchanged content does not embed or rewrite');

    const staleId = '50000000-0000-4000-8000-000000000001';
    const failedId = '50000000-0000-4000-8000-000000000002';
    const concurrentId = '50000000-0000-4000-8000-000000000003';
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, client_id)
       VALUES ($1, 'stale original', 'test', 'shared', $4),
              ($2, 'provider original', 'test', 'shared', $4),
              ($3, 'parallel patch', 'test', 'shared', $4)`,
      [staleId, failedId, concurrentId, KEY],
    );

    let releaseEmbedding!: () => void;
    let embeddingStarted!: () => void;
    const started = new Promise<void>(resolve => { embeddingStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseEmbedding = resolve; });
    globalThis.fetch = async () => {
      embeddingStarted();
      await release;
      return embeddingResponse(vector(0.8, 0.6));
    };
    const staleUpdate = memoryUpdate({ id: staleId, content: 'stale replacement' }, auth);
    await started;
    await owner.query(`UPDATE memories SET metadata = '{"concurrent":true}'::jsonb WHERE id = $1`, [staleId]);
    releaseEmbedding();
    await assert.rejects(staleUpdate, isCode('memory_conflict'));
    const staleState = await owner.query(
      'SELECT content, metadata, embedding IS NULL AS embedding_null, revision FROM memories WHERE id = $1',
      [staleId],
    );
    assert.deepEqual(staleState.rows[0], {
      content: 'stale original',
      metadata: { concurrent: true },
      embedding_null: true,
      revision: 1,
    });
    assert.equal((await auditCount(owner, staleId)), 0);

    globalThis.fetch = async () => new Response('unavailable', { status: 503 });
    await assert.rejects(memoryUpdate({ id: failedId, content: 'must not commit' }, auth), /Gemini embedContent failed/);
    assert.deepEqual((await owner.query(
      'SELECT content, embedding IS NULL AS embedding_null, revision FROM memories WHERE id = $1',
      [failedId],
    )).rows[0], { content: 'provider original', embedding_null: true, revision: 0 });
    assert.equal((await auditCount(owner, failedId)), 0);

    await Promise.all([
      memoryUpdate({ id: concurrentId, tags: ['parallel'] }, auth),
      memoryUpdate({ id: concurrentId, metadata: { writer: 2 } }, auth),
    ]);
    assert.deepEqual((await owner.query(
      'SELECT tags, metadata, revision FROM memories WHERE id = $1',
      [concurrentId],
    )).rows[0], { tags: ['parallel'], metadata: { writer: 2 }, revision: 2 });

    // The second audit failure rolls back both graph writes, both revisions,
    // and the first audit insert.
    const rollbackOld = '60000000-0000-4000-8000-000000000001';
    const rollbackNew = '60000000-0000-4000-8000-000000000002';
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, client_id)
       VALUES ($1, 'rollback old', 'test', 'shared', $3), ($2, 'rollback new', 'test', 'shared', $3)`,
      [rollbackOld, rollbackNew, KEY],
    );
    await owner.query(`
      CREATE FUNCTION public.fail_supersession_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'belief.supersede' AND NEW.memory_id = '${rollbackOld}'::uuid THEN
          RAISE EXCEPTION 'forced supersession audit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_supersession_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION public.fail_supersession_audit();
    `);
    await assert.rejects(
      memoryUpdate({ id: rollbackNew, tags: ['must-rollback'], supersedes: rollbackOld }, auth),
      /forced supersession audit failure/,
    );
    await owner.query('DROP TRIGGER fail_supersession_audit ON audit_log');
    await owner.query('DROP FUNCTION public.fail_supersession_audit()');
    assert.deepEqual((await owner.query(
      `SELECT id::text, tags, supersedes_id, superseded_at, revision
       FROM memories WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[rollbackOld, rollbackNew]],
    )).rows, [
      { id: rollbackOld, tags: [], supersedes_id: null, superseded_at: null, revision: 0 },
      { id: rollbackNew, tags: [], supersedes_id: null, superseded_at: null, revision: 0 },
    ]);
    assert.equal((await auditCount(owner, rollbackOld)) + (await auditCount(owner, rollbackNew)), 0);

    // Mixed access-level links are visible only when the linked row is visible.
    const secretOld = '70000000-0000-4000-8000-000000000001';
    const normalSuccessor = '70000000-0000-4000-8000-000000000002';
    const normalOld = '70000000-0000-4000-8000-000000000003';
    const secretSuccessor = '70000000-0000-4000-8000-000000000004';
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, access_level, client_id)
       VALUES ($1, 'classified predecessor marker', 'visibility', 'shared', 'secret', $5),
              ($2, 'visible successor marker', 'visibility', 'shared', 'normal', $5),
              ($3, 'visible predecessor marker', 'visibility', 'shared', 'normal', $5),
              ($4, 'classified successor marker', 'visibility', 'shared', 'secret', $5)`,
      [secretOld, normalSuccessor, normalOld, secretSuccessor, KEY],
    );
    await memoryUpdate({ id: normalSuccessor, supersedes: secretOld }, auth);
    await memoryUpdate({ id: secretSuccessor, supersedes: normalOld }, auth);

    assert.equal((await memoryRecall({ id: normalSuccessor }, normalAuth)).supersedes_id, null);
    assert.equal((await memoryRecall({ id: normalOld }, normalAuth)).superseded_by_id, null);
    assert.equal((await memoryRecall({ id: normalSuccessor }, auth)).supersedes_id, secretOld);
    assert.equal((await memoryRecall({ id: normalOld }, auth)).superseded_by_id, secretSuccessor);

    const visibleList = await memoryList({ source: 'visibility', limit: 20, offset: 0 }, normalAuth);
    const listedSuccessor = visibleList.memories.find((row: any) => row.id === normalSuccessor);
    const listedPredecessor = visibleList.memories.find((row: any) => row.id === normalOld);
    assert.equal(listedSuccessor.supersedes_id, null);
    assert.equal(listedPredecessor.superseded_by_id, null);

    globalThis.fetch = async () => embeddingResponse();
    const visibleSearch = await hybridSearch(
      { query: 'marker', source: 'visibility', threshold: 0, limit: 10 },
      ['shared'],
      { namespaces: ['shared'], keyId: KEY },
      'normal',
    );
    assert.equal(visibleSearch.find(row => row.id === normalSuccessor)?.supersedes_id, null);
    assert.equal(visibleSearch.find(row => row.id === normalOld)?.superseded_by_id, null);
    const lowUpdate = await memoryUpdate({ id: normalSuccessor, tags: ['still-visible'] }, normalAuth);
    assert.equal(lowUpdate.supersedes_id, null);

    // Even a malformed owner-created cross-namespace link cannot disclose the
    // other namespace through an otherwise visible row.
    const crossOld = '71000000-0000-4000-8000-000000000001';
    const crossNew = '71000000-0000-4000-8000-000000000002';
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, access_level, client_id)
       VALUES ($1, 'private malformed predecessor', 'cross', 'private', 'normal', $3),
              ($2, 'shared malformed successor', 'cross', 'shared', 'normal', $3)`,
      [crossOld, crossNew, KEY],
    );
    await owner.query('UPDATE memories SET superseded_at = NOW() WHERE id = $1', [crossOld]);
    await owner.query('UPDATE memories SET supersedes_id = $1 WHERE id = $2', [crossOld, crossNew]);
    assert.equal((await memoryRecall({ id: crossNew }, normalAuth)).supersedes_id, null);
    assert.equal((await memoryList({ source: 'cross', limit: 10, offset: 0 }, normalAuth)).memories[0].supersedes_id, null);

    const bothNamespaces = { ...auth, namespaces: ['shared', 'private'] };
    const crossTarget = '71000000-0000-4000-8000-000000000003';
    const crossPred = '71000000-0000-4000-8000-000000000004';
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, client_id)
       VALUES ($1, 'cross target', 'cross', 'shared', $3), ($2, 'cross predecessor', 'cross', 'private', $3)`,
      [crossTarget, crossPred, KEY],
    );
    await assert.rejects(memoryUpdate({ id: crossTarget, supersedes: crossPred }, bothNamespaces), isCode('memory_conflict'));

    const deletedTarget = '72000000-0000-4000-8000-000000000001';
    const secretTarget = '72000000-0000-4000-8000-000000000002';
    const privateTarget = '72000000-0000-4000-8000-000000000003';
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, access_level, client_id, deleted_at)
       VALUES ($1, 'deleted target', 'disclosure', 'shared', 'normal', $4, NOW()),
              ($2, 'secret target', 'disclosure', 'shared', 'secret', $4, NULL),
              ($3, 'private target', 'disclosure', 'private', 'normal', $4, NULL)`,
      [deletedTarget, secretTarget, privateTarget, KEY],
    );
    for (const id of ['73000000-0000-4000-8000-000000000001', deletedTarget, secretTarget, privateTarget, OLD]) {
      await assert.rejects(memoryUpdate({ id, tags: ['denied'] }, normalAuth), isCode('memory_not_found'));
    }
    await assert.rejects(memoryRecall({ id: CURRENT }, { ...normalAuth, namespaces: ['private'] }), /not found or access denied/i);
    assert.equal((await memoryRecall({ id: CURRENT }, normalAuth)).id, CURRENT, 'pooled RLS scope does not bleed');

    // Two concurrent successors produce one durable branch and one coherent
    // audit pair; the unique index remains the database backstop.
    const raceOld = '80000000-0000-4000-8000-000000000001';
    const raceA = '80000000-0000-4000-8000-000000000002';
    const raceB = '80000000-0000-4000-8000-000000000003';
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, client_id)
       VALUES ($1, 'race old', 'race', 'shared', $4), ($2, 'race a', 'race', 'shared', $4),
              ($3, 'race b', 'race', 'shared', $4)`,
      [raceOld, raceA, raceB, KEY],
    );
    const race = await Promise.allSettled([
      memoryUpdate({ id: raceA, supersedes: raceOld }, auth),
      memoryUpdate({ id: raceB, supersedes: raceOld }, auth),
    ]);
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(race.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await owner.query('SELECT COUNT(*)::int AS count FROM memories WHERE supersedes_id = $1', [raceOld])).rows[0].count, 1);
    assert.equal((await owner.query(
      `SELECT COUNT(*)::int AS count FROM audit_log
       WHERE (action = 'belief.supersede' AND memory_id = $1)
          OR (action = 'memory.update' AND memory_id = ANY($2::uuid[]))`,
      [raceOld, [raceA, raceB]],
    )).rows[0].count, 2);

    await assert.rejects(owner.query('UPDATE memories SET supersedes_id = id WHERE id = $1', [OTHER]), /memories_supersedes_not_self/);
    await assert.rejects(owner.query('UPDATE memories SET supersedes_id = $1 WHERE id = $2', [OTHER, CURRENT]), /immutable/);
    const beforeForgedRevision = (await owner.query('SELECT revision FROM memories WHERE id = $1', [OTHER])).rows[0].revision;
    await owner.query('UPDATE memories SET revision = 999, access_count = access_count + 1 WHERE id = $1', [OTHER]);
    assert.equal((await owner.query('SELECT revision FROM memories WHERE id = $1', [OTHER])).rows[0].revision, beforeForgedRevision);
    await assert.rejects(owner.query('DELETE FROM memories WHERE id = $1', [OLD]), /foreign key/i);

    // Candidate classes are bounded independently, thresholding precedes
    // demotion, and final limit applies only after demotion.
    const currentVectorId = '90000000-0000-4000-8000-000000000001';
    const rankRows: unknown[] = [];
    for (let index = 0; index < 55; index++) {
      rankRows.push(`90000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`);
    }
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, client_id, embedding, embedding_provider, embedding_model, embedding_dimensions, superseded_at)
       SELECT value::uuid, 'historical vector candidate', 'rank-vector', 'shared', $1,
              $2::vector, 'gemini', 'gemini-embedding-2-preview', 768, NOW()
       FROM unnest($3::text[]) value`,
      [KEY, vectorText(vector()), rankRows],
    );
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, client_id, embedding, embedding_provider, embedding_model, embedding_dimensions)
       VALUES ($1, 'current vector candidate', 'rank-vector', 'shared', $2, $3::vector, 'gemini', 'gemini-embedding-2-preview', 768)`,
      [currentVectorId, KEY, vectorText(vector(0.8, 0.6))],
    );
    globalThis.fetch = async () => embeddingResponse(vector());
    const vectorRanking = await hybridSearch(
      { query: 'unmatched-vector-query', source: 'rank-vector', threshold: 0.7, limit: 1 },
      ['shared'], { namespaces: ['shared'], keyId: KEY }, 'normal',
    );
    assert.equal(vectorRanking[0]?.id, currentVectorId, '55 historical vector candidates cannot crowd out current fact and demotion precedes limit');

    const currentTextId = '91000000-0000-4000-8000-000000000001';
    const textRows = Array.from({ length: 25 }, (_, index) =>
      `91000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
    );
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, client_id, superseded_at)
       SELECT value::uuid, 'crowdingkeyword historical text', 'rank-text', 'shared', $1, NOW()
       FROM unnest($2::text[]) value`,
      [KEY, textRows],
    );
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, client_id)
       VALUES ($1, 'crowdingkeyword current text', 'rank-text', 'shared', $2)`,
      [currentTextId, KEY],
    );
    const textRanking = await hybridSearch(
      { query: 'crowdingkeyword', source: 'rank-text', threshold: 1, limit: 1 },
      ['shared'], { namespaces: ['shared'], keyId: KEY }, 'normal',
    );
    assert.equal(textRanking[0]?.id, currentTextId, '25 historical text candidates cannot crowd out current fact');

    const exactId = '92000000-0000-4000-8000-000000000001';
    const diagonalId = '92000000-0000-4000-8000-000000000002';
    const orthogonalId = '92000000-0000-4000-8000-000000000003';
    await owner.query(
      `INSERT INTO memories (id, content, source, namespace, client_id, embedding, embedding_provider, embedding_model, embedding_dimensions)
       VALUES ($1, 'exact candidate', 'rank-threshold', 'shared', $4, $5::vector, 'gemini', 'gemini-embedding-2-preview', 768),
              ($2, 'diagonal candidate', 'rank-threshold', 'shared', $4, $6::vector, 'gemini', 'gemini-embedding-2-preview', 768),
              ($3, 'orthogonal candidate', 'rank-threshold', 'shared', $4, $7::vector, 'gemini', 'gemini-embedding-2-preview', 768)`,
      [exactId, diagonalId, orthogonalId, KEY, vectorText(vector()), vectorText(vector(1, 1)), vectorText(vector(0, 1))],
    );
    const exactThreshold = await hybridSearch(
      { query: 'no-text-match', source: 'rank-threshold', threshold: 1, limit: 10 },
      ['shared'], { namespaces: ['shared'], keyId: KEY }, 'normal',
    );
    assert.deepEqual(exactThreshold.map(row => row.id), [exactId], 'threshold is inclusive and excludes lower vector scores');
    const lowerThreshold = await hybridSearch(
      { query: 'no-text-match', source: 'rank-threshold', threshold: 0.7, limit: 2 },
      ['shared'], { namespaces: ['shared'], keyId: KEY }, 'normal',
    );
    assert.deepEqual(new Set(lowerThreshold.map(row => row.id)), new Set([exactId, diagonalId]));

    const audits = await owner.query(
      `SELECT action, memory_id::text FROM audit_log
       WHERE memory_id = ANY($1::uuid[]) ORDER BY action, memory_id`,
      [[OLD, CURRENT, OTHER]],
    );
    assert.deepEqual(audits.rows, [
      { action: 'belief.supersede', memory_id: OLD },
      { action: 'memory.update', memory_id: CURRENT },
      { action: 'memory.update', memory_id: OTHER },
    ]);

    await owner.query('UPDATE memories SET deleted_at = NOW() WHERE id = $1', [CURRENT]);
    const afterDelete = await memoryRecall({ id: OLD }, auth);
    assert.equal(afterDelete.is_superseded, true);
    assert.equal(afterDelete.superseded_by_id, null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDemotionGate === undefined) delete process.env.SUPERSEDED_SEARCH_DEMOTION_ENABLED;
    else process.env.SUPERSEDED_SEARCH_DEMOTION_ENABLED = originalDemotionGate;
    setPoolForTesting(null);
    await appPool?.end().catch(() => undefined);
    await owner.end();
  }
});

async function auditCount(client: pg.Client, memoryId: string): Promise<number> {
  const result = await client.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM audit_log WHERE memory_id = $1',
    [memoryId],
  );
  return result.rows[0].count;
}
