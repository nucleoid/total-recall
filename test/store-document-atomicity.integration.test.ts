import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type pg from 'pg';
import { setPoolForTesting } from '../src/db.js';
import type { AuthContext } from '../src/types.js';

type QueryCall = { text: string; params?: unknown[] };
type DocumentRow = {
  id: string;
  title: string;
  source: string;
  namespace: string;
  tags: string[];
  client_id: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  chunk_count: number;
};
type MemoryRow = {
  id: string;
  content: string;
  client_id: string;
  document_id: string;
  chunk_index: number;
};

const AUTH_A: AuthContext = {
  keyId: '11111111-1111-4111-8111-111111111111',
  name: 'tenant-a',
  namespaces: ['shared'],
  permissions: ['read', 'write'],
  maxAccessLevel: 'normal',
};

const AUTH_B: AuthContext = {
  ...AUTH_A,
  keyId: '22222222-2222-4222-8222-222222222222',
  name: 'tenant-b',
};

function chunkedContent(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `paragraph ${i + 1} ${'x'.repeat(2100)}`
  ).join('\n\n');
}

class FakeDatabase {
  docs: DocumentRow[] = [];
  memories: MemoryRow[] = [];
  nextDoc = 1;
  nextMem = 1;
}

type FailureOptions = {
  failDocumentInsert?: boolean;
  failMemoryInsertAt?: number;
  failCountUpdate?: boolean;
  forceZeroRowUpdate?: boolean;
  failCommit?: boolean;
};

class FakeClient {
  readonly calls: QueryCall[] = [];
  private pendingDocs: DocumentRow[] = [];
  private pendingMemories: MemoryRow[] = [];
  private memoryInsertCount = 0;

  constructor(
    private readonly db: FakeDatabase,
    private readonly failures: FailureOptions = {}
  ) {}

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<pg.QueryResult<T>> {
    this.calls.push({ text, params });
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (normalized === 'BEGIN') {
      this.pendingDocs = [];
      this.pendingMemories = [];
      this.memoryInsertCount = 0;
      return this.result([]);
    }
    if (normalized.startsWith("SELECT set_config('app.")) return this.result([]);
    if (normalized === 'COMMIT') {
      if (this.failures.failCommit) throw new Error('commit failed');
      this.db.docs.push(...this.pendingDocs);
      this.db.memories.push(...this.pendingMemories);
      this.pendingDocs = [];
      this.pendingMemories = [];
      return this.result([]);
    }
    if (normalized === 'ROLLBACK') {
      this.pendingDocs = [];
      this.pendingMemories = [];
      return this.result([]);
    }

    if (/^SELECT .*FROM documents d/i.test(normalized)) {
      const keyId = String(params?.[0]);
      const namespace = String(params?.[1]);
      const idempotencyKey = String(params?.[2]);
      const doc = [...this.db.docs, ...this.pendingDocs].find(
        (row) => row.client_id === keyId && row.namespace === namespace && row.idempotency_key === idempotencyKey
      );
      if (!doc) return this.result([]);
      const actual_count = [...this.db.memories, ...this.pendingMemories].filter(
        (row) => row.document_id === doc.id && row.client_id === keyId
      ).length;
      return this.result([{ ...doc, actual_count } as T]);
    }

    if (/^INSERT INTO documents/i.test(normalized)) {
      if (this.failures.failDocumentInsert) throw new Error('document insert failed');
      const hasIdempotency = /idempotency_key/i.test(normalized);
      const clientId = hasIdempotency ? String(params?.[4]) : null;
      const idempotencyKey = hasIdempotency ? String(params?.[5]) : null;
      const namespace = String(params?.[2]);
      const existing = hasIdempotency
        ? this.db.docs.find(
            (row) => row.client_id === clientId && row.namespace === namespace && row.idempotency_key === idempotencyKey
          )
        : undefined;
      if (existing && /ON CONFLICT/i.test(normalized)) return this.result([], 0);

      const doc: DocumentRow = {
        id: `doc-${this.db.nextDoc++}`,
        title: String(params?.[0]),
        source: String(params?.[1]),
        namespace: String(params?.[2]),
        tags: (params?.[3] as string[]) ?? [],
        client_id: clientId,
        idempotency_key: idempotencyKey,
        request_hash: hasIdempotency ? String(params?.[6]) : null,
        chunk_count: 0,
      };
      this.pendingDocs.push(doc);
      return this.result([{ id: doc.id } as T]);
    }

    if (/^INSERT INTO memories/i.test(normalized)) {
      this.memoryInsertCount += 1;
      if (this.failures.failMemoryInsertAt === this.memoryInsertCount) {
        throw new Error('memory insert failed');
      }
      this.pendingMemories.push({
        id: `mem-${this.db.nextMem++}`,
        content: String(params?.[0]),
        client_id: String(params?.[7]),
        document_id: String(params?.[8]),
        chunk_index: Number(params?.[9]),
      });
      return this.result([{ id: this.pendingMemories.at(-1)!.id } as T]);
    }

    if (/^UPDATE documents SET chunk_count/i.test(normalized)) {
      if (this.failures.failCountUpdate) throw new Error('count update failed');
      if (this.failures.forceZeroRowUpdate) return this.result([], 0);
      const count = Number(params?.[0]);
      const id = String(params?.[1]);
      const clientId = String(params?.[2]);
      const namespace = String(params?.[3]);
      const doc = this.pendingDocs.find(
        (row) => row.id === id && row.client_id === clientId && row.namespace === namespace
      );
      if (!doc) return this.result([], 0);
      doc.chunk_count = count;
      return this.result([], 1);
    }

    throw new Error(`Unexpected SQL: ${normalized}`);
  }

