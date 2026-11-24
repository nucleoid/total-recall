import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInvocationPlan,
  parseNativeActivationConfig,
  validateNativePolicyForLane,
  validateKnownCliReceipt,
} from '../scripts/native-activation-contract.js';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const POLICY_APPROVAL = { approved: true as const, approvedBy: 'owner', approvedAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-12-31T00:00:00Z' };
function config(feature = 'entity'): any {
  return {
    version: 1, feature, enabled: false, container: 'total-recall-ingestion-1',
    environmentFile: '/etc/total-recall/private/entity.env',
    policyFile: '/app/policies/entity.json', policySha256: 'a'.repeat(64),
    policyEnvironment: 'test',
    adapterProfile: 'openclaw-main-subscription', timeoutSeconds: 120,
    dailyGenerationCallCap: 6,
    approval: { reference: 'owner-approval-12', approvedBy: 'owner',
      approvedAt: '2026-11-24T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z' },
    lanes: [{ namespace: 'shared', accessLevel: 'normal', profile: 'entity-enrichment', mode: 'once' }],
  };
}

test('strict config rejects command injection, unknown profiles, stale approval, and missing private adapter', () => {
  assert.throws(() => parseNativeActivationConfig({ ...config(), container: 'ok;touch /tmp/x' }, NOW), /container/);
  assert.throws(() => parseNativeActivationConfig({ ...config(), adapterProfile: undefined }, NOW), /private_adapter/);
  assert.throws(() => parseNativeActivationConfig({ ...config(), lanes: [{ ...config().lanes[0], profile: 'shell' }] }, NOW), /subprofile/);
  assert.throws(() => parseNativeActivationConfig({ ...config(), approval: { ...config().approval,
    expiresAt: '2026-11-24T11:59:59Z' } }, NOW), /approval_not_current/);
  assert.throws(() => parseNativeActivationConfig({ ...config(), extraCommand: ['sh', '-c', 'id'] }, NOW), /unknown fields/);
});

test('entity recovery is cutoff-bound and commands remain fixed argv with one generated job', () => {
  const parsed = parseNativeActivationConfig({ ...config(), enabled: true,
    entityHistoricalRecovery: { completedBefore: '2026-11-01T00:00:00Z', limit: 7 } }, NOW);
  const plan = buildInvocationPlan(parsed, 0);
  assert.equal(plan.commands.length, 2);
  assert.deepEqual(plan.commands[0].argv, ['/usr/bin/npm', 'run', 'entity:backfill', '--',
    '--namespace', 'shared', '--access-level', 'normal', '--requeue-completed-without-links',
    '--completed-before', '2026-11-01T00:00:00.000Z', '--limit', '7', '--execute']);
  assert.deepEqual(plan.commands[1].argv.slice(-5), ['--once', '--max-jobs', '1', '--poll-ms', '100']);
  assert.equal(plan.sourceGraphCoverage, 'pending');
  assert.throws(() => parseNativeActivationConfig({ ...config(),
    entityHistoricalRecovery: { limit: 1 } }, NOW), /completedBefore/);
});

test('worker profiles enforce one job and one concurrency where supported', () => {
  const raw = config('session');
  raw.lanes = [{ namespace: 'shared', accessLevel: 'normal', profile: 'queued-session', mode: 'once' }];
  const argv = buildInvocationPlan(parseNativeActivationConfig(raw, NOW), 0).commands[0].argv;
  assert.equal(argv[2], 'session:distill');
  assert.ok(argv.includes('--max-jobs') && argv.includes('1'));
});

test('contradiction shadow cannot launch a competing ingestion worker', () => {
  const raw = config('contradiction-shadow');
  delete raw.policyFile;
  delete raw.policySha256;
  delete raw.policyEnvironment;
  delete raw.adapterProfile;
  raw.lanes = [{ namespace: 'shared', accessLevel: 'normal', profile: 'needs-native-auditor', mode: 'blocked' }];
  const parsed = parseNativeActivationConfig(raw, NOW);
  assert.deepEqual(buildInvocationPlan(parsed, 0).commands, []);
  assert.throws(() => parseNativeActivationConfig({ ...raw, enabled: true }, NOW), /needs_native_auditor/);
});

test('native policy binds the active session lane and derives the hard call reservation', () => {
  const parsed = parseNativeActivationConfig({ ...config('session'), lanes: [{
    namespace: 'shared', accessLevel: 'normal', profile: 'queued-session', mode: 'once',
  }] }, NOW);
  const policy = {
    version: 1, feature: 'memory-session-distillation', environment: 'test',
    generation: { provider: 'openclaw-adapter', model: 'openclaw/total-recall-synthesis',
      endpoint: 'https://example.invalid/generate', credentialEnv: 'GENERATION_API_KEY' },
    terms: { reference: 'review', privacyApproved: true, retentionApproved: true, trainingApproved: true },
    scope: { namespaces: ['shared'], accessLevel: 'normal' },
    budget: { mode: 'subscription', maxInputBytesPerSession: 1024,
      maxOutputBytesPerSession: 1024, usageControlReference: 'subscription-control' },
    providerModelApproval: POLICY_APPROVAL, termsApproval: POLICY_APPROVAL,
    scopeApproval: POLICY_APPROVAL, budgetApproval: POLICY_APPROVAL,
  };
  assert.deepEqual(validateNativePolicyForLane(parsed, parsed.lanes[0], policy, NOW), {
    generationCallHardMax: 1, scopeBinding: 'exact-lane',
  });
  assert.throws(() => validateNativePolicyForLane(parsed, parsed.lanes[0], {
    ...policy, scope: { namespaces: ['other'], accessLevel: 'normal' },
  }, NOW), /policy_scope_mismatch/);
});

test('policy-derived reservations cover reflection retries and consolidation clusters', () => {
  const generation = { provider: 'openclaw-adapter', model: 'openclaw/total-recall-synthesis',
    endpoint: 'https://example.invalid/generate', credentialEnv: 'GENERATION_API_KEY' };
  const terms = { reference: 'review', privacyApproved: true, retentionApproved: true, trainingApproved: true };
  const reflection = parseNativeActivationConfig({ ...config('reflection'), lanes: [{
    namespace: 'shared', accessLevel: 'normal', profile: 'weekly', mode: 'run',
  }] }, NOW);
  const reflectionPolicy = {
    version: 1, feature: 'memory-reflection', environment: 'test', generation, terms,
    scope: { namespaces: ['shared'], accessLevel: 'normal' },
    selection: { maxCandidates: 10, maxInputBytes: 4096, maxInsights: 2 },
    budget: { mode: 'subscription', maxCallsPerRun: 2, maxOutputBytesPerRun: 131072,
      usageControlReference: 'subscription-control' },
    providerModelApproval: POLICY_APPROVAL, termsApproval: POLICY_APPROVAL,
    scopeApproval: POLICY_APPROVAL, budgetApproval: POLICY_APPROVAL,
  };
  assert.equal(validateNativePolicyForLane(reflection, reflection.lanes[0], reflectionPolicy, NOW)
    .generationCallHardMax, 2);
  const reflectionDryRun = parseNativeActivationConfig({ ...config('reflection'), lanes: [{
    namespace: 'shared', accessLevel: 'normal', profile: 'weekly', mode: 'dry-run',
  }] }, NOW);
  assert.equal(validateNativePolicyForLane(reflectionDryRun, reflectionDryRun.lanes[0], reflectionPolicy, NOW)
    .generationCallHardMax, 0);

  const consolidation = parseNativeActivationConfig({ ...config('consolidation'), lanes: [{
    namespace: 'shared', accessLevel: 'normal', profile: 'bounded-clusters', mode: 'preview',
    artifactPath: '/private/preview.json', maxAnchors: 10, maxClusters: 10,
  }] }, NOW);
  assert.equal(validateNativePolicyForLane(consolidation, consolidation.lanes[0], {
    version: 1, feature: 'memory-consolidation', environment: 'test', generation, terms,
    scope: { namespaces: ['shared'], accessLevel: 'normal' },
    budget: { mode: 'subscription', maxCallsPerInvocation: 10,
      maxInputBytesPerInvocation: 655360, maxOutputBytesPerInvocation: 204800,
      usageControlReference: 'subscription-control' },
    generationApproval: POLICY_APPROVAL,
  }, NOW).generationCallHardMax, 10);
});

test('taste reports broader policy scope and reserves only its generating preview mode', () => {
  const raw = { ...config('taste'), lanes: [{ namespace: 'media', accessLevel: 'normal',
    profile: 'monthly-media', mode: 'preview', category: 'music' }] };
  const preview = parseNativeActivationConfig(raw, NOW);
  const policy = {
    version: 2, feature: 'media-taste-profile', enabled: true, environment: 'test',
    generation: { provider: 'openclaw-adapter', model: 'openclaw/total-recall-synthesis',
      endpoint: 'https://example.invalid/generate', credentialEnv: 'GENERATION_API_KEY', timeoutMs: 1000 },
    terms: { reference: 'review', privacyApproved: true, retentionApproved: true, trainingApproved: true },
    scope: { namespaces: ['media', 'personal'], sourceNamespace: 'media', targetNamespace: 'personal',
      accessLevels: ['normal'] },
    aggregation: { minimumEvents: 10, topLimit: 10, trendMinimumAbsoluteChange: 3,
      trendMinimumShareChange: 0.1 },
    budget: { mode: 'subscription', maxCallsPerRun: 2, maxOutputBytesPerRun: 8192,
      usageControlReference: 'subscription-control' },
    selection: { previewTtlMinutes: 60, maxMaterializedEvents: 1000 },
    providerModelApproval: POLICY_APPROVAL, termsApproval: POLICY_APPROVAL,
    scopeApproval: POLICY_APPROVAL, budgetApproval: POLICY_APPROVAL,
  };
  assert.deepEqual(validateNativePolicyForLane(preview, preview.lanes[0], policy, NOW), {
    generationCallHardMax: 2, scopeBinding: 'policy-broader',
  });
  const apply = parseNativeActivationConfig({ ...raw, lanes: [{ ...raw.lanes[0], mode: 'apply',
    artifactPath: '/private/approved-selection.json' }] }, NOW);
  assert.equal(validateNativePolicyForLane(apply, apply.lanes[0], policy, NOW).generationCallHardMax, 0);
});

test('receipt validation recognizes only reviewed content-free contracts', () => {
  assert.doesNotThrow(() => validateKnownCliReceipt('session', '[session-distill] stopped { processed: 1 }', ''));
  assert.doesNotThrow(() => validateKnownCliReceipt('webhook', '[webhook-delivery] stopped { processed: 0 }', ''));
  assert.throws(() => validateKnownCliReceipt('entity', 'source content and arbitrary success', ''), /unparseable/);
});
