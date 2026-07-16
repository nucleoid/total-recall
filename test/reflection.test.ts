import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import {
  assertReflectionAuthority,
  lastCompletedIsoWeek,
  materializeReflectionInput,
  normalizeInsightContent,
  parseReflectionPolicy,
  reflectionInsightHash,
  runReflection,
  validateReflectionOutput,
  type ReflectionCandidate,
} from '../src/reflection.js';
import { parseReflectionCli } from '../scripts/reflect.js';
import { setPoolForTesting } from '../src/db.js';

const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

function policy() {
  const approval = { approved: true as const, approvedBy: 'reviewer',
    approvedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' };
  return {
    version: 1 as const, feature: 'memory-reflection' as const, environment: 'test',
    generation: { provider: 'gateway', model: 'model', endpoint: 'https://example.invalid/generate', credentialEnv: 'REFLECT_KEY' },
    terms: { reference: 'review', privacyApproved: true as const, retentionApproved: true as const, trainingApproved: true as const },
    scope: { namespaces: ['work'] as [string], accessLevel: 'normal' as const },
    selection: { maxCandidates: 100, maxInputBytes: 65536, maxInsights: 10 },
    budget: { maxCallsPerRun: 2, maxOutputBytesPerRun: 131072, maxCostUsdPerRun: 1,
      maxCostUsdPerMonth: 5, estimatedRequestCostUsd: 0, estimatedInputCostUsdPerMillionBytes: 0,
      estimatedOutputCostUsdPerMillionBytes: 0, monthlyControlReference: 'budget' },
    providerModelApproval: approval, termsApproval: approval, scopeApproval: approval, budgetApproval: approval,
  };
}

test('last completed ISO week is a UTC Monday-to-Monday interval', () => {
  assert.deepEqual(lastCompletedIsoWeek(new Date('2026-07-16T23:30:00-07:00')), {
    start: new Date('2026-07-06T00:00:00.000Z'),
    end: new Date('2026-07-13T00:00:00.000Z'),
  });
  assert.deepEqual(lastCompletedIsoWeek(new Date('2026-07-13T00:00:00.000Z')), {
    start: new Date('2026-07-06T00:00:00.000Z'),
    end: new Date('2026-07-13T00:00:00.000Z'),
  });
});

test('reflection policy requires every feature-specific approval', () => {
  assert.equal(parseReflectionPolicy(policy(), 'test', new Date('2026-06-01T00:00:00Z')).feature, 'memory-reflection');
  const missing = { ...policy() } as any;
  delete missing.termsApproval;
  assert.throws(() => parseReflectionPolicy(missing, 'test', new Date('2026-06-01T00:00:00Z')));
  assert.throws(() => parseReflectionPolicy(policy(), 'production', new Date('2026-06-01T00:00:00Z')), /environment/);
});

test('strict reflection output accepts sampled evidence and rejects control fields, credentials, and invented IDs', () => {
  const valid = JSON.stringify({ insights: [{ content: 'The user consistently chooses explicit rollouts.',
    evidence_ids: ids.slice(0, 2), confidence: 0.8, tags: ['rollout', 'preference'] }] });
  assert.equal(validateReflectionOutput(valid, ids, 10).length, 1);
  assert.throws(() => validateReflectionOutput(JSON.stringify({ insights: [{ content: 'Pattern',
    evidence_ids: [ids[0], '44444444-4444-4444-8444-444444444444'], confidence: 0.5, tags: [] }] }), ids),
  /invalid_reflection_evidence/);
  assert.throws(() => validateReflectionOutput(JSON.stringify({ insights: [{ content: 'Pattern',
    evidence_ids: ids.slice(0, 2), confidence: 0.5, tags: [], namespace: 'secret' }] }), ids), /invalid_reflection_output/);
  assert.throws(() => validateReflectionOutput(JSON.stringify({ insights: [{ content: 'api_key=do-not-store',
    evidence_ids: ids.slice(0, 2), confidence: 0.5, tags: [] }] }), ids), /invalid_reflection_output/);
});

test('normalization makes exact insight reuse deterministic', () => {
  assert.equal(normalizeInsightContent('  Café\n  Choice '), 'café choice');
  assert.equal(reflectionInsightHash('Café choice'), reflectionInsightHash('  Cafe\u0301\nCHOICE '));
});

test('materialization preserves selection order and stops at the prompt byte budget', async () => {
  const selected: ReflectionCandidate[] = ids.map((id, index) => ({ id, revision: 0, accessLevel: 'normal',
    createdAt: '2026-07-01T00:00:00Z', accessedAt: '2026-07-01T00:00:00Z', accessCount: index }));
  const contents = new Map([[ids[0], 'first'], [ids[1], 'second'], [ids[2], 'c'.repeat(2000)]]);
  const client = { query: async (_sql: string, params: unknown[]) => ({
    rows: [{ content: contents.get(params[0] as string) }],
  }) } as unknown as pg.PoolClient;
  const result = await materializeReflectionInput(client, selected, 1024);
  assert.deepEqual(result.candidates.map(candidate => candidate.id), ids.slice(0, 2));
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.input, /cccccccccc/);
});