  release(): void {}

  private result<T extends pg.QueryResultRow>(rows: T[], rowCount = rows.length): pg.QueryResult<T> {
    return { command: 'MOCK', rowCount, oid: 0, fields: [], rows };
  }
}

class FakePool {
  readonly clients: FakeClient[] = [];
  queryCalls = 0;

  constructor(
    readonly db = new FakeDatabase(),
    private readonly failures: FailureOptions = {}
  ) {}

  async connect(): Promise<FakeClient> {
    const client = new FakeClient(this.db, this.failures);
    this.clients.push(client);
    return client;
  }

  async query(): Promise<never> {
    this.queryCalls += 1;
    throw new Error('store_document must not use pool-level query');
  }
}

function installEmbeddingMock(failAt?: number): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (failAt === calls) {
      return new Response('embedding failed', { status: 500 });
    }
    return new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls: () => calls };
}

async function loadStoreDocument() {
  process.env.GEMINI_API_KEY = '';
  return import('../src/tools/store-document.js');
}

test('embed failure at chunk 7 opens no database transaction', async () => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  installEmbeddingMock(7);
  const { memoryStoreDocument } = await loadStoreDocument();

  await assert.rejects(
    () =>
      memoryStoreDocument({
        title: 'doc',
        content: chunkedContent(8),
        namespace: 'shared',
        tags: [],
        source: 'manual',
      }, AUTH_A),
    /embed failed/
  );

  assert.equal(pool.clients.length, 0);
  assert.equal(pool.db.docs.length, 0);
  assert.equal(pool.db.memories.length, 0);
});

test('malformed provider vectors are reported as provider failures, not invalid client requests', async () => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ embeddings: [[]] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )) as typeof fetch;
  const { memoryStoreDocument } = await loadStoreDocument();

  await assert.rejects(
    () => memoryStoreDocument({
      title: 'doc', content: 'one chunk', namespace: 'shared', tags: [], source: 'manual',
    }, AUTH_A),
    /^Error: Embedding provider returned an invalid vector for chunk 0$/
  );
  assert.equal(pool.clients.length, 0);
});

test('same namespace idempotency key converges and changed request conflicts; namespace and tenant scopes may reuse key', async () => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  const embeddings = installEmbeddingMock();
  const { memoryStoreDocument, storeDocumentSchema } = await loadStoreDocument();
  const params = storeDocumentSchema.parse({
    title: 'doc',
    content: chunkedContent(2),
    namespace: 'shared',
    tags: ['b', 'a', 'a'],
    source: 'manual',
    idempotency_key: 'upload-1',
  });

  const first = await memoryStoreDocument(params, AUTH_A);
  const retry = await memoryStoreDocument(params, AUTH_A);

  assert.equal(retry.document_id, first.document_id);
  assert.equal(retry.chunks_stored, 2);
  assert.equal(pool.db.docs.filter((row) => row.client_id === AUTH_A.keyId).length, 1);
  assert.equal(pool.db.memories.filter((row) => row.client_id === AUTH_A.keyId).length, 2);
  assert.equal(embeddings.calls(), 2, 'completed idempotent retries should return before embedding');

  await assert.rejects(
    () => memoryStoreDocument({ ...params, content: 'changed' }, AUTH_A),
    /idempotency key/i
  );
  assert.equal(pool.db.docs.filter((row) => row.client_id === AUTH_A.keyId).length, 1);

  const otherNamespace = await memoryStoreDocument(
    { ...params, namespace: 'other' },
    { ...AUTH_A, namespaces: ['shared', 'other'] }
  );
  assert.notEqual(otherNamespace.document_id, first.document_id);

  const otherTenant = await memoryStoreDocument(params, AUTH_B);
  assert.notEqual(otherTenant.document_id, first.document_id);
  assert.equal(pool.db.docs.filter((row) => row.idempotency_key === 'upload-1').length, 3);
});

