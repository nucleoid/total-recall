import test from 'node:test';
import assert from 'node:assert/strict';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import { CURRENT_PARENT_ELIGIBILITY } from '../src/shadow-embedding-store.js';
import { validateOperationalManifest } from '../src/shadow-embedding-control.js';
import { parseShadowEmbeddingArguments, runWorkerCommand } from '../scripts/shadow-embeddings.js';
import { createHash } from 'node:crypto';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const manifest = () => ({ version: 1 as const,
  approval: { reference: 'ops/change-2026-10-20.json', sha256: 'a'.repeat(64), approvedBy: 'operator@example.test', approvedAt: '2026-10-20T00:00:00Z' },
  source: { releaseSha: 'b'.repeat(40) },
  eligibility: { predicate: CURRENT_PARENT_ELIGIBILITY, namespaces: 'all' as const, includeNullVectors: true as const, activeSubscriptions: true as const },
  resources: { maxParentsPerBatch: 20, maxSourceBytesPerBatch: 1_000_000, maxTokensPerBatch: 100_000, maxElapsedMsPerBatch: 60_000, maxAttempts: 3,
    host: { deploymentProfile: 'linux-worker' as const, expectedHostname: 'synthetic-worker', diskPath: '/srv/total-recall',
      minAvailableMemoryBytes: 4_294_967_296, minAvailableDiskBytes: 107_374_182_400, maxLoadPerCpu: 1,
      maxSwapUsedBytes: 134_217_728, maxMemoryPsiAvg10: 1, maxCpuPsiAvg10: 5 },
    indexBuild: { maintenanceWorkMemMb: 512, maxParallelMaintenanceWorkers: 2, lockTimeoutMs: 2_000, statementTimeoutMs: 600_000 } },
  runtime: { acceptanceReceiptSha256: 'c'.repeat(64), artifactSha256: QWEN_CHUNK_CONTRACT.artifactSha256,
    runtimeContract: QWEN_CHUNK_CONTRACT.runtimeContract, expectedRuntimeHost: 'gpu-1', expectedRuntimeMode: 'gpu' as const } });

test('operational manifest pins approval, release, eligibility, resources and runtime', () => {
  const value = manifest();
  assert.equal(validateOperationalManifest(value, hash(value)).manifest, value);
  assert.throws(() => validateOperationalManifest({ ...value, eligibility: { ...value.eligibility, namespaces: 'personal' } }, hash(value)), /eligibility_contract/);
  assert.throws(() => validateOperationalManifest(value, '0'.repeat(64)), /manifest_hash_mismatch/);
  assert.throws(() => validateOperationalManifest({ ...value, approval: { ...value.approval, reference: '' } }, hash(value)), /approval_manifest/);
  const extra = { ...value, runtime: { ...value.runtime, unreviewed: true } };
  assert.throws(() => validateOperationalManifest(extra, hash(extra)), /operational_manifest/);
  const tls={...value,runtime:{...value.runtime,tls:{caSha256:'d'.repeat(64),spkiSha256:'e'.repeat(64)}}};
  assert.equal(validateOperationalManifest(tls,hash(tls)).manifest.runtime.tls?.spkiSha256,'e'.repeat(64));
  const badTls={...value,runtime:{...value.runtime,tls:{caSha256:'not-a-hash',spkiSha256:'e'.repeat(64)}}};
  assert.throws(()=>validateOperationalManifest(badTls,hash(badTls)),/runtime_contract/);
});

test('mutation CLI requires apply, expected database and a concrete manifest identity', () => {
  assert.throws(() => parseShadowEmbeddingArguments(['prepare', '--database', 'test']), /apply_required/);
  assert.throws(() => parseShadowEmbeddingArguments(['prepare', '--database', 'test', '--apply']), /approved_manifest_required/);
  assert.throws(() => parseShadowEmbeddingArguments(['prepare', '--apply', '--manifest', 'm.json', '--manifest-sha256', 'a'.repeat(64)]), /expected_database_required/);
  const parsed = parseShadowEmbeddingArguments(['inventory-page', '--database', 'test', '--run-id', '00000000-0000-4000-8000-000000000001', '--apply', '--manifest', 'm.json', '--manifest-sha256', 'a'.repeat(64), '--limit', '25']);
  assert.equal(parsed.limit, 25); assert.equal(parsed.command, 'inventory-page');
});

