import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  classifyContradiction,
  contradictionPolicyFromEnv,
  policyAllowsScope,
  type ContradictionCandidate,
} from '../src/contradictions.js';
import { GenerationLimitError, GenerationTimeoutError, generateBounded, type GenerationProvider } from '../src/generation.js';
import { searchSchema } from '../src/tools/search.js';
import { supersededSearchDemotionEnabledFromEnv } from '../src/config.js';

const ID = '11111111-1111-4111-8111-111111111111';
const candidates: ContradictionCandidate[] = [{ id: ID, content: 'The office is in Austin', similarity: 0.9 }];

function provider(output: string): GenerationProvider {
  return { name: 'test', async generate() { return output; } };
}

function approvedEnv(): NodeJS.ProcessEnv {
  return {
    CONTRADICTION_CLASSIFICATION_ENABLED: 'true',
    CONTRADICTION_PROCESSING_APPROVED: 'true',
    CONTRADICTION_PROVIDER: 'reviewed-gateway',
    CONTRADICTION_MODEL: 'reviewed-model',
    CONTRADICTION_GENERATION_ENDPOINT: 'https://generation.example.test/v1',
    CONTRADICTION_PROVIDER_MODEL_APPROVED: 'true',
    CONTRADICTION_PRIVACY_APPROVED: 'true',
    CONTRADICTION_RETENTION_APPROVED: 'true',
    CONTRADICTION_TRAINING_APPROVED: 'true',
    CONTRADICTION_APPROVED_NAMESPACE: 'work',
    CONTRADICTION_SCOPE_APPROVED: 'true',
    CONTRADICTION_COST_BUDGET_USD: '5',
    CONTRADICTION_COST_BUDGET_APPROVED: 'true',
  };
}

test('classification is strict, bounded, and restricted to supplied IDs', async () => {
  const valid = await classifyContradiction(
    'The office moved to Denver', candidates,
    provider(JSON.stringify({ classification: 'contradiction', confidence: 0.95, candidate_id: ID })),
    'test-model', 1000,
  );
  assert.equal(valid.classification, 'contradiction');
  assert.equal(valid.candidate_id, ID);

  await assert.rejects(() => classifyContradiction(
    'x', candidates,
    provider(JSON.stringify({ classification: 'contradiction', confidence: 1, candidate_id: '22222222-2222-4222-8222-222222222222' })),
    'test-model', 1000,
  ), /unknown_candidate_id/);
  await assert.rejects(() => classifyContradiction(
    'x', candidates,
    provider(JSON.stringify({ classification: 'no_match', confidence: 0.5, candidate_id: null, extra: true })),
    'test-model', 1000,
  ), /invalid_classifier_output/);
});

test('generation interface independently enforces input and output byte limits', async () => {
  await assert.rejects(() => generateBounded({
    provider: provider('ok'), system: '123', input: '456', model: 'm',
    timeoutMs: 100, maxInputBytes: 5, maxOutputBytes: 5,
  }), GenerationLimitError);
  await assert.rejects(() => generateBounded({
    provider: provider('123456'), system: '', input: '', model: 'm',
    timeoutMs: 100, maxInputBytes: 5, maxOutputBytes: 5,
  }), GenerationLimitError);
  await assert.rejects(() => generateBounded({
    provider: { name: 'ignores-abort', generate: async () => new Promise<string>(() => {}) },
    system: '', input: '', model: 'm', timeoutMs: 5, maxInputBytes: 5, maxOutputBytes: 5,
  }), GenerationTimeoutError);
});

