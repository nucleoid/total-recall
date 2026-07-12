import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPersistedContent,
  createGeminiSourceKey,
  importGeminiHtml,
  parseGeminiHtml,
  parseGeminiTimestamp,
  type GeminiQueryClient,
} from '../scripts/preseed-gemini.js';

const activity = (prompt: string, timestamp: string, response = 'A sufficiently long response from Gemini that is retained for importing into memory.') => `
<div class="outer-cell"><div class="content-cell mdl-cell--6-col">Prompted ${prompt}<br>${timestamp}<br>${response}</div></div>`;

const expectTime = (input: string, expected: string) => {
  const result = parseGeminiTimestamp(input);
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  if (result.ok) assert.equal(result.iso, expected);
};

test('timestamps are parsed as explicit instants without host-local timezone guesses', () => {
  expectTime('Jan 2, 2024, 12:30:45 AM NZST', '2024-01-01T12:30:45.000Z');
  expectTime('Jan 2, 2024, 12:30:45 PM NZDT', '2024-01-01T23:30:45.000Z');
  expectTime('Feb 29, 2024, 1:02:03 PM UTC', '2024-02-29T13:02:03.000Z');
  expectTime('Feb 29, 2024, 1:02:03 PM Z', '2024-02-29T13:02:03.000Z');
  expectTime('Mar 1, 2024, 1:02:03 AM +05:30', '2024-02-29T19:32:03.000Z');
  expectTime('Mar 1, 2024, 1:02:03 AM GMT-03:30', '2024-03-01T04:32:03.000Z');
  expectTime('Mar 1, 2024, 1:02:03 AM UTC+1245', '2024-02-29T12:17:03.000Z');
});

test('invalid calendars, times, offsets and unknown zones produce diagnostics', () => {
  for (const input of [
    'Feb 29, 2023, 1:00:00 PM UTC',
    'Apr 31, 2024, 1:00:00 PM UTC',
    'Jan 1, 2024, 13:00:00 PM UTC',
    'Jan 1, 2024, 1:60:00 PM UTC',
    'Jan 1, 2024, 1:00:00 PM +14:01',
    'Jan 1, 2024, 1:00:00 PM CST',
    'Mär 1, 2024, 1:00:00 PM UTC',
  ]) {
    const result = parseGeminiTimestamp(input);
    assert.equal(result.ok, false, input);
    if (!result.ok) assert.match(result.reason, /unsupported|invalid/i);
  }
});

test('v2 keys use exact capped persisted content and normalized timestamp', () => {
  const content = buildPersistedContent('p'.repeat(2500), 'r'.repeat(2500));
  assert.equal(content.length, 4000);
  const key = createGeminiSourceKey(content, '2024-01-01T00:00:00.000Z');
  assert.match(key, /^gemini-conv:v2:[a-f0-9]{64}$/);
  assert.equal(key, createGeminiSourceKey(content, '2024-01-01T00:00:00.000Z'));
  assert.notEqual(key, createGeminiSourceKey(content + 'x', '2024-01-01T00:00:00.000Z'));
  assert.notEqual(key, createGeminiSourceKey(content, '2024-01-01T00:00:01.000Z'));
});

test('reorder and prepend preserve keys while exact duplicates converge', () => {
  const a = activity('first', 'Jan 2, 2024, 1:00:00 PM UTC');
  const b = activity('second', 'Jan 3, 2024, 1:00:00 PM NZDT');
  const original = parseGeminiHtml(a + b);
  const changed = parseGeminiHtml(activity('new', 'Jan 1, 2024, 1:00:00 PM Z') + b + a + a);
  assert.deepEqual(original.accepted.map(x => x.sourceKey).sort(), changed.accepted.slice(1, 3).map(x => x.sourceKey).sort());
  assert.equal(changed.accepted[2].sourceKey, changed.accepted[3].sourceKey);
});

test('unsupported timestamps are visible and make partial imports unsuccessful', async () => {
  const parsed = parseGeminiHtml(activity('good', 'Jan 1, 2024, 1:00:00 PM UTC') + activity('bad', 'Jan 1, 2024, 1:00:00 PM CST'));
  assert.equal(parsed.candidates, 2);
  assert.equal(parsed.accepted.length, 1);
  assert.equal(parsed.skipped, 1);
  assert.match(parsed.timestampFailures[0].reason, /unsupported/i);

  const queries: string[] = [];
  const client: GeminiQueryClient = { query: async sql => { queries.push(sql); return {}; } };
  const summary = await importGeminiHtml(activity('bad', 'Jan 1, 2024, 1:00:00 PM CST'), client, async () => { throw new Error('must not embed'); });
  assert.equal(summary.exitCode, 1);
  assert.deepEqual(queries, []);

  const malformed = parseGeminiHtml(activity('bad', 'response-like secret 2024 AM data'));
  assert.equal(malformed.unsupportedTimestamps, 1);
  assert.equal(JSON.stringify(malformed.timestampFailures).includes('response-like secret'), false);
  assert.equal((await importGeminiHtml(activity('bad', 'not a recognizable date at all'), client, async () => { throw new Error('must not embed'); })).exitCode, 1);

  const empty = await importGeminiHtml('<html></html>', client, async () => { throw new Error('must not embed'); });
  assert.equal(empty.exitCode, 0);
});

test('duplicate identities spanning batches are reported once', async () => {
  const duplicate = activity('same', 'Jan 1, 2024, 1:00:00 PM UTC');
  const html = duplicate.repeat(11);
  const client: GeminiQueryClient = { query: async () => ({}) };
  const summary = await importGeminiHtml(html, client, async texts => texts.map(() => Array(768).fill(0.1)));
  assert.equal(summary.imported, 1);
});

test('accepted rows use canonical batching and app-role transaction-local scope', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client: GeminiQueryClient = { query: async (sql, values) => { calls.push({ sql, values }); return {}; } };
  const result = await importGeminiHtml(activity('one', 'Jan 1, 2024, 1:00:00 PM UTC'), client, async texts => texts.map(() => Array(768).fill(0.1)));
  assert.equal(result.exitCode, 0);
  assert.equal(result.imported, 1);
  assert.deepEqual(calls.map(x => x.sql.split(/\s/)[0]), ['BEGIN', 'SELECT', 'INSERT', 'COMMIT']);
  assert.match(calls[1].sql, /app\.current_namespace/);
  assert.match(calls[2].sql, /preseed-gemini/);
  assert.equal((calls[2].values ?? [])[0], buildPersistedContent('one', 'A sufficiently long response from Gemini that is retained for importing into memory.'));
});

test('provider or database failures roll back and reject instead of reporting partial success', async () => {
  const calls: string[] = [];
  const client: GeminiQueryClient = { query: async sql => { calls.push(sql); if (sql.startsWith('INSERT')) throw new Error('db failed'); return {}; } };
  await assert.rejects(importGeminiHtml(activity('one', 'Jan 1, 2024, 1:00:00 PM UTC'), client, async () => [Array(768).fill(0.1)]), /db failed/);
  assert.equal(calls.at(-1), 'ROLLBACK');
});
