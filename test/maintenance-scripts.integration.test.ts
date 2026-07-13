import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { updateDecayWithClient } from '../scripts/decay-update.js';
import { validateMaintenanceEmbeddingProfile } from '../scripts/lib/maintenance-embedding.js';
import { reembedWithClient } from '../scripts/reembed-all.js';

test('decay reports actual returned totals for personal, media, and future namespaces', async () => {
  const client = { async query(sql: string) {
    assert.doesNotMatch(sql, /allowed_namespaces|namespace\s*=\s*ANY/i);
    return { rows: [
      { maintenance_ready: true, namespace: 'personal', relevance_score: 1 },
      { maintenance_ready: true, namespace: 'media', relevance_score: 0.9 },
      { maintenance_ready: true, namespace: 'future', relevance_score: 0.8 },
    ] };
  } };
  const summary = await updateDecayWithClient(client as never);
  assert.deepEqual(summary.byNamespace, { future: 1, media: 1, personal: 1 });
  assert.equal(summary.count, 3);
});

test('reembed processes every selected namespace and reports concurrent insert drift', async () => {
  const updates: string[] = [];
  let inventoryCalls = 0;
  let selectCalls = 0;
  const client = { async query(sql: string, values?: unknown[]) {
    if (/SELECT id, content, namespace/i.test(sql)) return { rows: selectCalls++ === 0 ? [
      { id: 'p', content: 'personal secret', namespace: 'personal', updated_at: '2026-01-01 00:00:00.000001+00' },
      { id: 'm', content: 'media secret', namespace: 'media', updated_at: '2026-01-01 00:00:00.000002+00' },
      { id: 'f', content: 'future secret', namespace: 'future', updated_at: '2026-01-01 00:00:00.000003+00' },
    ] : [] };
    if (/UPDATE public\.memories/i.test(sql)) { updates.push(String(values?.[4])); return { rows: [], rowCount: 1 }; }
    if (/COUNT\(\*\) FILTER/i.test(sql)) return { rows: [{ unknown_count: '0', legacy_count: '0' }] };
    if (/GROUP BY namespace/i.test(sql)) {
      inventoryCalls++;
      return { rows: inventoryCalls === 1
        ? [{ namespace: 'personal', count: '1' }, { namespace: 'media', count: '1' }, { namespace: 'future', count: '1' }]
        : [{ namespace: 'personal', count: '2' }, { namespace: 'media', count: '1' }, { namespace: 'future', count: '1' }] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [] };
    throw new Error(`unexpected SQL category`);
  } };
  const result = await reembedWithClient(client as never, async texts => texts.map(() => [0.1, 0.2]), { batchSize: 10, delayMs: 0, dimensions: 2 });
  assert.deepEqual(updates, ['p', 'm', 'f']);
  assert.deepEqual(result.succeededByNamespace, { future: 1, media: 1, personal: 1 });
  assert.equal(result.concurrentInventoryDelta, 1);
});

test('reembed emits durable batch progress for long-running full-store operations', async () => {
  const progress: Array<{ processed: number; selected: number; succeeded: number; failed: number }> = [];
  let selectCalls = 0;
  const batches = [
    [
      { id: 'a', content: 'first', namespace: 'personal', updated_at: '2026-01-01 00:00:00.000001+00' },
      { id: 'b', content: 'second', namespace: 'media', updated_at: '2026-01-01 00:00:00.000002+00' },
    ],
    [{ id: 'c', content: 'third', namespace: 'future', updated_at: '2026-01-01 00:00:00.000003+00' }],
    [],
  ];
  const client = { async query(sql: string) {
    if (/SELECT id, content, namespace/i.test(sql)) return { rows: batches[selectCalls++] };
    if (/UPDATE public\.memories/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/COUNT\(\*\) FILTER/i.test(sql)) return { rows: [{ unknown_count: '0', legacy_count: '0' }] };
    if (/GROUP BY namespace/i.test(sql)) return { rows: [
      { namespace: 'future', count: '1' },
      { namespace: 'media', count: '1' },
      { namespace: 'personal', count: '1' },
    ] };
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [] };
    throw new Error('unexpected SQL');
  } };

  await reembedWithClient(client as never, async texts => texts.map(() => [0.1, 0.2]), {
    batchSize: 2,
    delayMs: 0,
    dimensions: 2,
    onProgress: checkpoint => progress.push(checkpoint),
  });

  assert.deepEqual(progress, [
    { processed: 2, selected: 2, succeeded: 2, failed: 0 },
    { processed: 3, selected: 3, succeeded: 3, failed: 0 },
  ]);
});

