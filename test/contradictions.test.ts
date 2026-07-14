import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  classifyContradiction,
  contradictionPolicyFromEnv,
  contradictionRuntimeSnapshot,
  maybeReviseBelief,
  policyAllowsScope,
  resetContradictionRuntimeForTesting,
  scheduleShadowClassification,
  shutdownContradictionRuntime,
  type ContradictionCandidate,
  type ContradictionReason,
  type SemanticMemoryInsert,
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
    CONTRADICTION_ESTIMATED_REQUEST_COST_USD: '0.001',
    CONTRADICTION_ESTIMATED_INPUT_COST_USD_PER_MILLION_BYTES: '1',
    CONTRADICTION_ESTIMATED_OUTPUT_COST_USD_PER_MILLION_BYTES: '4',
  };
}

test.afterEach(async () => resetContradictionRuntimeForTesting());

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

test('conservative process-lifetime budget reserves before egress and fails closed on exhaustion', async () => {
  const policy = contradictionPolicyFromEnv({
    ...approvedEnv(),
    CONTRADICTION_COST_BUDGET_USD: '0.012',
    CONTRADICTION_ESTIMATED_REQUEST_COST_USD: '0.005',
    CONTRADICTION_ESTIMATED_INPUT_COST_USD_PER_MILLION_BYTES: '0',
    CONTRADICTION_ESTIMATED_OUTPUT_COST_USD_PER_MILLION_BYTES: '0',
  });
  assert.equal(policy.classificationEnabled, true);

  const memory: SemanticMemoryInsert = {
    content: 'new private fact',
    vector: '[0.1]',
    source: 'test',
    namespace: 'work',
    tags: [],
    metadata: {},
    accessLevel: 'normal',
    clientId: ID,
    agentId: ID,
    sessionId: null,
  };
  let providerCalls = 0;
  const reasons: ContradictionReason[] = [];
  const noMatchProvider: GenerationProvider = {
    name: 'test',
    async generate() {
      providerCalls += 1;
      return JSON.stringify({ classification: 'no_match', confidence: 1, candidate_id: null });
    },
  };
  const options = {
    policy,
    provider: noMatchProvider,
    findCandidates: async () => candidates,
    metric: (reason: ContradictionReason) => reasons.push(reason),
  };

  await maybeReviseBelief(memory, {} as never, options);
  await maybeReviseBelief(memory, {} as never, options);
  await maybeReviseBelief(memory, {} as never, options);

  assert.equal(providerCalls, 2);
  assert.deepEqual(reasons, ['no_match', 'no_match', 'budget_exhausted']);
  assert.deepEqual(contradictionRuntimeSnapshot(policy)?.budget, {
    limitMicroUsd: 12_000n,
    reservedMicroUsd: 10_000n,
  });

  await resetContradictionRuntimeForTesting();
  assert.deepEqual(contradictionRuntimeSnapshot(policy)?.budget, {
    limitMicroUsd: 12_000n,
    reservedMicroUsd: 0n,
  });
});

test('runtime rejects in-process budget or scheduler configuration drift instead of partitioning limits', async () => {
  const original = contradictionPolicyFromEnv(approvedEnv());
  const changed = contradictionPolicyFromEnv({
    ...approvedEnv(),
    CONTRADICTION_COST_BUDGET_USD: '6',
    CONTRADICTION_SHADOW_MAX_IN_FLIGHT: '3',
  });
  assert.ok(contradictionRuntimeSnapshot(original));
  const reasons: ContradictionReason[] = [];
  let providerCalls = 0;
  await maybeReviseBelief({
    content: 'configuration drift', vector: '[0.1]', source: 'test', namespace: 'work',
    tags: [], metadata: {}, accessLevel: 'normal', clientId: ID, agentId: ID, sessionId: null,
  }, {} as never, {
    policy: changed,
    provider: { name: 'test', async generate() { providerCalls += 1; return '{}'; } },
    findCandidates: async () => candidates,
    metric: reason => reasons.push(reason),
  });
  assert.equal(providerCalls, 0);
  assert.deepEqual(reasons, ['runtime_config_changed']);
  assert.equal(contradictionRuntimeSnapshot(changed), null);
});

