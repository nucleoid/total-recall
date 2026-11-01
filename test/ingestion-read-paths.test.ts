import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type pg from 'pg';
import { setPoolForTesting } from '../src/db.js';
import { ACTIVE_EMBEDDING_PROFILE, type EmbeddingResult } from '../src/embedding.js';
import { ingestionStateSelectSql, ingestionStatusJoinSql, ingestionStatusSelectSql } from '../src/ingestion.js';
import { listMemories, getMemory } from '../src/memories.js';
import { executeHybridSearch } from '../src/search.js';
import { memoryList } from '../src/tools/list.js';
import { memoryRecall } from '../src/tools/recall.js';
import { exportMemoryPage } from '../src/transfer/export.js';
import { parseTransferMemoryRecord, transferRecordFingerprint } from '../src/transfer/format.js';
import { importMemoryBatch } from '../src/transfer/import.js';
import type { AuthContext, MemoryIngestion } from '../src/types.js';

// Read paths with the durable ingestion queue on: every memories query gains a
// content-free LEFT JOIN on memory_ingestion_jobs and an `ingestion` column.
// The fake below models the RLS policy of migration 037 (owner or admin, in a
// namespace the scope allows) and evaluates the CASE expression exactly as
// PostgreSQL would, so the owner/non-owner shapes and the null-without-job
// contract are exercised end to end rather than by SQL text alone.

const OWNER_KEY = '11111111-1111-4111-8111-111111111111';
const OTHER_KEY = '22222222-2222-4222-8222-222222222222';
const ADMIN_KEY = '99999999-9999-4999-8999-999999999999';
const PENDING_ID = '33333333-3333-4333-8333-333333333333';
const CANONICAL_ID = '44444444-4444-4444-8444-444444444444';
const DEDUPED_ID = '55555555-5555-4555-8555-555555555555';
const LEGACY_ID = '66666666-6666-4666-8666-666666666666';
const FORGOTTEN_ID = '77777777-7777-4777-8777-777777777777';
const FAILED_ID = '88888888-8888-4888-8888-888888888888';
const INSTANCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOCUMENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET = 'DO-NOT-LEAK-pending-memory-content-91c4';
const ACCEPTED_AT = '2026-11-01T10:00:00.000Z';
const READY_AT = '2026-11-01T10:00:05.000Z';
const RETRY_AT = '2026-11-01T10:05:00.000Z';
const NOW = '2026-11-01T09:00:00.000Z';

const owner: AuthContext = { keyId: OWNER_KEY, name: 'owner', namespaces: ['shared', 'private'], permissions: ['read', 'export', 'import'], maxAccessLevel: 'secret' };
const other: AuthContext = { ...owner, keyId: OTHER_KEY, name: 'other' };
const admin: AuthContext = { ...owner, keyId: ADMIN_KEY, name: 'admin', permissions: ['read', 'admin', 'export'] };

type MemoryRow = {
  id: string; namespace: string; client_id: string; content: string; embedded: boolean;
  deleted: boolean; document_id: string | null; chunk_index: number | null;
};
type JobRow = {
  memory_id: string; namespace: string; client_id: string; status: string; attempts: number;
  accepted_at: string; ready_at: string | null; next_attempt_at: string | null;
  failure_category: string | null; canonical_memory_id: string | null; similarity: number | null;
};
type Statement = { text: string; params: unknown[] };

const MEMORIES: MemoryRow[] = [
  { id: PENDING_ID, namespace: 'shared', client_id: OWNER_KEY, content: SECRET, embedded: false, deleted: false, document_id: DOCUMENT_ID, chunk_index: 0 },
  { id: CANONICAL_ID, namespace: 'shared', client_id: OWNER_KEY, content: 'canonical content', embedded: true, deleted: false, document_id: null, chunk_index: null },
  { id: DEDUPED_ID, namespace: 'shared', client_id: OWNER_KEY, content: SECRET, embedded: false, deleted: true, document_id: null, chunk_index: null },
  { id: LEGACY_ID, namespace: 'shared', client_id: OTHER_KEY, content: 'legacy content', embedded: true, deleted: false, document_id: DOCUMENT_ID, chunk_index: 1 },
  { id: FORGOTTEN_ID, namespace: 'shared', client_id: OWNER_KEY, content: 'forgotten', embedded: true, deleted: true, document_id: null, chunk_index: null },
  { id: FAILED_ID, namespace: 'private', client_id: OWNER_KEY, content: SECRET, embedded: false, deleted: false, document_id: null, chunk_index: null },
];

