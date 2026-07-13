import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runReembedAgainstEnvironment } from '../scripts/reembed-all.js';

test('reembed preserves PostgreSQL microseconds in its optimistic concurrency token', () => {
  const source = readFileSync('scripts/reembed-all.ts', 'utf8');
  assert.match(source, /updated_at::text AS updated_at/u);
  assert.match(source, /updated_at\s*=\s*\$\d+::timestamptz/u);
  assert.doesNotMatch(source, /updated_at:\s*Date/u);
});

test('full repair advances a stable id cursor so each row is selected once per run', () => {
  const source = readFileSync('scripts/reembed-all.ts', 'utf8');
  assert.match(source, /fullRepair/u);
  assert.match(source, /lastId/u);
  assert.match(source, /id\s*>\s*\$\d+/u);
  assert.match(source, /ORDER BY id/u);
});

test('REEMBED_DATABASE_URL still performs the owner-capability preflight before provider work', async () => {
  let providerCalls = 0;
  let ended = 0;
  const client = {
    async connect() {},
    async query(sql: string) {
      if (/current_database/i.test(sql)) return { rows: [{ database: 'selected', user: 'app', server: 'db:5432' }] };
      if (/FROM public\.memories/i.test(sql)) throw new Error('query would be affected by row-level security policy');
      return { rows: [] };
    },
    async end() { ended++; },
  };

  await assert.rejects(
    runReembedAgainstEnvironment(
      { REEMBED_DATABASE_URL: 'postgres://runtime/selected' },
      async () => { providerCalls++; return []; },
      { delayMs: 0 },
      (() => client) as never,
    ),
    /all-row maintenance preflight failed/i,
  );
  assert.equal(providerCalls, 0);
  assert.equal(ended, 1);
});

test('completion verification uses exactly the processing namespace scope', () => {
  const source = readFileSync('scripts/reembed-all.ts', 'utf8');
  const verifyStart = source.indexOf('export async function verifyEmbeddingMigrationComplete');
  assert.notEqual(verifyStart, -1);
  const verifySource = source.slice(verifyStart);
  assert.match(verifySource, /cardinality\(\$1::text\[\]\) = 0 OR namespace = ANY\(\$1\)/u);
  assert.match(verifySource, /namespaces/u);
});
