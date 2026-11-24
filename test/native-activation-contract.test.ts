import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInvocationPlan,
  parseNativeActivationConfig,
  validateKnownCliReceipt,
} from '../scripts/native-activation-contract.js';

const NOW = new Date('2026-11-24T12:00:00.000Z');
function config(feature = 'entity'): any {
  return {
    version: 1, feature, enabled: false, container: 'total-recall-ingestion-1',
    environmentFile: '/etc/total-recall/private/entity.env',
    policyFile: '/app/policies/entity.json', policySha256: 'a'.repeat(64),
    adapterProfile: 'openclaw-main-subscription', timeoutSeconds: 120,
    dailyGenerationCallCap: 6, generationCallsPerRun: 1,
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
  const profiles = [
    ['session', 'queued-session', 'session:distill'],
    ['contradiction-shadow', 'ingestion-shadow', 'ingest:worker'],
  ] as const;
  for (const [feature, profile, script] of profiles) {
    const raw = config(feature);
    raw.lanes = [{ namespace: 'shared', accessLevel: 'normal', profile,
      mode: feature === 'session' ? 'once' : 'shadow' }];
    const argv = buildInvocationPlan(parseNativeActivationConfig(raw, NOW), 0).commands[0].argv;
    assert.equal(argv[2], script);
    assert.ok(argv.includes('--max-jobs') && argv.includes('1'));
    if (feature === 'contradiction-shadow') assert.deepEqual(argv.slice(-9),
      ['--once', '--max-jobs', '1', '--concurrency', '1', '--batch-size', '1', '--poll-ms', '100']);
  }
});

test('receipt validation recognizes only reviewed content-free contracts', () => {
  assert.doesNotThrow(() => validateKnownCliReceipt('session', '[session-distill] stopped { processed: 1 }', ''));
  assert.doesNotThrow(() => validateKnownCliReceipt('webhook', '[webhook-delivery] stopped { processed: 0 }', ''));
  assert.throws(() => validateKnownCliReceipt('entity', 'source content and arbitrary success', ''), /unparseable/);
});