const JOBS: JobRow[] = [
  { memory_id: PENDING_ID, namespace: 'shared', client_id: OWNER_KEY, status: 'retry_wait', attempts: 2, accepted_at: ACCEPTED_AT, ready_at: null, next_attempt_at: RETRY_AT, failure_category: 'transient', canonical_memory_id: null, similarity: null },
  { memory_id: CANONICAL_ID, namespace: 'shared', client_id: OWNER_KEY, status: 'ready', attempts: 1, accepted_at: ACCEPTED_AT, ready_at: READY_AT, next_attempt_at: READY_AT, failure_category: null, canonical_memory_id: null, similarity: null },
  { memory_id: DEDUPED_ID, namespace: 'shared', client_id: OWNER_KEY, status: 'deduplicated', attempts: 1, accepted_at: ACCEPTED_AT, ready_at: READY_AT, next_attempt_at: READY_AT, failure_category: null, canonical_memory_id: CANONICAL_ID, similarity: 0.97 },
  { memory_id: FAILED_ID, namespace: 'private', client_id: OWNER_KEY, status: 'embedding_failed', attempts: 12, accepted_at: ACCEPTED_AT, ready_at: null, next_attempt_at: RETRY_AT, failure_category: 'input_rejected', canonical_memory_id: null, similarity: null },
];

const JOIN = ingestionStatusJoinSql('m');
const SELECT_INGESTION = normalized(ingestionStatusSelectSql('m'));
const SELECT_STATE = normalized(ingestionStateSelectSql('m'));

type Scope = { namespaces: string[]; keyId: string; admin: boolean };

function rows(list: unknown[]) {
  return { command: 'MOCK', rowCount: list.length, oid: 0, fields: [], rows: list };
}

function normalized(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** The job row the current RLS scope may see, per migration 037's owner-or-admin policy. */
function visibleJob(memoryId: string, scope: Scope): JobRow | undefined {
  const job = JOBS.find(candidate => candidate.memory_id === memoryId);
  if (!job) return undefined;
  if (!(job.client_id === scope.keyId || scope.admin)) return undefined;
  if (!scope.namespaces.includes(job.namespace)) return undefined;
  return job;
}

/** Mirrors ingestionStatusSelectSql: full object, queued-from-missing-vector, or NULL. */
function evaluateIngestion(memory: MemoryRow, scope: Scope): MemoryIngestion | null {
  const job = visibleJob(memory.id, scope);
  if (job) {
    return {
      state: ['pending', 'processing', 'retry_wait'].includes(job.status) ? 'queued' : job.status as MemoryIngestion['state'],
      accepted_at: job.accepted_at,
      ready_at: job.ready_at,
      attempts: job.attempts,
      next_retry_at: job.status === 'retry_wait' ? job.next_attempt_at : null,
      failure_category: job.failure_category as MemoryIngestion['failure_category'],
      canonical_memory_id: job.canonical_memory_id,
      similarity: job.similarity,
    };
  }
  if (!memory.embedded) return { state: 'queued' };
  return null;
}

function publicRow(memory: MemoryRow, sql: string, scope: Scope): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: memory.id, content: memory.content, namespace: memory.namespace, source: 'tester', tags: [],
    metadata: {}, access_level: 'normal', client_id: memory.client_id, created_at: NOW, updated_at: NOW,
    document_id: memory.document_id, chunk_index: memory.chunk_index,
    embedding_provider: memory.embedded ? ACTIVE_EMBEDDING_PROFILE.provider : null,
  };
  if (sql.includes(JOIN) || sql.includes(ingestionStatusJoinSql('r', 'ij'))) row.ingestion = evaluateIngestion(memory, scope);
  return row;
}

class ReadPathPool {
  statements: Statement[] = [];