test('no embedding or borrowed approval implicitly enables #53', () => {
  const borrowed: NodeJS.ProcessEnv = {
    GEMINI_API_KEY: 'embedding-only',
    EMBEDDING_PROVIDER: 'gemini',
    CONTRADICTION_CLASSIFICATION_ENABLED: 'true',
  };
  assert.equal(contradictionPolicyFromEnv(borrowed).classificationEnabled, false);

  const approved = contradictionPolicyFromEnv(approvedEnv());
  assert.equal(approved.classificationEnabled, true);
  assert.equal(approved.mutationEnabled, false);
  assert.equal(policyAllowsScope(approved, 'work', 'normal'), true);
  assert.equal(policyAllowsScope(approved, 'other', 'normal'), false);
  assert.equal(policyAllowsScope(approved, 'work', 'sensitive'), false);

  const mutation = contradictionPolicyFromEnv({
    ...approvedEnv(),
    CONTRADICTION_AUTO_MUTATION_ENABLED: 'true',
    CONTRADICTION_MUTATION_APPROVED: 'true',
    CONTRADICTION_SHADOW_METRICS_REVIEWED: 'true',
    DEPLOYMENT_ENVIRONMENT: 'production',
    CONTRADICTION_MUTATION_ENVIRONMENT: 'production',
  });
  assert.equal(mutation.mutationEnabled, true);
  assert.equal(contradictionPolicyFromEnv({
    ...approvedEnv(),
    CONTRADICTION_AUTO_MUTATION_ENABLED: 'true',
    CONTRADICTION_MUTATION_APPROVED: 'true',
    CONTRADICTION_SHADOW_METRICS_REVIEWED: 'true',
    DEPLOYMENT_ENVIRONMENT: 'staging',
    CONTRADICTION_MUTATION_ENVIRONMENT: 'production',
  }).mutationEnabled, false);
});

test('valid_at is a strict offset-aware instant and migration preserves staged backfill', () => {
  assert.equal(searchSchema.parse({ query: 'x', valid_at: '2026-03-01T00:00:00Z' }).valid_at, '2026-03-01T00:00:00Z');
  assert.throws(() => searchSchema.parse({ query: 'x', valid_at: '2026-03-01' }));
  assert.throws(() => searchSchema.parse({ query: 'x', valid_at: '2026-03-01T00:00:00' }));

  const migration = readFileSync(new URL('../migrations/026_memory_kind_and_validity.sql', import.meta.url), 'utf8');
  const finalizer = readFileSync(new URL('../scripts/finalize-memory-validity.ts', import.meta.url), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ/);
  assert.match(migration, /ALTER COLUMN valid_from SET DEFAULT statement_timestamp\(\)/);
  assert.doesNotMatch(migration, /memories_validity_interval_check/);
  assert.match(finalizer, /memories_validity_interval_check/);
  assert.match(migration, /sync_memory_valid_to_from_supersession/);
  assert.match(migration, /NEW\.valid_to := NEW\.superseded_at/);
  assert.match(migration, /NOT VALID/);
  assert.doesNotMatch(migration, /UPDATE public\.memories/i);
  assert.doesNotMatch(migration, /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX/im);
  assert.doesNotMatch(migration, /memories_valid_from_present/);
  assert.doesNotMatch(migration, /memories_validity_supersession_check/);
});

test('operator rollout contract covers concurrent finalization, gates, egress, and rollback order', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /migration 026[\s\S]*CREATE UNIQUE INDEX CONCURRENTLY/i);
  assert.match(readme, /SUPERSEDED_SEARCH_DEMOTION_ENABLED=true[\s\S]*restrictive default is false/i);
  assert.match(readme, /Idempotent stores never query candidates or call the generation gateway/i);
  assert.match(readme, /64 KiB total input[\s\S]*1 KiB classifier output/i);
  assert.match(readme, /Rollback order is strict:[\s\S]*disable automatic mutation[\s\S]*disable classification[\s\S]*disable superseded-row demotion/i);
});

test('supersession successor IDs retain access-level privacy gates', () => {
  for (const file of ['../src/search.ts', '../src/tools/list.ts', '../src/tools/recall.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /successor\.access_level/);
  }
});

test('superseded-row search demotion has a restrictive reversible gate', () => {
  assert.equal(supersededSearchDemotionEnabledFromEnv({}), false);
  assert.equal(supersededSearchDemotionEnabledFromEnv({ SUPERSEDED_SEARCH_DEMOTION_ENABLED: 'false' }), false);
  assert.equal(supersededSearchDemotionEnabledFromEnv({ SUPERSEDED_SEARCH_DEMOTION_ENABLED: 'TRUE' }), false);
  assert.equal(supersededSearchDemotionEnabledFromEnv({ SUPERSEDED_SEARCH_DEMOTION_ENABLED: 'true' }), true);
});
