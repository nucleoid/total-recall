import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDerivedAccessNotDowngraded,
  assertSubscriptionGeneration,
  assertSynthesisAuthority,
  maximumAccessLevel,
} from '../src/synthesis-policy.js';

const auth = {
  keyId: '11111111-1111-4111-8111-111111111111',
  name: 'total-recall-synthesis-subscription',
  namespaces: ['personal', 'work', 'media', 'shared', 'activity', 'financial', 'projects', 'my-life', 'insights'],
  permissions: ['read', 'write', 'consolidate'],
  maxAccessLevel: 'secret' as const,
};

test('synthesis authority preserves namespace and sensitivity boundaries per key', () => {
  assert.doesNotThrow(() => assertSynthesisAuthority(auth, ['financial'], 'secret'));
  assert.doesNotThrow(() => assertSynthesisAuthority(auth, ['my-life', 'insights'], 'sensitive'));
  assert.throws(() => assertSynthesisAuthority({ ...auth, namespaces: ['work', 'insights'] }, ['financial'], 'normal'),
    /does not authorize/);
  assert.throws(() => assertSynthesisAuthority({ ...auth, maxAccessLevel: 'normal' }, ['work'], 'sensitive'),
    /does not authorize/);
});

test('derived output classification is the maximum cited source classification', () => {
  assert.equal(maximumAccessLevel(['normal', 'sensitive']), 'sensitive');
  assert.equal(maximumAccessLevel(['normal', 'secret', 'sensitive']), 'secret');
  assert.doesNotThrow(() => assertDerivedAccessNotDowngraded('secret', 'sensitive'));
  assert.throws(() => assertDerivedAccessNotDowngraded('normal', 'sensitive'), /existing_derived_access_too_low/);
  assert.throws(() => assertDerivedAccessNotDowngraded('sensitive', 'secret'), /existing_derived_access_too_low/);
});

test('subscription mode cannot bypass the isolated OpenClaw agent', () => {
  assert.doesNotThrow(() => assertSubscriptionGeneration(
    { provider: 'openclaw-adapter', model: 'openclaw/total-recall-synthesis' }, { mode: 'subscription' }));
  assert.throws(() => assertSubscriptionGeneration(
    { provider: 'gateway', model: 'openai/gpt-6.1-sol' }, { mode: 'subscription' }), /approved OpenClaw/);
  assert.doesNotThrow(() => assertSubscriptionGeneration(
    { provider: 'legacy-paid-provider', model: 'legacy-model' }, { mode: 'paid' }));
});
