import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import { setPoolForTesting } from '../src/db.js';
import type { DbScope } from '../src/db.js';
import type { SearchParams } from '../src/types.js';

type QueryCall = { text: string; params?: unknown[] };

class FakeClient {
  readonly calls: QueryCall[] = [];
  releaseArgs: unknown[] | undefined;
  rows: pg.QueryResultRow[] = [];
  capabilities = {
    belief_schema: false,
    supersession_schema: false,
    revision_schema: false,
    validity_finalized: false,
  };
  failOnSearch = false;
  failOnUpdate = false;

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<pg.QueryResult<T>> {
    this.calls.push({ text, params });

    if (text.includes('FROM pg_attribute') && text.includes('belief_schema')) {
      return result([this.capabilities as unknown as T]);
    }

    if (text.includes('WITH vector_results')) {
      if (this.failOnSearch) throw new Error('search failed');
      return result(this.rows as T[]);
    }

    if (text.startsWith('UPDATE memories')) {
      if (this.failOnUpdate) throw new Error('update failed');
      return result([]);
    }

    return result([]);
  }

  release(err?: Error): void {
    this.releaseArgs = err ? [err] : [];
  }
}

class FakePool {
  constructor(private readonly client: FakeClient) {}

  async connect(): Promise<FakeClient> {
    return this.client;
  }
}

function result<T extends pg.QueryResultRow>(rows: T[]): pg.QueryResult<T> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

async function loadSearch(demotionEnabled = false): Promise<typeof import('../src/search.js')> {
  process.env.HNSW_EF_SEARCH = '321';
  process.env.SUPERSEDED_SEARCH_DEMOTION_ENABLED = demotionEnabled ? 'true' : 'false';
  process.env.EMBEDDING_PROVIDER = 'gemini';
  process.env.EMBEDDING_MODEL = 'gemini-embedding-2-preview';
  process.env.EMBEDDING_DIMENSIONS = '768';
  process.env.GEMINI_API_KEY = 'test-only-key';
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ embedding: { values: Array(768).fill(0.1) } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  return import(`../src/search.js?case=${Date.now()}-${Math.random()}`);
}

const scope: DbScope = {
  namespaces: ['shared'],
  keyId: 'key-1',
  isAdmin: false,
};

const params: SearchParams = {
  query: 'vector recall',
  limit: 5,
  threshold: 0.4,
};

test('hybridSearch sets local HNSW inside the scoped transaction before search and update', async () => {
  const client = new FakeClient();
  client.rows = [{ id: 'memory-1', content: 'result' }];
  setPoolForTesting(new FakePool(client) as unknown as pg.Pool);

  const { hybridSearch } = await loadSearch();
  const rows = await hybridSearch(params, ['shared'], scope, 'normal');

  assert.deepEqual(rows, client.rows);
  assert.deepEqual(
    client.calls.map((call) => summarize(call.text)),
    [
      "SELECT set_config('app.allowed_namespaces', '', false)",
      'BEGIN',
      "SELECT set_config('app.allowed_namespaces', $1, true)",
      "SELECT set_config('app.current_key_id', $1, true)",
      "SELECT set_config('app.current_key_is_admin', $1, true)",
      "SELECT set_config('hnsw.ef_search', $1, true)",
      'SCHEMA',
      'SEARCH',
      'UPDATE memories',
      'COMMIT',
    ]
  );
  assert.deepEqual(client.calls[5].params, ['321']);
  assert.deepEqual(client.calls[8].params, [['memory-1']]);
  assert.deepEqual(client.releaseArgs, []);
});

test('hybridSearch commits empty result searches without an access-count update', async () => {
  const client = new FakeClient();
  setPoolForTesting(new FakePool(client) as unknown as pg.Pool);

  const { hybridSearch } = await loadSearch();
  const rows = await hybridSearch(params, ['shared'], scope, 'normal');

  assert.deepEqual(rows, []);
  assert.deepEqual(
    client.calls.map((call) => summarize(call.text)),
    [
      "SELECT set_config('app.allowed_namespaces', '', false)",
      'BEGIN',
      "SELECT set_config('app.allowed_namespaces', $1, true)",
      "SELECT set_config('app.current_key_id', $1, true)",
      "SELECT set_config('app.current_key_is_admin', $1, true)",
      "SELECT set_config('hnsw.ef_search', $1, true)",
      'SCHEMA',
      'SEARCH',
      'COMMIT',
    ]
  );
  assert.deepEqual(client.releaseArgs, []);
});

