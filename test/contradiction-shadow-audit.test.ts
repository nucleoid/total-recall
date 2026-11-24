import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import {
  assertContradictionAuditAuthority,
  contradictionAuditPolicyHash,
  parseContradictionAuditCli,
  runContradictionShadowAudit,
} from '../scripts/contradiction-shadow-audit.js';
import { contradictionPolicyFromEnv } from '../src/contradictions.js';
import { setPoolForTesting } from '../src/db.js';
import type { AuthContext } from '../src/types.js';

const KEY_ID = '11111111-1111-4111-8111-111111111111';
const CLAIM_ID = '22222222-2222-4222-8222-222222222222';
const CANDIDATE_ID = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);

function policy() {
  return contradictionPolicyFromEnv({
    CONTRADICTION_CLASSIFICATION_ENABLED: 'true',
    CONTRADICTION_PROCESSING_APPROVED: 'true',
    CONTRADICTION_PROVIDER: 'openclaw-adapter',
    CONTRADICTION_MODEL: 'openclaw/total-recall-synthesis',
    CONTRADICTION_GENERATION_ENDPOINT: 'https://private.example/generate',
    CONTRADICTION_PROVIDER_MODEL_APPROVED: 'true',
    CONTRADICTION_PRIVACY_APPROVED: 'true',
    CONTRADICTION_RETENTION_APPROVED: 'true',
    CONTRADICTION_TRAINING_APPROVED: 'true',
    CONTRADICTION_APPROVED_NAMESPACE: 'shared',
    CONTRADICTION_SCOPE_APPROVED: 'true',
    CONTRADICTION_COST_BUDGET_USD: '1',
    CONTRADICTION_COST_BUDGET_APPROVED: 'true',
    CONTRADICTION_ESTIMATED_REQUEST_COST_USD: '0.001',
    CONTRADICTION_ESTIMATED_INPUT_COST_USD_PER_MILLION_BYTES: '0',
    CONTRADICTION_ESTIMATED_OUTPUT_COST_USD_PER_MILLION_BYTES: '0',
  });
}

function auth(): AuthContext {
  return { keyId: KEY_ID, name: 'contradiction-review', namespaces: ['shared'],
    permissions: ['read', 'contradiction_resolve'], maxAccessLevel: 'normal' };
}

function options() {
  const expectedPolicyHash = contradictionAuditPolicyHash(policy());
  return { once: true as const, namespace: 'shared', accessLevel: 'normal' as const, expectedPolicyHash };
}

function fakePool(claim: Record<string, unknown>, outcome = 'classified') {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text.includes('contradiction_shadow_claim')) return { rows: claim ? [claim] : [] };
      if (text.includes('contradiction_shadow_append_outcome')) return { rows: [{ outcome }] };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { calls, pool: { connect: async () => client } as unknown as pg.Pool };
}

test('CLI is fixed to one normal-access lane and one expected runtime policy hash', () => {
  const parsed = parseContradictionAuditCli(['--once', '--namespace', 'shared', '--access-level', 'normal',
    '--expected-policy-hash', HASH]);
  assert.equal(parsed.namespace, 'shared');
  assert.throws(() => parseContradictionAuditCli(['--once', '--namespace', 'shared', '--access-level', 'secret',
    '--expected-policy-hash', HASH]), /exactly normal/);
  assert.throws(() => parseContradictionAuditCli(['--namespace', 'shared', '--access-level', 'normal',
    '--expected-policy-hash', HASH]), /--once/);
});

test('policy fingerprint is hashed before PostgreSQL text use and authority is exact', () => {
  const approved = policy();
  assert.match(approved.budget!.fingerprint, /\0/);
  const hash = contradictionAuditPolicyHash(approved);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash.includes('\0'), false);
  assert.doesNotThrow(() => assertContradictionAuditAuthority(auth(), approved, options()));
  assert.throws(() => assertContradictionAuditAuthority({ ...auth(), permissions: ['read', 'write',
    'contradiction_resolve'] }, approved, options()), /authority_mismatch/);
});

test('no-candidate receipt performs zero provider calls and no memory mutation', async () => {
  const fixture = fakePool({ claim_id: CLAIM_ID, status: 'no_candidates', subject_content: null,
    candidates: [], subject_content_sha256: HASH, evidence_hash: 'b'.repeat(64),
    candidate_set_hash: 'c'.repeat(64) });
  setPoolForTesting(fixture.pool);
  let providerCalls = 0;
  try {
    const result = await runContradictionShadowAudit(options(), { policy: policy(), auth: auth(), provider: {
      name: 'openclaw-adapter', async generate() { providerCalls += 1; return '{}'; },
    } });
    assert.equal(result.status, 'no_candidates');
    assert.equal(result.providerCalls, 0);
    assert.equal(providerCalls, 0);
    assert.equal(fixture.calls.some(call => /(?:INSERT|UPDATE|DELETE)\s+(?:public\.)?memories/i.test(call.text)), false);
  } finally { setPoolForTesting(null); }
});

test('one claimed subject invokes classification once and appends only a content-free outcome', async () => {
  const secretSubject = 'Subject text must never be logged';
  const secretCandidate = 'Candidate text must never be logged';
  const fixture = fakePool({ claim_id: CLAIM_ID, status: 'claimed', subject_content: secretSubject,
    candidates: [{ id: CANDIDATE_ID, revision: 2, content_sha256: 'd'.repeat(64),
      content: secretCandidate, similarity: 0.91 }], subject_content_sha256: HASH,
    evidence_hash: 'b'.repeat(64), candidate_set_hash: 'c'.repeat(64) });
  setPoolForTesting(fixture.pool);
  let providerCalls = 0;
  try {
    const result = await runContradictionShadowAudit(options(), { policy: policy(), auth: auth(), provider: {
      name: 'openclaw-adapter', async generate() {
        providerCalls += 1;
        return JSON.stringify({ classification: 'contradiction', confidence: 0.93,
          candidate_id: CANDIDATE_ID });
      },
    } });
    assert.equal(result.status, 'classified');
    assert.equal(result.providerCalls, 1);
    assert.equal(result.classification, 'contradiction');
    assert.equal(providerCalls, 1);
    const append = fixture.calls.find(call => call.text.includes('contradiction_shadow_append_outcome'))!;
    assert.deepEqual(append.params, [CLAIM_ID, 'classified', 'contradiction', 0.93, CANDIDATE_ID, 1]);
    assert.equal(JSON.stringify(result).includes(secretSubject), false);
    assert.equal(JSON.stringify(result).includes(secretCandidate), false);
  } finally { setPoolForTesting(null); }
});