test('read-only status needs no apply and worker requires explicit mutation authority', () => {
  assert.equal(parseShadowEmbeddingArguments(['status', '--database', 'test']).apply, false);
  assert.throws(() => parseShadowEmbeddingArguments(['worker', '--database', 'test']), /apply_required/);
  assert.equal(parseShadowEmbeddingArguments(['worker', '--database', 'test', '--run-id', '00000000-0000-4000-8000-000000000001',
    '--apply', '--manifest', 'm', '--manifest-sha256', 'a'.repeat(64)]).command, 'worker');
  assert.throws(() => parseShadowEmbeddingArguments(['worker', '--database', 'test', '--run-id', '00000000-0000-4000-8000-000000000001',
    '--apply', '--manifest', 'm', '--manifest-sha256', 'a'.repeat(64), '--limit', '1']), /manifest_limits_only/);
  assert.throws(() => parseShadowEmbeddingArguments(['requeue', '--database', 'test', '--run-id', 'x', '--apply', '--manifest', 'm', '--manifest-sha256', 'a'.repeat(64)]), /requeue_ids/);
});

test('worker runtime receipt must equal the approved manifest receipt', async () => {
  const value = manifest();
  const envelope = validateOperationalManifest(value, hash(value));
  const previous = {
    url: process.env.SHADOW_EMBEDDING_URL, key: process.env.SHADOW_EMBEDDING_API_KEY,
    runtime: process.env.SHADOW_EMBEDDING_RUNTIME_JSON,
  };
  process.env.SHADOW_EMBEDDING_URL = 'http://localhost:1234';
  process.env.SHADOW_EMBEDDING_API_KEY = 'synthetic';
  process.env.SHADOW_EMBEDDING_RUNTIME_JSON = JSON.stringify({ contractId: QWEN_CONTRACT_ID,
    artifactSha256: QWEN_CHUNK_CONTRACT.artifactSha256, runtimeContract: QWEN_CHUNK_CONTRACT.runtimeContract,
    acceptanceReceiptSha256: 'd'.repeat(64) });
  const pool = { query: async () => ({ rows: [{ status: 'running', release_sha: value.source.releaseSha,
    manifest: value, database: 'test', operator: true }] }) };
  try {
    await assert.rejects(runWorkerCommand(pool as never, { command: 'worker', database: 'test', apply: true,
      runId: '00000000-0000-4000-8000-000000000001', manifestPath: 'unused', manifestSha256: hash(value),
      limit: 500, cursor: null, parentIds: [] }, envelope), /runtime_acceptance_receipt/);
  } finally {
    if (previous.url === undefined) delete process.env.SHADOW_EMBEDDING_URL; else process.env.SHADOW_EMBEDDING_URL = previous.url;
    if (previous.key === undefined) delete process.env.SHADOW_EMBEDDING_API_KEY; else process.env.SHADOW_EMBEDDING_API_KEY = previous.key;
    if (previous.runtime === undefined) delete process.env.SHADOW_EMBEDDING_RUNTIME_JSON; else process.env.SHADOW_EMBEDDING_RUNTIME_JSON = previous.runtime;
  }
});

test('version 2 manifest pins OpenRouter model, endpoint, provider and concurrency', () => {
  const base = manifest();
  const value = {
    ...base,
    version: 2 as const,
    backfill: {
      provider: 'openrouter' as const,
      model: QWEN_CHUNK_CONTRACT.hostedModel,
      providerName: QWEN_CHUNK_CONTRACT.hostedProvider,
      endpoint: 'https://openrouter.ai/api/v1/embeddings',
      maxConcurrency: 1,
    },
  };
  assert.equal(validateOperationalManifest(value, hash(value)).manifest.backfill?.provider, 'openrouter');
  for (const backfill of [
    { ...value.backfill, model: 'qwen/qwen3-embedding-8b' },
    { ...value.backfill, providerName: 'AnyProvider' },
    { ...value.backfill, endpoint: 'https://example.com/embeddings' },
    { ...value.backfill, maxConcurrency: 2 },
  ]) {
    const invalid = { ...value, backfill };
    assert.throws(() => validateOperationalManifest(invalid, hash(invalid)), /backfill_contract/);
  }
  const missing = { ...base, version: 2 as const };
  assert.throws(() => validateOperationalManifest(missing, hash(missing)), /operational_manifest/);
});
