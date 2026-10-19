import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import type { LocalEmbeddingClient } from '../src/local-embedding-client.js';
import { QWEN_CONTRACT_ID, QWEN_QUERY_PREFIX } from '../src/local-embedding-contract.js';
import { setPoolForTesting, type DbScope } from '../src/db.js';
import { setLocalServingClientForTesting } from '../src/local-embedding-runtime.js';

type Call = { text: string; values?: unknown[] };
class Client {
  calls: Call[] = [];
  servingContract = QWEN_CONTRACT_ID;
  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>> {
    this.calls.push({ text, values });
    if (text.includes('FROM pg_attribute')) return result([{
      belief_schema: true, supersession_schema: true, revision_schema: true,
      validity_finalized: true, consolidation_schema: true,
    } as unknown as T]);
    if (text.includes('FROM embedding_serving_settings')) {
      return result(this.servingContract ? [{ contract_id: this.servingContract } as unknown as T] : []);
    }
    if (text.includes('AS incomplete')) return result([{ incomplete: false } as unknown as T]);
    return result([]);
  }
  release(): void {}
}
class Pool { constructor(private client: Client) {} async connect() { return this.client; } }
function result<T extends pg.QueryResultRow>(rows: T[]): pg.QueryResult<T> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
}
const scope: DbScope = { namespaces: ['shared'], keyId: 'key', isAdmin: false };

test('Qwen query serving uses the exact role input and scoped current chunk SQL without provider fallback', async () => {
  process.env.NODE_ENV = 'test';
  process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = QWEN_CONTRACT_ID;
  const calls: Array<{ texts: string[]; role: string }> = [];
  let settingsChecksAtInference = -1;
  let activeClient: Client | undefined;
  setLocalServingClientForTesting({
    embed: async (texts: string[], role: string) => {
      settingsChecksAtInference = activeClient?.calls.filter(call => call.text.includes('FROM embedding_serving_settings')).length ?? -1;
      calls.push({ texts, role });
      return { vectors: [Array(768).fill(1 / Math.sqrt(768))], tokens: [QWEN_QUERY_PREFIX.length + texts[0].length] };
    },
  } as unknown as LocalEmbeddingClient);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('provider call forbidden'); };
  try {
    const client = new Client();
    activeClient = client;
    setPoolForTesting(new Pool(client) as unknown as pg.Pool);
    const { hybridSearch } = await import(`../src/search.js?local=${Date.now()}`);
    await hybridSearch({ query: 'needle', tags: ['tag'] }, ['shared'], scope, 'normal');
    assert.deepEqual(calls, [{ texts: ['needle'], role: 'query' }]);
    assert.equal(settingsChecksAtInference, 1, 'preflight transaction releases before inference');
    assert.equal(client.calls.filter(call => call.text.includes('FROM embedding_serving_settings')).length, 2,
      'ranking transaction rechecks serving contract');
    const search = client.calls.find(call => call.text.includes('eligible_local_parents'))!;
    assert.ok(search);
    assert.match(search.text, /mf\.is_current AND mf\.source_revision = m\.revision/);
    assert.match(search.text, /m\.namespace = ANY\(\$\d+\)/);
    assert.match(search.text, /m\.access_level/);
    assert.match(search.text, /m\.deleted_at IS NULL/);
    assert.match(search.text, /m\.superseded_at IS NULL/);
    assert.match(search.text, /m\.consolidated_into_id IS NULL/);
    assert.match(search.text, /GROUP BY candidate\.parent_id/);
    assert.match(search.text, /JOIN eligible_local_parents ep ON ep\.id = c\.parent_id[\s\S]*ORDER BY c\.embedding <=> \$\d+::vector[\s\S]*LIMIT 1000/);
    assert.match(search.text, /LIMIT 10001/);
    assert.equal(search.values?.filter(value => value === QWEN_CONTRACT_ID).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    setLocalServingClientForTesting(undefined);
    delete process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  }
});

test('explicit llama.cpp evaluator vectors use chunk search rather than memories.embedding', async () => {
  delete process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  const client = new Client();
  setPoolForTesting(new Pool(client) as unknown as pg.Pool);
  const { rankMemories } = await import(`../src/search.js?explicit-local=${Date.now()}`);
  await rankMemories({ query: 'needle' }, ['shared'], scope, 'normal', {
    queryVectors: [{
      profile: { name: 'qwen', provider: 'llama.cpp', model: QWEN_CONTRACT_ID, dimensions: 768 },
      vector: Array(768).fill(1 / Math.sqrt(768)),
    }],
  });
  const search = client.calls.find(call => call.text.includes('eligible_local_parents'))!;
  assert.ok(search);
  assert.match(search.text, /FROM memory_embedding_chunks c/);
  assert.doesNotMatch(search.text, /embedding_provider =/);
  assert.equal(client.calls.some(call => call.text.includes('FROM embedding_serving_settings')), false);
});

test('environment and database serving contracts must agree before inference', async () => {
  process.env.NODE_ENV = 'test';
  process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = QWEN_CONTRACT_ID;
  let inference = 0;
  setLocalServingClientForTesting({ embed: async () => { inference++; throw new Error('unreachable'); } } as unknown as LocalEmbeddingClient);
  try {
    const client = new Client();
    client.servingContract = 'different';
    setPoolForTesting(new Pool(client) as unknown as pg.Pool);
    const { hybridSearch } = await import(`../src/search.js?mismatch=${Date.now()}`);
    await assert.rejects(() => hybridSearch({ query: 'needle' }, ['shared'], scope, 'normal'), /serving_contract_mismatch/);
    assert.equal(inference, 0);
  } finally {
    setLocalServingClientForTesting(undefined);
    delete process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  }
});

test('local runtime outage degrades to scoped text-only search without a legacy provider call', async () => {
  process.env.NODE_ENV = 'test';
  process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = QWEN_CONTRACT_ID;
  setLocalServingClientForTesting({ embed: async () => { throw new Error('offline'); } } as unknown as LocalEmbeddingClient);
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { providerCalls++; throw new Error('provider call forbidden'); };
  try {
    const client = new Client();
    setPoolForTesting(new Pool(client) as unknown as pg.Pool);
    const { hybridSearch } = await import(`../src/search.js?outage=${Date.now()}`);
    await hybridSearch({ query: 'needle' }, ['shared'], scope, 'normal');
    const search = client.calls.find(call => call.text.includes('WITH vector_results'))!;
    assert.match(search.text, /FROM memories m WHERE FALSE/);
    assert.doesNotMatch(search.text, /memory_embedding_chunks/);
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    setLocalServingClientForTesting(undefined);
    delete process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  }
});