  async connect() {
    const scope: Scope = { namespaces: [], keyId: '', admin: false };
    return {
      query: async (text: string, params: unknown[] = []) => {
        const sql = normalized(text);
        this.statements.push({ text: sql, params });
        if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION READ ONLY)$/.test(sql)) return rows([]);
        if (sql.startsWith("SELECT set_config('app.allowed_namespaces'")) {
          if (sql.includes('true')) scope.namespaces = JSON.parse(String(params[0])) as string[];
          return rows([]);
        }
        if (sql.startsWith("SELECT set_config('app.current_key_id'")) { scope.keyId = String(params[0]); return rows([]); }
        if (sql.startsWith("SELECT set_config('app.current_key_is_admin'")) { scope.admin = params[0] === 'true'; return rows([]); }
        if (sql.startsWith('SELECT set_config(')) return rows([]);
        if (sql.startsWith('INSERT INTO audit_log')) return rows([]);
        if (sql.includes('FROM pg_attribute') && sql.includes('belief_schema')) {
          return rows([{ belief_schema: true, supersession_schema: true, revision_schema: true, validity_finalized: true, consolidation_schema: true }]);
        }
        if (sql.startsWith('UPDATE memories SET accessed_at')) return rows([]);
        if (sql.startsWith('SELECT pg_advisory_xact_lock')) return rows([{}]);
        if (sql.startsWith('SELECT app_transfer_source_key_access')) return rows([{ access: 'none' }]);
        if (sql.startsWith('INSERT INTO memories')) return rows([{ id: PENDING_ID }]);
        const visible = (memory: MemoryRow) => !memory.deleted && scope.namespaces.includes(memory.namespace);

        if (/FROM memory_ingestion_jobs ij WHERE ij\.memory_id = \$1 AND ij\.status = 'deduplicated'/.test(sql)) {
          const job = visibleJob(String(params[0]), scope);
          const namespaces = params[1] as string[];
          return rows(job && job.status === 'deduplicated' && job.canonical_memory_id && namespaces.includes(job.namespace) ? [job] : []);
        }
        if (sql.includes('WHERE m.id = $1 AND m.deleted_at IS NULL')) {
          const memory = MEMORIES.find(candidate => candidate.id === params[0]);
          return rows(memory && visible(memory) && (params[1] as string[]).includes(memory.namespace) ? [publicRow(memory, sql, scope)] : []);
        }
        if (sql.includes('WHERE m.document_id = $1 AND m.deleted_at IS NULL')) {
          return rows(MEMORIES.filter(memory => memory.document_id === params[0] && visible(memory)).map(memory => publicRow(memory, sql, scope)));
        }
        if (sql.startsWith('SELECT COUNT(*)')) {
          return rows([{ total: String(MEMORIES.filter(visible).length) }]);
        }
        if (sql.includes('ORDER BY m.created_at DESC LIMIT') || sql.startsWith('WITH candidates AS')) {
          return rows(MEMORIES.filter(visible).map(memory => publicRow(memory, sql, scope)));
        }
        if (sql.startsWith('WITH vector_results')) {
          return rows(MEMORIES.filter(visible).map(memory => ({ ...publicRow(memory, sql, scope), vec_score: null, text_score: 0.5, final_score: 1 })));
        }
        if (sql.startsWith('SELECT m.id, m.content') && sql.endsWith('LIMIT 1')) {
          const memory = MEMORIES.find(candidate => candidate.id === params[params.length - 1]);
          return rows(memory && visible(memory) ? [publicRow(memory, sql, scope)] : []);
        }
        if (sql.includes('CROSS JOIN instance_settings s')) {
          return rows(MEMORIES.filter(visible).map(memory => ({
            instance_id: INSTANCE_ID, id: memory.id, source_key: null, content: memory.content, source: 'tester',
            namespace: memory.namespace, tags: [], metadata: {}, access_level: 'normal', created_at: NOW, updated_at: NOW,
            event_at: null, memory_kind: 'semantic', valid_from: NOW, valid_to: null, expires_at: null,
            origin_namespace: null, insight_content_hash: null,
            ...(sql.includes('AS ingestion_state') ? { ingestion_state: evaluateIngestion(memory, scope)?.state ?? null } : {}),
          })));
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      release() {},
    };
  }

  async query(): Promise<never> { throw new Error('read paths must use scoped clients'); }

  find(pattern: RegExp): Statement[] {
    return this.statements.filter(statement => pattern.test(statement.text));
  }
}