test('shutdown blocks new egress and drains a synchronous classification already in candidate lookup', async () => {
  const policy = contradictionPolicyFromEnv(approvedEnv());
  let releaseCandidates!: () => void;
  let candidateLookupStarted!: () => void;
  const started = new Promise<void>(resolve => { candidateLookupStarted = resolve; });
  const blocked = new Promise<void>(resolve => { releaseCandidates = resolve; });
  let providerCalls = 0;
  const reasons: ContradictionReason[] = [];
  const classification = maybeReviseBelief({
    content: 'shutdown race', vector: '[0.1]', source: 'test', namespace: 'work',
    tags: [], metadata: {}, accessLevel: 'normal', clientId: ID, agentId: ID, sessionId: null,
  }, {} as never, {
    policy,
    provider: { name: 'test', async generate() { providerCalls += 1; return '{}'; } },
    findCandidates: async () => {
      candidateLookupStarted();
      await blocked;
      return candidates;
    },
    metric: reason => reasons.push(reason),
  });
  await started;
  let shutdownFinished = false;
  const shutdown = shutdownContradictionRuntime().then(() => { shutdownFinished = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(shutdownFinished, false);
  releaseCandidates();
  await Promise.all([classification, shutdown]);
  assert.equal(providerCalls, 0);
  assert.deepEqual(reasons, ['shadow_shutdown']);
});

test('shadow burst has bounded in-flight and queued work with content-free saturation metrics', async () => {
  const policy = contradictionPolicyFromEnv({
    ...approvedEnv(),
    CONTRADICTION_SHADOW_MAX_IN_FLIGHT: '2',
    CONTRADICTION_SHADOW_MAX_QUEUED: '1',
  });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let active = 0;
  let maximum = 0;
  let completed = 0;
  const reasons: ContradictionReason[] = [];
  const task = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await blocked;
    active -= 1;
    completed += 1;
  };

  const accepted = Array.from({ length: 6 }, () =>
    scheduleShadowClassification(policy, task, reason => reasons.push(reason)));
  assert.deepEqual(accepted, [true, true, true, false, false, false]);
  assert.deepEqual(contradictionRuntimeSnapshot(policy)?.shadows, {
    active: 2,
    queued: 1,
    accepting: true,
  });
  await waitFor(() => active === 2);
  release();
  await waitFor(() => completed === 3);
  assert.equal(maximum, 2);
  assert.deepEqual(reasons, ['shadow_saturated', 'shadow_saturated', 'shadow_saturated']);

  await shutdownContradictionRuntime();
  assert.equal(scheduleShadowClassification(policy, task, reason => reasons.push(reason)), false);
  assert.equal(reasons.at(-1), 'shadow_shutdown');
});

test('provider failures and runtime metrics never log prompts, candidates, keys, or error details', async () => {
  const secret = 'DO-NOT-LOG-secret-value';
  const policy = contradictionPolicyFromEnv({
    ...approvedEnv(),
    CONTRADICTION_GENERATION_API_KEY: secret,
  });
  const memory: SemanticMemoryInsert = {
    content: secret,
    vector: '[0.1]',
    source: 'test',
    namespace: 'work',
    tags: [],
    metadata: { secret },
    accessLevel: 'normal',
    clientId: ID,
    agentId: ID,
    sessionId: null,
  };
  const originalWarn = console.warn;
  const logs: string[] = [];
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    await maybeReviseBelief(memory, {} as never, {
      policy,
      provider: { name: 'test', async generate() { throw new Error(secret); } },
      findCandidates: async () => [{ ...candidates[0], content: secret }],
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(logs, ['[contradictions] outcome=provider_error']);
  assert.doesNotMatch(logs.join('\n'), new RegExp(secret));
  assert.doesNotMatch(logs.join('\n'), new RegExp(ID));
});

test('budget model is explicit and missing estimates keep classification disabled', () => {
  const missingModel = approvedEnv();
  delete missingModel.CONTRADICTION_ESTIMATED_REQUEST_COST_USD;
  assert.equal(contradictionPolicyFromEnv(missingModel).reason, 'budget_model_missing');
  assert.equal(contradictionPolicyFromEnv({
    ...approvedEnv(),
    CONTRADICTION_COST_BUDGET_USD: 'not-money',
  }).reason, 'budget_approval_missing');
});

test('valid_at is a strict offset-aware instant and migration preserves staged backfill', () => {
  assert.equal(searchSchema.parse({ query: 'x', valid_at: '2026-03-01T00:00:00Z' }).valid_at, '2026-03-01T00:00:00Z');
  assert.throws(() => searchSchema.parse({ query: 'x', valid_at: '2026-03-01' }));
  assert.throws(() => searchSchema.parse({ query: 'x', valid_at: '2026-03-01T00:00:00' }));

  const migration = readFileSync(new URL('../migrations/026_memory_kind_and_validity.sql', import.meta.url), 'utf8');
  const backfill = readFileSync(new URL('../scripts/backfill-memory-validity.ts', import.meta.url), 'utf8');
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
  assert.match(backfill, /predecessor\.superseded_at AS predecessor_boundary/);
  assert.match(backfill, /m\.valid_from IS DISTINCT FROM predecessor\.superseded_at/);
  assert.match(finalizer, /nonContiguousLinks/);
});

test('operator rollout contract covers concurrent finalization, gates, budget semantics, and rollback', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const runbook = readFileSync(new URL('../docs/contradiction-rollout-runbook.md', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(readme, /migration 026[\s\S]*CREATE UNIQUE INDEX CONCURRENTLY/i);
  assert.match(readme, /SUPERSEDED_SEARCH_DEMOTION_ENABLED=true[\s\S]*restrictive default is false/i);
  assert.match(readme, /Idempotent stores never query candidates or call the generation gateway/i);
  assert.match(readme, /64 KiB total input[\s\S]*1 KiB classifier output/i);
  assert.match(readme, /process-lifetime reservation budget[^\n]*not exact provider billing/i);
  assert.match(readme, /integer micro-USD[\s\S]*never refunded[\s\S]*resets on process restart/i);
  assert.match(readme, /CONTRADICTION_SHADOW_MAX_IN_FLIGHT[\s\S]*CONTRADICTION_SHADOW_MAX_QUEUED/i);
  assert.match(runbook, /not a durable billing ledger or a cross-replica\/cross-restart ceiling/i);
  assert.ok(server.indexOf('await shutdownContradictionRuntime()') < server.indexOf('for (const [sid, record] of sessions)'),
    'shutdown gates contradiction egress before waiting for MCP sessions');
  assert.match(server, /httpServer\.close\(\);\s*await closeAllSessions\(\)/);
  assert.match(readme, /Rollback order is strict:[\s\S]*disable automatic mutation[\s\S]*disable classification[\s\S]*disable superseded-row demotion/i);
});

test('supersession successor IDs retain access-level privacy gates', () => {
  for (const file of ['../src/search.ts', '../src/tools/list.ts', '../src/tools/recall.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /successor\.access_level/);
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous test state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('superseded-row search demotion has a restrictive reversible gate', () => {
  assert.equal(supersededSearchDemotionEnabledFromEnv({}), false);
  assert.equal(supersededSearchDemotionEnabledFromEnv({ SUPERSEDED_SEARCH_DEMOTION_ENABLED: 'false' }), false);
  assert.equal(supersededSearchDemotionEnabledFromEnv({ SUPERSEDED_SEARCH_DEMOTION_ENABLED: 'TRUE' }), false);
  assert.equal(supersededSearchDemotionEnabledFromEnv({ SUPERSEDED_SEARCH_DEMOTION_ENABLED: 'true' }), true);
});