test('provider mismatch falls back safely, counts each selected row once, and sanitizes errors', async () => {
  const updates: string[] = [];
  let selectCalls = 0;
  const client = { async query(sql: string, values?: unknown[]) {
    if (/SELECT id, content, namespace/i.test(sql)) return { rows: selectCalls++ === 0 ? [
      { id: 'a', content: 'TOP SECRET A', namespace: 'media', updated_at: '2026-01-01 00:00:00.000001+00' },
      { id: 'b', content: 'TOP SECRET B', namespace: 'future', updated_at: '2026-01-01 00:00:00.000002+00' },
    ] : [] };
    if (/UPDATE public\.memories/i.test(sql)) { updates.push(String(values?.[4])); return { rows: [], rowCount: 1 }; }
    if (/COUNT\(\*\) FILTER/i.test(sql)) return { rows: [{ unknown_count: '1', legacy_count: '0' }] };
    if (/GROUP BY namespace/i.test(sql)) return { rows: [{ namespace: 'media', count: '1' }, { namespace: 'future', count: '1' }] };
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [] };
    throw new Error('unexpected SQL');
  } };
  const embed = async (texts: string[]) => {
    if (texts.length > 1) return [[0.1, 0.2]];
    if (texts[0].includes('B')) throw new Error(`provider echoed ${texts[0]}`);
    return [[0.1, 0.2]];
  };
  const result = await reembedWithClient(client as never, embed, { batchSize: 10, delayMs: 0, dimensions: 2 });
  assert.deepEqual(updates, ['a']);
  assert.equal(result.succeeded + result.failed, 2);
  assert.equal(result.failed, 1);
  assert.ok(result.errors.every(error => !JSON.stringify(error).includes('TOP SECRET')));
});

test('live embedding import preserves process environment precedence over dotenv', async () => {
  const source = await readFile(new URL('../src/embedding.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /dotenv\.config\(\s*\{\s*override:\s*true\s*\}\s*\)/);
  assert.match(source, /dotenv\.config\(\s*\)/);
});

test('maintenance validates the canonical Gemini 768 profile without mutating environment', () => {
  const valid = {
    EMBEDDING_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'configured-key',
    EMBEDDING_MODEL: 'gemini-embedding-2-preview',
    EMBEDDING_DIMENSIONS: '768',
  };
  assert.deepEqual(validateMaintenanceEmbeddingProfile(valid), {
    provider: 'gemini',
    apiKey: 'configured-key',
    model: 'gemini-embedding-2-preview',
    dimensions: 768,
  });
  assert.deepEqual(valid, {
    EMBEDDING_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'configured-key',
    EMBEDDING_MODEL: 'gemini-embedding-2-preview',
    EMBEDDING_DIMENSIONS: '768',
  });
  assert.throws(() => validateMaintenanceEmbeddingProfile({
    EMBEDDING_PROVIDER: 'gemini',
    EMBEDDING_MODEL: 'gemini-embedding-2-preview',
    EMBEDDING_DIMENSIONS: '768',
  }), /Gemini.*GEMINI_API_KEY/i);
  assert.throws(() => validateMaintenanceEmbeddingProfile({
    ...valid,
    EMBEDDING_MODEL: 'text-embedding-004',
  }), /gemini-embedding-2-preview/i);
  assert.throws(() => validateMaintenanceEmbeddingProfile({
    ...valid,
    EMBEDDING_DIMENSIONS: '1536',
  }), /768/i);
});

test('reembed uses the validated maintenance embedding client rather than the live dotenv bootstrap', async () => {
  const source = await readFile(new URL('../scripts/reembed-all.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]\.\.\/src\/embedding\.js['"]/);
  assert.match(source, /validateMaintenanceEmbeddingProfile/);
});

test('runbook supersedes unsafe full-store retries with identity-aware scoped repair', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /npm run reembed/i);
  assert.match(readme, /identity-aware readers/i);
  assert.match(readme, /unknown_count[^.]*legacy_count/i);
});