test('hybridSearch rolls back and releases when search or update fails', async () => {
  const searchFailure = new FakeClient();
  searchFailure.failOnSearch = true;
  setPoolForTesting(new FakePool(searchFailure) as unknown as pg.Pool);

  const { hybridSearch } = await loadSearch();
  await assert.rejects(() => hybridSearch(params, ['shared'], scope, 'normal'), /search failed/);
  assert.deepEqual(searchFailure.calls.map((call) => summarize(call.text)).at(-1), 'ROLLBACK');
  assert.deepEqual(searchFailure.releaseArgs, []);

  const updateFailure = new FakeClient();
  updateFailure.rows = [{ id: 'memory-2', content: 'result' }];
  updateFailure.failOnUpdate = true;
  setPoolForTesting(new FakePool(updateFailure) as unknown as pg.Pool);

  await assert.rejects(() => hybridSearch(params, ['shared'], scope, 'normal'), /update failed/);
  assert.deepEqual(
    updateFailure.calls.map((call) => summarize(call.text)),
    [
      "SELECT set_config('app.allowed_namespaces', '', false)",
      'BEGIN',
      "SELECT set_config('app.allowed_namespaces', $1, true)",
      "SELECT set_config('app.current_key_id', $1, true)",
      "SELECT set_config('app.current_key_is_admin', $1, true)",
      "SELECT set_config('hnsw.ef_search', $1, true)",
      'SCHEMA',
      'SEARCH',
      'UPDATE memories',
      'ROLLBACK',
    ]
  );
  assert.deepEqual(updateFailure.releaseArgs, []);
});

test('hybridSearch selects a pre-026 query shape without swallowing SQL failures', async () => {
  const client = new FakeClient();
  setPoolForTesting(new FakePool(client) as unknown as pg.Pool);

  const { hybridSearch } = await loadSearch();
  await hybridSearch(params, ['shared'], scope, 'normal');
  const searchSql = client.calls.find(call => call.text.includes('WITH vector_results'))!.text;
  assert.doesNotMatch(searchSql, /m\.(?:memory_kind|valid_from|valid_to)/);
  assert.match(searchSql, /NULL::timestamptz AS valid_from/);

  client.failOnSearch = true;
  await assert.rejects(() => hybridSearch(params, ['shared'], scope, 'normal'), /search failed/);
});

test('hybridSearch preserves #52 lifecycle fields while belief-validity columns are absent', async () => {
  const client = new FakeClient();
  client.capabilities.supersession_schema = true;
  client.capabilities.revision_schema = true;
  setPoolForTesting(new FakePool(client) as unknown as pg.Pool);

  const { hybridSearch } = await loadSearch(true);
  await hybridSearch(params, ['shared'], scope, 'normal');
  const searchSql = client.calls.find(call => call.text.includes('WITH vector_results'))!.text;
  assert.match(searchSql, /m\.superseded_at/);
  assert.match(searchSql, /m\.revision/);
  assert.doesNotMatch(searchSql, /m\.(?:memory_kind|valid_from|valid_to)/);
  assert.match(searchSql, /CASE WHEN s\.superseded_at IS NOT NULL THEN \$\d+::double precision/);
  assert.match(searchSql, /successor\.access_level/);
});

test('finalized valid_at search filters both candidate paths without present-day demotion', async () => {
  const client = new FakeClient();
  client.capabilities = {
    belief_schema: true,
    supersession_schema: true,
    revision_schema: true,
    validity_finalized: true,
  };
  setPoolForTesting(new FakePool(client) as unknown as pg.Pool);

  const { hybridSearch } = await loadSearch(true);
  await hybridSearch(
    { ...params, valid_at: '2026-03-01T00:00:00Z' },
    ['shared'], scope, 'normal',
  );
  const searchSql = client.calls.find(call => call.text.includes('WITH vector_results'))!.text;
  assert.match(searchSql, /m\.valid_from <= \$\d+::timestamptz/);
  assert.match(searchSql, /m\.valid_to IS NULL OR \$\d+::timestamptz < m\.valid_to/);
  assert.doesNotMatch(searchSql, /CASE WHEN s\.superseded_at IS NOT NULL/);
});

test('valid_at fails closed before query construction until validity finalization', async () => {
  const client = new FakeClient();
  setPoolForTesting(new FakePool(client) as unknown as pg.Pool);

  const { hybridSearch } = await loadSearch();
  await assert.rejects(
    () => hybridSearch({ ...params, valid_at: '2026-03-01T00:00:00Z' }, ['shared'], scope, 'normal'),
    /temporal search is unavailable/i,
  );
  assert.equal(client.calls.some(call => call.text.includes('WITH vector_results')), false);
});

function summarize(sql: string): string {
  if (sql.includes('FROM pg_attribute') && sql.includes('belief_schema')) return 'SCHEMA';
  if (sql.includes('WITH vector_results')) return 'SEARCH';
  if (sql.startsWith('UPDATE memories')) return 'UPDATE memories';
  return sql;
}