function pool(t: TestContext, gate: 'on' | 'off'): ReadPathPool {
  const fake = new ReadPathPool();
  setPoolForTesting(fake as unknown as pg.Pool);
  const previous = process.env.MEMORY_INGESTION_QUEUE_ENABLED;
  if (gate === 'on') process.env.MEMORY_INGESTION_QUEUE_ENABLED = 'true';
  else delete process.env.MEMORY_INGESTION_QUEUE_ENABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.MEMORY_INGESTION_QUEUE_ENABLED;
    else process.env.MEMORY_INGESTION_QUEUE_ENABLED = previous;
    setPoolForTesting(null);
  });
  return fake;
}

const FULL_PENDING: MemoryIngestion = {
  state: 'queued', accepted_at: ACCEPTED_AT, ready_at: null, attempts: 2, next_retry_at: RETRY_AT,
  failure_category: 'transient', canonical_memory_id: null, similarity: null,
};

test('recall by id joins the job table content-free and keeps every existing predicate', async t => {
  const fake = pool(t, 'on');
  const row = await memoryRecall({ id: PENDING_ID }, owner);
  const [query] = fake.find(/WHERE m\.id = \$1 AND m\.deleted_at IS NULL/);
  assert.ok(query);
  assert.equal(query.text.includes(`LEFT JOIN agents a ON a.id = m.agent_id ${JOIN} WHERE m.id = $1`), true);
  assert.equal(query.text.includes(`${SELECT_INGESTION} AS ingestion FROM memories m`), true);
  assert.match(query.text, /WHERE m\.id = \$1 AND m\.deleted_at IS NULL AND \(m\.expires_at IS NULL OR m\.expires_at > statement_timestamp\(\)\) AND m\.namespace = ANY\(\$2\) AND/);
  assert.deepEqual(query.params, [PENDING_ID, owner.namespaces, 'secret', OWNER_KEY]);
  // The CASE: full object for a visible job, queued when the vector is absent, NULL otherwise.
  assert.match(SELECT_INGESTION, /^CASE WHEN ij\.memory_id IS NOT NULL THEN jsonb_build_object\( 'state', CASE WHEN ij\.status IN \('pending', 'processing', 'retry_wait'\) THEN 'queued' ELSE ij\.status END, 'accepted_at', ij\.accepted_at, 'ready_at', ij\.ready_at, 'attempts', ij\.attempts, 'next_retry_at', CASE WHEN ij\.status = 'retry_wait' THEN ij\.next_attempt_at ELSE NULL END, 'failure_category', ij\.failure_category, 'canonical_memory_id', ij\.canonical_memory_id, 'similarity', ij\.similarity\) WHEN m\.embedding IS NULL THEN jsonb_build_object\('state', 'queued'\) ELSE NULL END$/);
  assert.doesNotMatch(SELECT_INGESTION, /content|source_key|lease_token|last_error_code/);
  assert.equal(row.id, PENDING_ID);
  assert.deepEqual(row.ingestion, FULL_PENDING);
  const [audit] = fake.find(/^INSERT INTO audit_log/);
  assert.deepEqual(audit.params.slice(0, 4), [OWNER_KEY, 'memory.recall', null, PENDING_ID]);
});

test('owners and admins see the full ingestion object; other readers in the namespace see state only', async t => {
  pool(t, 'on');
  assert.deepEqual((await memoryRecall({ id: PENDING_ID }, admin)).ingestion, FULL_PENDING);
  assert.deepEqual((await memoryRecall({ id: PENDING_ID }, other)).ingestion, { state: 'queued' });
  const failed = await memoryRecall({ id: FAILED_ID }, owner);
  assert.deepEqual(failed.ingestion, {
    state: 'embedding_failed', accepted_at: ACCEPTED_AT, ready_at: null, attempts: 12, next_retry_at: null,
    failure_category: 'input_rejected', canonical_memory_id: null, similarity: null,
  });
  assert.deepEqual((await memoryRecall({ id: FAILED_ID }, other)).ingestion, { state: 'queued' });
  const ready = await memoryRecall({ id: CANONICAL_ID }, owner);
  assert.equal(ready.ingestion?.state, 'ready');
  assert.equal(ready.ingestion?.ready_at, READY_AT);
  assert.equal(ready.ingestion?.next_retry_at, null);
});

