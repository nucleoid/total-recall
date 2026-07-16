import assert from 'node:assert/strict';
import test from 'node:test';
import { embeddingStatus } from '../scripts/embedding-status.js';
import { labelEmbeddings } from '../scripts/label-embeddings.js';
import { parseReembedArguments } from '../scripts/reembed-all.js';
import type { QueryClient } from '../scripts/lib/maintenance-db.js';

const target = { name: 'production', provider: 'gemini', model: 'gemini-embedding-2-preview', dimensions: 768 };

test('embedding status groups current, legacy, and unknown active rows and gates retirement', async () => {
  const client = {
    async query() {
      return { rows: [
        { namespace: 'shared', embedding_provider: 'gemini', embedding_model: 'gemini-embedding-2-preview', embedding_dimensions: 768, count: '4' },
        { namespace: 'shared', embedding_provider: 'ollama', embedding_model: 'nomic-embed-text', embedding_dimensions: 768, count: '2' },
        { namespace: 'work', embedding_provider: null, embedding_model: null, embedding_dimensions: null, count: '1' },
      ] };
    },
  } as QueryClient;
  const report = await embeddingStatus(client, target, ['shared', 'work']);
  assert.deepEqual({ current: report.current_count, legacy: report.legacy_count, unknown: report.unknown_count }, {
    current: 4, legacy: 2, unknown: 1,
  });
  assert.equal(report.retirement_ready, false);
});

test('embedding labelling requires evidence, scope, dry-run or exact confirmation, and can clear false labels', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return sql.startsWith('SELECT') ? { rows: [{ count: '3' }] } : { rows: [], rowCount: 3 };
    },
  } as QueryClient;
  const legacy = { name: 'legacy', provider: 'ollama', model: 'nomic-embed-text', dimensions: 768 };
  await assert.rejects(() => labelEmbeddings(client, {
    label: legacy, namespaces: ['shared'], dryRun: true, confirmed: false,
  }), /evidence/);
  await assert.rejects(() => labelEmbeddings(client, {
    label: legacy, namespaces: [], whereProvider: undefined, dryRun: true, confirmed: false, evidence: 'inventory-42',
  }), /namespace|filter/);
  assert.equal(await labelEmbeddings(client, {
    label: legacy, namespaces: ['shared'], dryRun: true, confirmed: false, evidence: 'inventory-42',
  }), 3);
  assert.equal(await labelEmbeddings(client, {
    label: 'unknown', namespaces: [], whereProvider: 'ollama', dryRun: false, confirmed: true,
  }), 3);
  assert.match(calls.at(-1)!.sql, /embedding_provider = NULL, embedding_model = NULL, embedding_dimensions = NULL/);
});

test('reembed CLI accepts bounded resumable worker controls', () => {
  assert.deepEqual(parseReembedArguments([
    '--target', 'production', '--batch-size', '25', '--delay-ms', '10', '--namespace', 'work,shared',
    '--namespace', 'work', '--max-errors', '2', '--dry-run',
  ]), {
    target: 'production', batchSize: 25, delayMs: 10, namespaces: ['shared', 'work'], maxErrors: 2, dryRun: true,
  });
  assert.throws(() => parseReembedArguments(['--batch-size', '0']), /integer/);
});
