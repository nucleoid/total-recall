import assert from 'node:assert/strict';
import test from 'node:test';
import {
  entityExtractionPolicyHash,
  normalizeEntityName,
  parseEntityExtractionPolicy,
  validateEntityExtraction,
} from '../src/entity-extractor.js';

const approval = { approved: true as const, approvedBy: 'owner', approvedAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' };
function policy() {
  return {
    version: 1 as const, feature: 'memory-entity-extraction' as const, environment: 'test',
    generation: { provider: 'entity-gateway', model: 'entity-model', endpoint: 'https://example.test/generate', credentialEnv: 'ENTITY_TEST_KEY' },
    terms: { reference: 'review/55', privacyApproved: true as const, retentionApproved: true as const, trainingApproved: true as const },
    scope: { namespaces: ['low-risk'] as [string], accessLevel: 'normal' as const },
    budget: { maxCallsPerInvocation: 10, maxInputBytesPerInvocation: 1_000_000, maxOutputBytesPerInvocation: 500_000,
      maxCostUsdPerInvocation: 1, estimatedRequestCostUsd: 0.001, estimatedInputCostUsdPerMillionBytes: 1,
      estimatedOutputCostUsdPerMillionBytes: 4, monthlyControlReference: 'quota/55' },
    providerModelApproval: approval, termsApproval: approval, scopeApproval: approval, budgetApproval: approval,
  };
}

test('entity normalization is conservative and Unicode compatible', () => {
  assert.equal(normalizeEntityName('  Ｐroject\t X  '), 'project x');
  assert.equal(normalizeEntityName('Straße'), 'straße');
});

test('entity output is strict, bounded, source-grounded, and filters unsupported types', () => {
  const source = 'Alice uses Total Recall in Wellington.';
  const entities = validateEntityExtraction(JSON.stringify({ entities: [
    { display_name: 'Alice', type: 'person', mention: 'Alice', aliases: [' Alice ', 'A.'], confidence: 0.99 },
    { display_name: 'Wellington', type: 'animal', mention: 'Wellington', aliases: [], confidence: 0.99 },
    { display_name: 'Guess', type: 'project', mention: 'Guess', aliases: [], confidence: 0.1 },
  ] }), source);
  assert.deepEqual(entities.map(entity => [entity.type, entity.normalizedName, entity.aliases]), [['person', 'alice', ['A.']]]);
  assert.throws(() => validateEntityExtraction('{"entities":[],"extra":true}'), /invalid_entity/);
  assert.throws(() => validateEntityExtraction(JSON.stringify({ entities: [
    { display_name: 'Alice', type: 'person', mention: 'Bob', aliases: [], confidence: 1 },
  ] }), source), /mention/);
});

test('entity policy requires feature-specific, exact, effective approvals', () => {
  const parsed = parseEntityExtractionPolicy(policy(), 'test', new Date('2026-07-01T00:00:00Z'));
  assert.equal(parsed.scope.namespaces.length, 1);
  assert.equal(entityExtractionPolicyHash(parsed), entityExtractionPolicyHash(structuredClone(parsed)));
  assert.throws(() => parseEntityExtractionPolicy({ ...policy(), feature: 'memory-consolidation' }, 'test'), /Invalid literal/);
  assert.throws(() => parseEntityExtractionPolicy(policy(), 'production'), /environment/);
  assert.throws(() => parseEntityExtractionPolicy({ ...policy(), termsApproval: undefined }, 'test'), /Required/);
});