test('a memory with a vector and no visible job row reports ingestion null', async t => {
  pool(t, 'on');
  assert.equal((await memoryRecall({ id: LEGACY_ID }, owner)).ingestion, null);
  assert.equal((await memoryRecall({ id: LEGACY_ID }, admin)).ingestion, null);
  // Another owner's ready row: the job is RLS-hidden and the vector exists, so nothing is inferred.
  assert.equal((await memoryRecall({ id: CANONICAL_ID }, other)).ingestion, null);
});

test('recall by document_id attaches the same object to every chunk', async t => {
  const fake = pool(t, 'on');
  const chunks = await memoryRecall({ document_id: DOCUMENT_ID }, owner);
  assert.deepEqual(chunks.map(chunk => chunk.id), [PENDING_ID, LEGACY_ID]);
  assert.deepEqual(chunks[0].ingestion, FULL_PENDING);
  assert.equal(chunks[1].ingestion, null);
  const [query] = fake.find(/WHERE m\.document_id = \$1 AND m\.deleted_at IS NULL/);
  assert.equal(query.text.includes(`LEFT JOIN agents a ON a.id = m.agent_id ${JOIN} WHERE m.document_id = $1`), true);
  assert.equal(query.text.includes(`${SELECT_INGESTION} AS ingestion FROM memories m`), true);
  assert.match(query.text, /AND to_jsonb\(m\)->>'consolidated_into_id' IS NULL AND m\.namespace = ANY\(\$2\) AND .* ORDER BY m\.chunk_index ASC$/);
});

test('recall by a deduplicated pending id returns the canonical row with canonical_memory_id and similarity', async t => {
  const fake = pool(t, 'on');
  const row = await memoryRecall({ id: DEDUPED_ID }, owner);
  assert.equal(row.id, CANONICAL_ID);
  assert.equal(row.content, 'canonical content');
  assert.deepEqual(row.ingestion, {
    state: 'deduplicated', accepted_at: ACCEPTED_AT, ready_at: READY_AT, attempts: 1, next_retry_at: null,
    failure_category: null, canonical_memory_id: CANONICAL_ID, similarity: 0.97,
  });
  const lookups = fake.find(/^SELECT ij\.status, ij\.accepted_at, ij\.ready_at, ij\.attempts, ij\.next_attempt_at, ij\.failure_category, ij\.canonical_memory_id, ij\.similarity FROM memory_ingestion_jobs ij WHERE ij\.memory_id = \$1 AND ij\.status = 'deduplicated' AND ij\.canonical_memory_id IS NOT NULL AND ij\.namespace = ANY\(\$2\)$/);
  assert.equal(lookups.length, 1);
  assert.deepEqual(lookups[0].params, [DEDUPED_ID, owner.namespaces]);
  const recalls = fake.find(/WHERE m\.id = \$1 AND m\.deleted_at IS NULL/);
  assert.deepEqual(recalls.map(statement => statement.params[0]), [DEDUPED_ID, CANONICAL_ID]);
  const [audit] = fake.find(/^INSERT INTO audit_log/);
  assert.equal(audit.params[1], 'memory.recall');
  assert.equal(audit.params[3], CANONICAL_ID, 'memory_id is the row returned');
  assert.equal(audit.params[9], DEDUPED_ID, 'resource_id is the id requested');
});

test('every other soft-deleted or hidden id stays not found, including a deduplicated id for a non-owner', async t => {
  const fake = pool(t, 'on');
  await assert.rejects(memoryRecall({ id: FORGOTTEN_ID }, owner), /Memory not found or access denied/);
  await assert.rejects(memoryRecall({ id: DEDUPED_ID }, other), /Memory not found or access denied/);
  await assert.rejects(memoryRecall({ id: DEDUPED_ID }, { ...owner, namespaces: ['private'] }), /Memory not found or access denied/);
  assert.equal(fake.find(/^INSERT INTO audit_log/).length, 0);
  // The redirect never resolves a canonical row the caller could not recall directly.
  assert.equal(fake.find(/WHERE m\.id = \$1 AND m\.deleted_at IS NULL/).every(statement => statement.params[0] !== CANONICAL_ID), true);
});

