import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCreateKeyArgs } from '../scripts/create-key.js';
import { parseRotateKeyArgs } from '../scripts/rotate-key.js';
import { parseExpiry } from '../scripts/lib/key-policy.js';

const now = new Date('2026-01-01T00:00:00.000Z');

test('create-key resolves strict expiry and configured quotas', () => {
  const parsed = parseCreateKeyArgs(
    ['--name', 'agent', '--expires', '12h', '--namespaces', 'shared,work'],
    { API_KEY_DEFAULT_RPM: '60', API_KEY_DEFAULT_DAILY_QUOTA: '1000' },
    now,
  );
  assert.equal(parsed.expiresAt?.toISOString(), '2026-01-01T12:00:00.000Z');
  assert.equal(parsed.requestsPerMinute, 60);
  assert.equal(parsed.requestsPerDay, 1000);
  assert.deepEqual(parsed.namespaces, ['shared', 'work']);
});

test('create-key requires explicit quota policy and validates ACL inputs', () => {
  assert.throws(() => parseCreateKeyArgs(['--name', 'agent'], {}, now), /--rpm is required/);
  assert.throws(() => parseCreateKeyArgs([
    '--name', 'agent', '--rpm', '1', '--daily-quota', '2', '--permissions', 'read,root',
  ], {}, now), /Unknown permissions/);
  assert.throws(() => parseCreateKeyArgs([
    '--name', 'agent', '--rpm', '1', '--daily-quota', '2', '--namespaces', 'shared,,work',
  ], {}, now), /nonempty/);
});

test('expiry rejects past, loose, and offset-free timestamps', () => {
  assert.throws(() => parseExpiry('2025-12-31T23:59:59Z', now), /future/);
  assert.throws(() => parseExpiry('2026-01-02', now), /offset-aware/);
  assert.throws(() => parseExpiry('2026-01-02T00:00:00', now), /offset-aware/);
});

test('rotation defaults to immediate expiry and can override copied limits', () => {
  assert.deepEqual(parseRotateKeyArgs(['--name', 'agent']), {
    name: 'agent', graceMilliseconds: 0,
  });
  assert.deepEqual(parseRotateKeyArgs([
    '--name', 'agent', '--grace', '24h', '--rpm', 'unlimited', '--daily-quota', '50',
  ]), {
    name: 'agent', graceMilliseconds: 86_400_000, requestsPerMinute: null, requestsPerDay: 50,
  });
});
