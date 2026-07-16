import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type pg from 'pg';
import request from 'supertest';
import { setPoolForTesting } from '../src/db.js';
import type { AuthContext } from '../src/types.js';
import {
  memoryStore,
  parseMemoryDedupeThreshold,
  storeSchema,
} from '../src/tools/store.js';

const AUTH: AuthContext = {
  keyId: '11111111-1111-4111-8111-111111111111',
  name: 'test',
  namespaces: ['shared'],
  permissions: ['write'],
  maxAccessLevel: 'secret',
};
const CANDIDATE_ID = '22222222-2222-4222-8222-222222222222';
const INSERTED_ID = '33333333-3333-4333-8333-333333333333';

function result(rows: any[]) {
  return { command: 'MOCK', rowCount: rows.length, oid: 0, fields: [], rows };
}

class DedupePool {
  statements: Array<{ text: string; params: unknown[] }> = [];
  similarity: number | undefined;

  constructor(similarity?: number) {
    this.similarity = similarity;
  }

  async connect() {
    return {
      query: async (text: string, params: unknown[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        this.statements.push({ text: sql, params });
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return result([]);
        if (/SELECT set_config\('app\./i.test(sql)) return result([]);
        if (/INSERT INTO agents/i.test(sql)) return result([{ id: 'agent-1' }]);
        if (/pg_advisory_xact_lock/i.test(sql)) return result([{}]);
        if (/SELECT m\.id, m\.namespace,[\s\S]*AS similarity/i.test(sql)) {
          return result(this.similarity === undefined ? [] : [{
            id: CANDIDATE_ID,
            namespace: 'shared',
            similarity: String(this.similarity),
          }]);
        }
        if (/UPDATE memories SET access_count/i.test(sql)) {
          return result([{ id: CANDIDATE_ID, namespace: 'shared', expires_at: null }]);
        }
        if (/INSERT INTO audit_log/i.test(sql)) return result([]);
        if (/INSERT INTO memories/i.test(sql)) {
          return result([{
            id: INSERTED_ID,
            namespace: String(params[3]),
            expires_at: params[13] == null ? null : new Date('2026-07-16T00:01:00.000Z'),
          }]);
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      release() {},
    };
  }

  async query(): Promise<never> {
    throw new Error('memory_store must use request-scoped clients');
  }
}

function mockEmbedding(t: TestContext): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    embedding: { values: Array(768).fill(0.1) },
  }), { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
}

test('dedupe threshold parser defaults to 0.95 and rejects invalid configuration', () => {
  assert.equal(storeSchema.parse({ content: 'defaults' }).dedupe, true);
  assert.deepEqual(
    { ttl: storeSchema.parse({ content: 'scratch', ttl: 60 }).ttl,
      dedupe: storeSchema.parse({ content: 'scratch', ttl: 60 }).dedupe },
    { ttl: 60, dedupe: false },
  );
  for (const ttl of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => storeSchema.parse({ content: 'scratch', ttl }));
  }
  assert.throws(() => storeSchema.parse({ content: 'scratch', ttl: 60, dedupe: true }), /cannot be combined/);
  assert.equal(parseMemoryDedupeThreshold(undefined), 0.95);
  assert.equal(parseMemoryDedupeThreshold('0'), 0);
  assert.equal(parseMemoryDedupeThreshold('1'), 1);
  for (const value of ['', ' ', 'wat', '-0.01', '1.01', 'Infinity']) {
    assert.throws(() => parseMemoryDedupeThreshold(value), /between 0 and 1/);
  }
});

test('memory_store reuses a candidate at the threshold and boosts only safe mutable fields', async t => {
  mockEmbedding(t);
  const pool = new DedupePool(0.95);
  setPoolForTesting(pool as unknown as pg.Pool);

  const stored = await memoryStore(storeSchema.parse({
    content: 'near duplicate',
    tags: ['new', 'shared'],
    metadata: { must_not_merge: true },
  }), AUTH);

  assert.deepEqual(stored, {
    id: CANDIDATE_ID,
    namespace: 'shared',
    created: false,
    deduplicated: true,
    similarity: 0.95,
    expires_at: null,
  });
  const lock = pool.statements.find(statement => /pg_advisory_xact_lock/i.test(statement.text));
  const candidate = pool.statements.find(statement => /AS similarity/i.test(statement.text));
  const boost = pool.statements.find(statement => /UPDATE memories SET access_count/i.test(statement.text));
  assert.ok(lock && candidate && boost);
  assert.ok(pool.statements.indexOf(lock) < pool.statements.indexOf(candidate));
  assert.ok(pool.statements.indexOf(candidate) < pool.statements.indexOf(boost));
  assert.match(candidate.text, /m\.namespace = \$2[\s\S]*COALESCE\(m\.access_level, 'normal'\) = \$3/);
  assert.match(candidate.text, /embedding_provider = \$4[\s\S]*embedding_model = \$5[\s\S]*embedding_dimensions = \$6/);
  assert.match(candidate.text, /source_key IS NULL[\s\S]*document_id IS NULL[\s\S]*deleted_at IS NULL[\s\S]*expires_at IS NULL/);
  assert.match(candidate.text, /valid_to IS NULL[\s\S]*consolidated_into_id IS NULL/);
  assert.match(candidate.text, /ORDER BY m\.embedding <=> \$1::vector ASC,[\s\S]*calculate_relevance[\s\S]*m\.created_at ASC,[\s\S]*m\.id ASC[\s\S]*FOR UPDATE/);
  assert.match(boost.text, /access_count = COALESCE\(access_count, 0\) \+ 1/);
  assert.match(boost.text, /accessed_at = statement_timestamp\(\)[\s\S]*last_boosted_at = statement_timestamp\(\)/);
  assert.match(boost.text, /COALESCE\(memories\.tags/);
  assert.doesNotMatch(boost.text, /content\s*=|metadata\s*=|source\s*=|client_id\s*=|agent_id\s*=/);
  assert.equal(pool.statements.some(statement => /INSERT INTO memories/i.test(statement.text)), false);
  const audit = pool.statements.find(statement => /INSERT INTO audit_log/i.test(statement.text));
  assert.ok(audit);
  assert.deepEqual(audit.params.slice(0, 4), [AUTH.keyId, 'memory.store', 'shared', CANDIDATE_ID]);
  assert.equal(pool.statements.at(-1)?.text, 'COMMIT');
});

test('below-threshold and opt-out stores insert with the additive result contract', async t => {
  mockEmbedding(t);
  const below = new DedupePool(0.949999);
  setPoolForTesting(below as unknown as pg.Pool);
  assert.deepEqual(
    await memoryStore(storeSchema.parse({ content: 'distinct enough' }), AUTH),
    { id: INSERTED_ID, namespace: 'shared', created: true, deduplicated: false, expires_at: null },
  );

  const bypassed = new DedupePool(1);
  setPoolForTesting(bypassed as unknown as pg.Pool);
  assert.deepEqual(
    await memoryStore(storeSchema.parse({ content: 'intentionally distinct', dedupe: false }), AUTH),
    { id: INSERTED_ID, namespace: 'shared', created: true, deduplicated: false, expires_at: null },
  );
  assert.equal(bypassed.statements.some(statement => /pg_advisory_xact_lock|AS similarity/i.test(statement.text)), false);

  const expiring = new DedupePool(1);
  setPoolForTesting(expiring as unknown as pg.Pool);
  assert.deepEqual(
    await memoryStore(storeSchema.parse({ content: 'temporary state', ttl: 60 }), AUTH),
    {
      id: INSERTED_ID,
      namespace: 'shared',
      created: true,
      deduplicated: false,
      expires_at: new Date('2026-07-16T00:01:00.000Z'),
    },
  );
  assert.equal(expiring.statements.some(statement => /pg_advisory_xact_lock|AS similarity/i.test(statement.text)), false);
  const insert = expiring.statements.find(statement => /INSERT INTO memories/i.test(statement.text));
  assert.ok(insert);
  assert.match(insert.text, /statement_timestamp\(\) \+ \$14::double precision \* interval '1 second'/);
  assert.equal(insert.params[13], 60);
});

test('REST passes through dedupe status, namespace, and similarity', async t => {
  mockEmbedding(t);
  const pool = new DedupePool(0.99);
  setPoolForTesting(pool as unknown as pg.Pool);
  const { createApp, setServerTestOverrides } = await import('../src/server.js');
  setServerTestOverrides({ validateKey: async () => AUTH });
  t.after(() => setServerTestOverrides({}));

  const response = await request(createApp())
    .post('/api/store')
    .set('Authorization', 'Bearer tr_test')
    .send({ content: 'duplicate over REST' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    id: CANDIDATE_ID,
    namespace: 'shared',
    created: false,
    deduplicated: true,
    similarity: 0.99,
    expires_at: null,
  });
});