test('with the gate off recall issues the pre-queue statements only and returns no ingestion key', async t => {
  const fake = pool(t, 'off');
  const row = await memoryRecall({ id: PENDING_ID }, owner);
  assert.equal('ingestion' in row, false);
  await assert.rejects(memoryRecall({ id: DEDUPED_ID }, owner), /Memory not found or access denied/);
  assert.equal(fake.statements.some(statement => /memory_ingestion_jobs|ingestion/.test(statement.text)), false);
  assert.equal(fake.find(/WHERE m\.id = \$1 AND m\.deleted_at IS NULL/).length, 2);
  const chunks = await memoryRecall({ document_id: DOCUMENT_ID }, owner);
  assert.equal(chunks.every(chunk => !('ingestion' in chunk)), true);
});

test('memory_list carries the ingestion column on the page query only and leaves the count untouched', async t => {
  const fake = pool(t, 'on');
  const result = await memoryList({ limit: 20, offset: 0, source: 'tester', tags: ['x'] }, owner);
  assert.equal(result.total, 4);
  const byId = Object.fromEntries(result.memories.map(memory => [memory.id, memory.ingestion]));
  assert.deepEqual(byId[PENDING_ID], FULL_PENDING);
  assert.equal(byId[CANONICAL_ID]?.state, 'ready');
  assert.equal(byId[LEGACY_ID], null);
  assert.equal(byId[FAILED_ID]?.state, 'embedding_failed');
  const [count] = fake.find(/^SELECT COUNT\(\*\) as total FROM memories m WHERE/);
  assert.doesNotMatch(count.text, /memory_ingestion_jobs|ingestion/);
  const [page] = fake.find(/ORDER BY m\.created_at DESC LIMIT \$\d+ OFFSET \$\d+$/);
  assert.equal(page.text.includes(`LEFT JOIN agents a ON a.id = m.agent_id ${JOIN} WHERE m.namespace = ANY($1) AND m.deleted_at IS NULL`), true);
  assert.equal(page.text.includes(`${SELECT_INGESTION} AS ingestion FROM memories m`), true);
  assert.deepEqual(page.params, [owner.namespaces, 'secret', 'tester', ['x'], 20, 0]);

  const otherView = await memoryList({ limit: 20, offset: 0 }, other);
  assert.deepEqual(otherView.memories.find(memory => memory.id === PENDING_ID)?.ingestion, { state: 'queued' });
  assert.equal(otherView.memories.find(memory => memory.id === CANONICAL_ID)?.ingestion, null);

  const off = pool(t, 'off');
  const legacy = await memoryList({ limit: 20, offset: 0 }, owner);
  assert.equal(legacy.memories.every(memory => !('ingestion' in memory)), true);
  assert.equal(off.statements.some(statement => /memory_ingestion_jobs|ingestion/.test(statement.text)), false);
});

