import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalSessionRequestHash,
  parseSessionDistillationPolicy,
  sessionDistillationPolicyHash,
  storeSessionSchema,
  validateSessionDistillationOutput,
} from '../src/session-distillation.js';

const approval = { approved: true as const, approvedBy: 'owner', approvedAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' };
function policy() {
  return {
    version: 1 as const, feature: 'memory-session-distillation' as const, environment: 'test',
    generation: { provider: 'session-gateway', model: 'session-model', endpoint: 'https://example.test/generate', credentialEnv: 'SESSION_TEST_KEY' },
    terms: { reference: 'review/57', privacyApproved: true as const, retentionApproved: true as const, trainingApproved: true as const },
    scope: { namespaces: ['low-risk'] as [string], accessLevel: 'normal' as const },
    budget: { maxInputBytesPerSession: 1_100_000, maxOutputBytesPerSession: 65_536,
      maxCostUsdPerSession: 1, maxCostUsdPerMonth: 10, estimatedRequestCostUsd: 0.001,
      estimatedInputCostUsdPerMillionBytes: 1, estimatedOutputCostUsdPerMillionBytes: 4,
      monthlyControlReference: 'quota/57' },
    providerModelApproval: approval, termsApproval: approval, scopeApproval: approval, budgetApproval: approval,
  };
}

test('session input is strict, UTF-8 bounded, and defaults to shared normal scope', () => {
  assert.deepEqual(storeSessionSchema.parse({ transcript: 'hello' }), {
    transcript: 'hello', namespace: 'shared', access_level: 'normal',
  });
  assert.throws(() => storeSessionSchema.parse({ transcript: 'hello', source: 'forged' }), /unrecognized/i);
  assert.throws(() => storeSessionSchema.parse({ transcript: '   ' }), /non-whitespace/i);
  assert.throws(() => storeSessionSchema.parse({ transcript: '😀'.repeat(262_145) }), /1 MiB/i);
});

test('session request hashes are canonical, versioned, and bind provenance and content', () => {
  const params = storeSessionSchema.parse({ transcript: 'hello', session_id: 's1' });
  const agent = { name: 'agent', type: 'llm' };
  const first = canonicalSessionRequestHash(params, '00000000-0000-4000-8000-000000000001', agent);
  assert.match(first, /^sha256:session-v1:[0-9a-f]{64}$/);
  assert.equal(first, canonicalSessionRequestHash(structuredClone(params), '00000000-0000-4000-8000-000000000001', agent));
  assert.notEqual(first, canonicalSessionRequestHash({ ...params, transcript: 'changed' }, '00000000-0000-4000-8000-000000000001', agent));
  assert.notEqual(first, canonicalSessionRequestHash(params, '00000000-0000-4000-8000-000000000001', { ...agent, name: 'other' }));
});

test('distillation output is strict, bounded, credential-rejecting, and batch-deduplicated', () => {
  const facts = validateSessionDistillationOutput(JSON.stringify({ facts: [
    { content: 'User prefers PostgreSQL.', kind: 'preference' },
    { content: '  USER  PREFERS POSTGRESQL. ', kind: 'fact' },
    { content: 'Deploy on Friday.', kind: 'plan' },
  ] }));
  assert.deepEqual(facts.map(fact => fact.kind), ['preference', 'plan']);
  assert.throws(() => validateSessionDistillationOutput(JSON.stringify({ facts: [
    { content: 'api_key = top-secret-value', kind: 'fact' },
  ] })), /invalid_session/);
  assert.throws(() => validateSessionDistillationOutput('{"facts":[],"namespace":"secret"}'), /invalid_session/);
  assert.throws(() => validateSessionDistillationOutput(JSON.stringify({ facts: [
    { content: 'x', kind: 'fact', access_level: 'normal' },
  ] })), /invalid_session/);
});

test('session policy requires four feature-specific effective approvals and exact one-namespace normal scope', () => {
  const parsed = parseSessionDistillationPolicy(policy(), 'test', new Date('2026-07-01T00:00:00Z'));
  assert.equal(parsed.scope.namespaces.length, 1);
  assert.equal(sessionDistillationPolicyHash(parsed), sessionDistillationPolicyHash(structuredClone(parsed)));
  assert.throws(() => parseSessionDistillationPolicy({ ...policy(), feature: 'memory-entity-extraction' }, 'test'), /Invalid literal/);
  assert.throws(() => parseSessionDistillationPolicy({ ...policy(), termsApproval: undefined }, 'test'), /Required/);
  assert.throws(() => parseSessionDistillationPolicy(policy(), 'production'), /environment/);
  assert.throws(() => parseSessionDistillationPolicy(policy(), 'test', new Date('2028-01-01T00:00:00Z')), /expired/);
});