test('canonical tag ordering remains stable across locale/ICU changes', async () => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  installEmbeddingMock();
  const { memoryStoreDocument } = await loadStoreDocument();
  const params = {
    title: 'stable hash',
    content: 'one chunk',
    namespace: 'shared',
    tags: ['b', 'a'],
    source: 'manual',
    idempotency_key: 'stable-tags',
  };

  const first = await memoryStoreDocument(params, AUTH_A);
  const originalLocaleCompare = String.prototype.localeCompare;
  String.prototype.localeCompare = function (compareString: string): number {
    const value = String(this);
    return value < compareString ? 1 : value > compareString ? -1 : 0;
  };
  try {
    const retry = await memoryStoreDocument({ ...params, tags: ['a', 'b', 'a'] }, AUTH_A);
    assert.equal(retry.document_id, first.document_id);
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }
});

test('document, chunk, count, and commit failures leave no visible partial state', async () => {
  const cases: Array<[string, FailureOptions]> = [
    ['document insert failed', { failDocumentInsert: true }],
    ['memory insert failed', { failMemoryInsertAt: 2 }],
    ['count update failed', { failCountUpdate: true }],
    ['commit failed', { failCommit: true }],
  ];
  const { memoryStoreDocument } = await loadStoreDocument();

  for (const [message, failures] of cases) {
    const pool = new FakePool(new FakeDatabase(), failures);
    setPoolForTesting(pool as unknown as pg.Pool);
    installEmbeddingMock();

    await assert.rejects(
      () =>
        memoryStoreDocument({
          title: 'doc',
          content: chunkedContent(2),
          namespace: 'shared',
          tags: [],
          source: 'manual',
          idempotency_key: `key-${message}`,
        }, AUTH_A),
      new RegExp(message)
    );
    assert.equal(pool.db.docs.length, 0, message);
    assert.equal(pool.db.memories.length, 0, message);
  }
});

test('zero-row count update fails loudly and rolls back', async () => {
  const pool = new FakePool(new FakeDatabase(), { forceZeroRowUpdate: true });
  setPoolForTesting(pool as unknown as pg.Pool);
  installEmbeddingMock();
  const { memoryStoreDocument } = await loadStoreDocument();

  await assert.rejects(
    () =>
      memoryStoreDocument({
        title: 'doc',
        content: chunkedContent(2),
        namespace: 'shared',
        tags: [],
        source: 'manual',
        idempotency_key: 'zero-row',
      }, AUTH_A),
    /document chunk count update failed/i
  );
  assert.equal(pool.db.docs.length, 0);
  assert.equal(pool.db.memories.length, 0);
});

test('document writes carry owner/idempotency columns and use one scoped client', async () => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  installEmbeddingMock();
  const { memoryStoreDocument } = await loadStoreDocument();

  await memoryStoreDocument({
    title: 'doc',
    content: chunkedContent(2),
    namespace: 'shared',
    tags: [],
    source: 'manual',
    idempotency_key: 'shape',
  }, AUTH_A);

  assert.equal(pool.queryCalls, 0);
  const writeClients = pool.clients.filter((client) =>
    client.calls.some((call) => /INSERT INTO documents/i.test(call.text))
  );
  assert.equal(writeClients.length, 1);
  const sql = writeClients[0].calls.map((call) => call.text).join('\n');
  assert.match(sql, /INSERT INTO documents[\s\S]+client_id[\s\S]+idempotency_key[\s\S]+request_hash/i);
  assert.match(sql, /ON CONFLICT\s*\(client_id, namespace, idempotency_key\)[\s\S]+DO NOTHING/i);
  assert.match(sql, /UPDATE documents SET chunk_count = \$1 WHERE id = \$2 AND client_id = \$3::uuid AND namespace = \$4/i);
});

test('migration 017 adds nullable document idempotency columns without a blocking index build', () => {
  const url = new URL('../migrations/017_document_idempotency.sql', import.meta.url);
  assert.equal(existsSync(url), true);
  const migration = readFileSync(url, 'utf8');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES api_keys\(id\)/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS idempotency_key TEXT/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS request_hash TEXT/i);
  assert.match(migration, /request_hash.*\^sha256:v1:\[0-9a-f\]\{64\}/is);
  assert.doesNotMatch(migration, /NOT VALID/i);
  assert.doesNotMatch(migration, /VALIDATE CONSTRAINT documents_request_hash_format_chk/i);
  assert.doesNotMatch(migration, /CREATE\s+(?:UNIQUE\s+)?INDEX/i);
  assert.doesNotMatch(migration, /CONCURRENTLY/i);
});