test('hybrid search attaches ingestion to every ranked row through a vector-presence flag', async t => {
  const fake = pool(t, 'on');
  const scope = { namespaces: ['shared', 'private'], keyId: OWNER_KEY };
  const options = {
    trackAccess: false as const,
    queryVectors: [{ profile: { ...ACTIVE_EMBEDDING_PROFILE }, vector: Array(768).fill(0.1) }],
  };
  const results = await executeHybridSearch({ query: 'pending', limit: 10, threshold: 0.3 }, ['shared', 'private'], scope, 'secret', options);
  assert.deepEqual(results.find(result => result.id === PENDING_ID)?.ingestion, FULL_PENDING);
  assert.equal(results.find(result => result.id === LEGACY_ID)?.ingestion, null);
  const [search] = fake.find(/^WITH vector_results AS/);
  assert.match(search.text, /embedding_dimensions, m\.memory_kind, m\.valid_from, m\.valid_to, m\.supersedes_id AS linked_supersedes_id, m\.superseded_at, m\.revision, \(embedding IS NULL\) AS unembedded, 1 - \(embedding <=>/);
  assert.equal(search.text.includes(`FROM ranked r LEFT JOIN agents a ON a.id = r.agent_id ${ingestionStatusJoinSql('r', 'ij')} ORDER BY final_score DESC, r.id LIMIT`), true);
  assert.equal(search.text.includes(`END AS provenance, ${normalized(ingestionStatusSelectSql('r', 'ij', 'r.unembedded'))} AS ingestion FROM ranked r`), true);
  assert.match(search.text, /WHEN r\.unembedded THEN jsonb_build_object\('state', 'queued'\) ELSE NULL END AS ingestion/);
  assert.doesNotMatch(search.text, /r\.embedding IS NULL/);
  const referenced = [...new Set([...search.text.matchAll(/\$(\d+)/g)].map(match => Number(match[1])))].sort((a, b) => a - b);
  assert.deepEqual(referenced, Array.from({ length: search.params.length }, (_, index) => index + 1));

  const off = pool(t, 'off');
  const legacy = await executeHybridSearch({ query: 'pending', limit: 10, threshold: 0.3 }, ['shared'], scope, 'secret', options);
  assert.equal(legacy.every(result => !('ingestion' in result)), true);
  const [legacySearch] = off.find(/^WITH vector_results AS/);
  assert.doesNotMatch(legacySearch.text, /memory_ingestion_jobs|unembedded|ingestion/);
});

test('the dashboard browse and detail queries carry the same gated projection', async t => {
  const fake = pool(t, 'on');
  const page = await listMemories(owner, { active: 'active', sort: 'created_at', direction: 'desc', limit: 50, offset: 0 });
  assert.deepEqual(page.memories.find((memory: { id: string }) => memory.id === PENDING_ID)?.ingestion, FULL_PENDING);
  const [browse] = fake.find(/^WITH candidates AS/);
  assert.equal(browse.text.includes(`FROM memories m LEFT JOIN agents a ON a.id = m.agent_id ${JOIN} WHERE m.namespace = ANY($1::text[])`), true);
  assert.equal(browse.text.includes(`END AS provenance, ${SELECT_INGESTION} AS ingestion FROM memories m`), true);
  assert.match(browse.text, /CROSS JOIN LATERAL/);
  const detail = await getMemory(other, PENDING_ID);
  assert.deepEqual(detail?.ingestion, { state: 'queued' });
  const [single] = fake.find(/^SELECT m\.id, m\.content, .* FROM memories m LEFT JOIN agents a ON a\.id = m\.agent_id .* LIMIT 1$/);
  assert.equal(single.text.includes(`FROM memories m LEFT JOIN agents a ON a.id = m.agent_id ${JOIN} WHERE`), true);

  const off = pool(t, 'off');
  await listMemories(owner, { active: 'active', sort: 'created_at', direction: 'desc', limit: 50, offset: 0 });
  await getMemory(owner, PENDING_ID);
  assert.equal(off.statements.some(statement => /memory_ingestion_jobs|ingestion/.test(statement.text)), false);
});

test('export includes pending rows with a content-free ingestion_state and omits it otherwise', async t => {
  const fake = pool(t, 'on');
  const page = await exportMemoryPage({ limit: 100, include_sensitive: false, acknowledge_plaintext_sensitive: false }, owner);
  const states = Object.fromEntries(page.records.map(record => [record.provenance.memory_id, record.ingestion_state]));
  assert.equal(states[PENDING_ID], 'queued');
  assert.equal(states[FAILED_ID], 'embedding_failed');
  assert.equal(states[CANONICAL_ID], 'ready');
  assert.equal(states[LEGACY_ID], undefined);
  assert.equal('ingestion_state' in page.records.find(record => record.provenance.memory_id === LEGACY_ID)!, false);
  assert.equal(page.records.find(record => record.provenance.memory_id === PENDING_ID)?.content, SECRET, 'accepted content is exported like any other row');
  const [query] = fake.find(/CROSS JOIN instance_settings s/);
  assert.equal(query.text.includes(`${SELECT_STATE} AS ingestion_state FROM memories m CROSS JOIN instance_settings s ${JOIN} WHERE s.singleton = true AND m.namespace = ANY($1::text[])`), true);
  assert.match(SELECT_STATE, /^CASE WHEN ij\.memory_id IS NOT NULL THEN CASE WHEN ij\.status IN \('pending', 'processing', 'retry_wait'\) THEN 'queued' ELSE ij\.status END WHEN m\.embedding IS NULL THEN 'queued' ELSE NULL END$/);
  assert.match(query.text, /AND m\.deleted_at IS NULL AND \(m\.expires_at IS NULL OR m\.expires_at > statement_timestamp\(\)\) AND m\.superseded_at IS NULL AND m\.consolidated_into_id IS NULL ORDER BY m\.created_at ASC, m\.id ASC LIMIT \$3$/);
  for (const record of page.records) {
    assert.equal('embedding' in record, false);
    assert.equal('embedding_provider' in record, false);
  }

  const off = pool(t, 'off');
  const legacy = await exportMemoryPage({ limit: 100, include_sensitive: false, acknowledge_plaintext_sensitive: false }, owner);
  assert.equal(legacy.records.every(record => !('ingestion_state' in record)), true);
  assert.equal(off.statements.some(statement => /memory_ingestion_jobs|ingestion/.test(statement.text)), false);
});

test('transfer records accept ingestion_state as an additive hint that never joins the fingerprint', () => {
  const base = {
    type: 'memory', source_key: 'portable:key', content: 'remember this', source: 'test', namespace: 'shared',
    tags: [], metadata: {}, access_level: 'normal', created_at: NOW, updated_at: NOW, memory_kind: 'semantic',
    provenance: { trust: 'untrusted', instance_id: INSTANCE_ID, memory_id: PENDING_ID },
  };
  const plain = parseTransferMemoryRecord(base);
  const queued = parseTransferMemoryRecord({ ...base, ingestion_state: 'queued' });
  assert.equal(queued.ingestion_state, 'queued');
  assert.equal('ingestion_state' in plain, false);
  assert.equal(transferRecordFingerprint(plain), transferRecordFingerprint(queued));
  assert.throws(() => parseTransferMemoryRecord({ ...base, ingestion_state: 'processing' }));
  assert.throws(() => parseTransferMemoryRecord({ ...base, ingestion_state: 'queued', embedding: [0.1] }), /not portable/);
});

test('import re-embeds a queued record with the destination profile and never reads a vector from it', async t => {
  const fake = pool(t, 'on');
  const embedded: string[] = [];
  const embedder = async (texts: string[]): Promise<EmbeddingResult[]> => {
    embedded.push(...texts);
    return texts.map(() => ({ vector: Array(768).fill(0.5), ...ACTIVE_EMBEDDING_PROFILE }));
  };
  const result = await importMemoryBatch({
    manifest: { type: 'manifest', format: 'total-recall-memory-feed', version: { major: 1, minor: 0 }, source_instance_id: INSTANCE_ID, exported_at: NOW },
    records: [{
      type: 'memory', source_key: 'portable:pending', content: SECRET, source: 'tester', namespace: 'shared',
      tags: [], metadata: {}, access_level: 'normal', created_at: NOW, updated_at: NOW, memory_kind: 'semantic',
      ingestion_state: 'queued',
      provenance: { trust: 'untrusted', instance_id: INSTANCE_ID, memory_id: PENDING_ID },
    }],
  }, owner, { embedder });
  assert.equal(result.inserted, 1);
  assert.equal(result.embedding_calls, 1);
  assert.deepEqual(embedded, [SECRET]);
  const [insert] = fake.find(/^INSERT INTO memories/);
  assert.equal(insert.params[0], SECRET);
  assert.equal(insert.params[1], `[${Array(768).fill(0.5).join(',')}]`);
  assert.deepEqual(insert.params.slice(18), [ACTIVE_EMBEDDING_PROFILE.provider, ACTIVE_EMBEDDING_PROFILE.model, ACTIVE_EMBEDDING_PROFILE.dimensions]);
  assert.equal(insert.params.includes('queued'), false);
  assert.doesNotMatch(insert.text, /ingestion/);
});

test('no ingestion SQL fragment or job lookup ever selects memory content', async t => {
  const fake = pool(t, 'on');
  await memoryRecall({ id: DEDUPED_ID }, owner);
  for (const statement of fake.find(/memory_ingestion_jobs ij WHERE/)) {
    assert.doesNotMatch(statement.text, /content|metadata|tags|source_key/);
  }
  for (const fragment of [SELECT_INGESTION, SELECT_STATE, JOIN]) {
    assert.doesNotMatch(fragment, /content|metadata|source_key|lease_token|last_error_code|allowed_namespaces/);
  }
});