test('reflection CLI is strict and force cannot weaken dry-run', () => {
  assert.deepEqual(parseReflectionCli(['--namespace', 'work', '--dry-run']), {
    namespace: 'work', dryRun: true, force: false, window: undefined,
  });
  assert.throws(() => parseReflectionCli(['--namespace', 'work', '--dry-run', '--force']), /mutually exclusive/);
  assert.throws(() => parseReflectionCli(['--namespace', 'insights']), /non-insights/);
  assert.throws(() => parseReflectionCli(['--namespace', 'work', '--window-start', '2026-07-01']), /explicit offset/);
  assert.throws(() => parseReflectionCli(['--namespace', 'work', '--unknown']), /Unknown/);
});

test('reflection authority is narrow and origin-aware', () => {
  const auth = { keyId: ids[0], name: 'reflection', namespaces: ['insights', 'work'],
    permissions: ['read', 'reflection'], maxAccessLevel: 'normal' as const };
  assert.doesNotThrow(() => assertReflectionAuthority(auth, 'work'));
  assert.throws(() => assertReflectionAuthority({ ...auth, permissions: [...auth.permissions, 'write'] }, 'work'), /exactly/);
  assert.throws(() => assertReflectionAuthority({ ...auth, namespaces: ['insights'] }, 'work'), /dedicated/);
});

test('dry-run materializes a bounded estimate without provider calls or database writes', async () => {
  const sql: string[] = [];
  const content = new Map([[ids[0], 'first memory'], [ids[1], 'second memory']]);
  const client = {
    query: async (text: string, params?: unknown[]) => {
      sql.push(text);
      if (text.includes('WITH recent AS')) return { rows: ids.slice(0, 2).map((id, index) => ({
        id, revision: 0, access_level: 'normal', created_at: '2026-07-01T00:00:00Z',
        accessed_at: '2026-07-01T00:00:00Z', access_count: index,
      })) };
      if (text.includes('SELECT content FROM memories WHERE id = $1::uuid')) {
        return { rows: [{ content: content.get(params?.[0] as string) }] };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  setPoolForTesting({ connect: async () => client } as unknown as pg.Pool);
  let providerCalls = 0;
  try {
    const result = await runReflection({
      auth: { keyId: ids[0], name: 'reflection', namespaces: ['work', 'insights'],
        permissions: ['read', 'reflection'], maxAccessLevel: 'normal' },
      namespace: 'work', environment: 'test', policy: policy(), dryRun: true,
      window: { start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-07-08T00:00:00Z') },
      provider: { name: 'gateway', generate: async () => { providerCalls += 1; return '{"insights":[]}'; } },
    });
    assert.equal(result.materialized, 2);
    assert.equal(result.providerCalls, 0);
    assert.equal(providerCalls, 0);
    assert.equal(sql.some(text => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(text)), false);
  } finally {
    setPoolForTesting(null);
  }
});
