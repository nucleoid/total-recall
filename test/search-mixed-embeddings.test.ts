import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import { setPoolForTesting, type DbScope } from '../src/db.js';

class Client {
  calls: Array<{ text: string; values?: unknown[] }> = [];
  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>> {
    this.calls.push({ text, values });
    if (text.includes('FROM pg_attribute') && text.includes('belief_schema')) return result([{
      belief_schema: false, supersession_schema: false, revision_schema: false,
      validity_finalized: false, consolidation_schema: false,
    } as unknown as T]);
    if (text.startsWith('SELECT EXISTS')) return result([{ eligible: true } as unknown as T]);
    if (text.includes('WITH vector_results')) return result([]);
    return result([]);
  }
  release(): void {}
}
class Pool { constructor(private client: Client) {} async connect() { return this.client; } }
function result<T extends pg.QueryResultRow>(rows: T[]): pg.QueryResult<T> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
}

const scope: DbScope = { namespaces: ['shared'], keyId: 'key', isAdmin: false };

test('mixed search calls only eligible configured identities and emits separate vector branches', async () => {
  process.env.EMBEDDING_CURRENT_PROFILE = 'production';
  process.env.EMBEDDING_PROFILES_JSON = JSON.stringify({
    production: { provider: 'gemini', model: 'gemini-embedding-2-preview', dimensions: 768, apiKeyEnv: 'MIXED_GEMINI_KEY' },
    legacy: { provider: 'ollama', model: 'nomic-embed-text', dimensions: 768, baseUrlEnv: 'MIXED_OLLAMA_URL' },
  });
  process.env.MIXED_GEMINI_KEY = 'test-key';
  process.env.MIXED_OLLAMA_URL = 'http://legacy.invalid';
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    requests.push(url);
    const body = url.includes('legacy.invalid')
      ? { embeddings: [Array(768).fill(0.2)] }
      : { embedding: { values: Array(768).fill(0.1) } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const client = new Client();
    setPoolForTesting(new Pool(client) as unknown as pg.Pool);
    const { hybridSearch } = await import(`../src/search.js?mixed=${Date.now()}`);
    await hybridSearch({ query: 'migration query' }, ['shared'], scope, 'normal');
    assert.equal(requests.length, 2);
    assert.ok(requests.some(url => url.includes('gemini-embedding-2-preview')));
    assert.ok(requests.some(url => url.includes('legacy.invalid/api/embed')));
    const eligibility = client.calls.find(call => call.text.startsWith('SELECT EXISTS'))!;
    assert.deepEqual(eligibility.values?.slice(2, 5), ['ollama', 'nomic-embed-text', 768]);
    const search = client.calls.find(call => call.text.includes('WITH vector_results'))!;
    assert.match(search.text, /embedding_provider = \$\d+[\s\S]*embedding_provider = \$\d+/);
    assert.match(search.text, /NOT EXISTS \(SELECT 1 FROM vector_results/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.EMBEDDING_CURRENT_PROFILE;
    delete process.env.EMBEDDING_PROFILES_JSON;
    delete process.env.MIXED_GEMINI_KEY;
    delete process.env.MIXED_OLLAMA_URL;
  }
});
