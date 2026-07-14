import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
