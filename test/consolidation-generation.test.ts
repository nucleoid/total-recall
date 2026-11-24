import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertConsolidationAuthority,
  consolidationCanonicalAccessLevel,
  consolidationPolicyHash,
  parseConsolidationPolicy,
  validateConsolidationGeneration,
} from '../src/consolidation.js';

const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
];

function policy() {
  return {
    version: 1,
    feature: 'memory-consolidation',
    environment: 'test',
    generation: { provider: 'approved-gateway', model: 'approved-model', endpoint: 'https://example.test/generate', credentialEnv: 'CONSOLIDATION_TEST_KEY' },
    terms: { reference: 'review/54', privacyApproved: true, retentionApproved: true, trainingApproved: true },
    scope: { namespaces: ['low-risk'], accessLevel: 'normal' },
    budget: { maxCallsPerInvocation: 2, maxInputBytesPerInvocation: 131072, maxOutputBytesPerInvocation: 32768,
      maxCostUsdPerInvocation: 1, estimatedRequestCostUsd: 0.001,
      estimatedInputCostUsdPerMillionBytes: 1, estimatedOutputCostUsdPerMillionBytes: 4,
      monthlyControlReference: 'provider-project-quota/54' },
    generationApproval: { approved: true, approvedBy: 'owner', approvedAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' },
  };
}

test('strict generation validation requires exact provenance and decision fields', () => {
  const valid = validateConsolidationGeneration(JSON.stringify({ decision: 'merge', source_ids: [...ids].reverse(), canonical_content: 'Canonical fact', reason_code: 'duplicate' }), ids);
  assert.equal(valid.canonical_content, 'Canonical fact');
  assert.throws(() => validateConsolidationGeneration(JSON.stringify({ decision: 'merge', source_ids: [ids[0]], canonical_content: 'x', reason_code: 'duplicate' }), ids), /invalid_consolidation/);
  assert.throws(() => validateConsolidationGeneration(JSON.stringify({ decision: 'skip', source_ids: ids, canonical_content: 'x', reason_code: 'conflict' }), ids), /invalid_consolidation/);
  assert.throws(() => validateConsolidationGeneration(JSON.stringify({ decision: 'skip', source_ids: ids, reason_code: 'conflict', extra: true }), ids), /invalid_consolidation/);
});

test('policy is feature-specific, exact, unexpired, and hashes deterministically', () => {
  const parsed = parseConsolidationPolicy(policy(), 'test', new Date('2026-07-01T00:00:00Z'));
  assert.equal(parsed.scope.namespaces.length, 1);
  assert.equal(consolidationPolicyHash(parsed), consolidationPolicyHash(structuredClone(parsed)));
  assert.throws(() => parseConsolidationPolicy({ ...policy(), feature: 'contradiction-classification' }, 'test'), /Invalid literal/);
  assert.throws(() => parseConsolidationPolicy(policy(), 'production'), /environment/);
  assert.throws(() => parseConsolidationPolicy(policy(), 'test', new Date('2028-01-01T00:00:00Z')), /expired/);
});


test('subscription policy is idempotent and restricted to the isolated OpenClaw adapter', () => {
  const subscription = {
    ...policy(),
    generation: { provider: 'openclaw-adapter', model: 'openclaw/total-recall-synthesis',
      endpoint: 'https://10.0.0.9:3012/v1/generate', credentialEnv: 'GENERATION_API_KEY' },
    scope: { namespaces: ['financial'], accessLevel: 'secret' },
    budget: { mode: 'subscription', maxCallsPerInvocation: 2, maxInputBytesPerInvocation: 131072,
      maxOutputBytesPerInvocation: 32768, usageControlReference: 'dedicated subscription call quotas' },
  };
  const parsed = parseConsolidationPolicy(subscription, 'test', new Date('2026-07-01T00:00:00Z'));
  assert.deepEqual(parseConsolidationPolicy(parsed, 'test', new Date('2026-07-01T00:00:00Z')), parsed);
  assert.equal(parsed.budget.maxCostUsdPerInvocation, 0);
  assert.throws(() => parseConsolidationPolicy({ ...subscription,
    generation: { ...subscription.generation, provider: 'direct-openai' } }, 'test',
  new Date('2026-07-01T00:00:00Z')), /approved OpenClaw agent adapter/);
  assert.throws(() => parseConsolidationPolicy({ ...subscription,
    budget: { ...subscription.budget, arbitrary: true } }, 'test', new Date('2026-07-01T00:00:00Z')));
});

test('all-access consolidation requires genuine namespace and level authority', () => {
  const auth = { keyId: ids[0], name: 'consolidation', namespaces: ['work', 'financial'],
    permissions: ['read', 'write', 'consolidate'], maxAccessLevel: 'secret' as const };
  assert.doesNotThrow(() => assertConsolidationAuthority(auth, 'financial', 'apply', 'secret'));
  assert.throws(() => assertConsolidationAuthority({ ...auth, maxAccessLevel: 'sensitive' },
    'financial', 'apply', 'secret'), /does not authorize/);
  assert.throws(() => assertConsolidationAuthority({ ...auth, namespaces: ['work'] },
    'financial', 'dry-run', 'normal'), /does not authorize/);
});

test('canonical classification conservatively includes prompt and revalidated members', () => {
  const prompt = [{ id: ids[0], access_level: 'normal' as const }, { id: ids[1], access_level: 'secret' as const }];
  const current = [{ id: ids[0], access_level: 'normal' as const }, { id: ids[1], access_level: 'normal' as const }];
  assert.equal(consolidationCanonicalAccessLevel(prompt, current), 'secret');
});
