import assert from 'node:assert/strict';
import test from 'node:test';
import {
  entityExtractionPolicyHash,
  normalizeEntityName,
  parseEntityExtractionPolicy,
  validateEntityExtraction,
} from '../src/entity-extractor.js';
import { assertEntityWorkerAuthority, parseEntityWorkerCli } from '../scripts/entity-enrich.js';
import { parseEntityBackfillCli } from '../scripts/entity-backfill.js';

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

test('subscription entity policy is idempotent, all-level, strict, and OpenClaw-only', () => {
  const subscription = {
    ...policy(),
    generation: { provider: 'openclaw-adapter', model: 'openclaw/total-recall-synthesis',
      endpoint: 'https://10.0.0.9:3012/v1/generate', credentialEnv: 'GENERATION_API_KEY' },
    scope: { namespaces: ['my-life'] as [string], accessLevel: 'secret' as const },
    budget: { mode: 'subscription' as const, maxCallsPerInvocation: 10,
      maxInputBytesPerInvocation: 1_000_000, maxOutputBytesPerInvocation: 500_000,
      usageControlReference: 'openclaw-subscription/entity-extraction' },
  };
  const parsed = parseEntityExtractionPolicy(subscription, 'test', new Date('2026-07-01T00:00:00Z'));
  assert.deepEqual(parseEntityExtractionPolicy(parsed, 'test', new Date('2026-07-01T00:00:00Z')), parsed);
  assert.equal(parsed.budget.maxCostUsdPerInvocation, 0);
  assert.throws(() => parseEntityExtractionPolicy({ ...subscription,
    generation: { ...subscription.generation, provider: 'direct-openai' } }, 'test',
  new Date('2026-07-01T00:00:00Z')), /approved OpenClaw agent adapter/);
  assert.throws(() => parseEntityExtractionPolicy({ ...subscription,
    budget: { ...subscription.budget, arbitrary: true } }, 'test', new Date('2026-07-01T00:00:00Z')));
  const auth = { keyId: '00000000-0000-4000-8000-000000000001', name: 'entity-worker',
    namespaces: ['personal', 'my-life'], permissions: ['read', 'entity_extract'], maxAccessLevel: 'secret' as const };
  assert.doesNotThrow(() => assertEntityWorkerAuthority(auth, parsed));
  assert.throws(() => assertEntityWorkerAuthority({ ...auth, maxAccessLevel: 'sensitive' }, parsed), /does not authorize/);
  assert.throws(() => assertEntityWorkerAuthority({ ...auth, permissions: ['read', 'entity_extract', 'write'] }, parsed), /without write/);
});

test('entity backfill selects one exact namespace and access-level lane', () => {
  assert.deepEqual(parseEntityBackfillCli(['--namespace','financial','--access-level','secret','--preview']),
    {namespace:'financial',accessLevel:'secret',mode:'preview',limit:1000,selection:'missing',memoryIds:[],
      completedBefore:null,sourceBefore:null});
  assert.throws(() => parseEntityBackfillCli(['--namespace','financial','--access-level','root','--preview']), /access-level/);
  assert.throws(() => parseEntityBackfillCli(['--namespace','financial','--execute','--preview']), /exactly one/);
  const id='00000000-0000-4000-8000-000000000123';
  assert.deepEqual(parseEntityBackfillCli(['--namespace','financial','--access-level','sensitive',
    '--requeue-completed-without-links','--completed-before','2020-01-01T00:00:00Z','--memory-id',id,'--limit','1','--execute']),
  {namespace:'financial',accessLevel:'sensitive',mode:'execute',limit:1,
    selection:'completed-without-links',memoryIds:[id],completedBefore:'2020-01-01T00:00:00.000Z',sourceBefore:null});
  assert.throws(() => parseEntityBackfillCli(['--namespace','financial','--requeue-completed-without-links','--preview']), /completed-before/);
  assert.deepEqual(parseEntityBackfillCli(['--namespace','financial','--access-level','sensitive',
    '--requeue-legacy-uncovered','--source-before','2026-11-24T11:40:00Z','--limit','2','--preview']),
  {namespace:'financial',accessLevel:'sensitive',mode:'preview',limit:2,
    selection:'legacy-uncovered',memoryIds:[],completedBefore:null,sourceBefore:'2026-11-24T11:40:00.000Z'});
  assert.throws(() => parseEntityBackfillCli(['--namespace','financial','--requeue-legacy-uncovered','--preview']), /source-before/);
  assert.throws(() => parseEntityBackfillCli(['--namespace','financial','--requeue-legacy-uncovered',
    '--source-before','2026-11-24T11:41:00Z','--preview']), /must equal/);
  assert.deepEqual(parseEntityWorkerCli(['--once','--memory-id',id]),
    {once:true,maxJobs:100,pollMs:1000,memoryIds:[id]});
});
