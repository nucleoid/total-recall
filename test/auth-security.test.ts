import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import { setPoolForTesting } from '../src/db.js';
import { authContextFromRow, validateKey, validateKeyReadOnly } from '../src/auth.js';

test('auth row parsing preserves unlimited legacy keys and rejects malformed limits', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111', name: 'agent', namespaces: ['shared'],
    permissions: ['read'], max_access_level: 'normal', expires_at: null,
  };
  assert.deepEqual(authContextFromRow(base), {
    keyId: base.id, name: 'agent', namespaces: ['shared'], permissions: ['read'],
    maxAccessLevel: 'normal', requestsPerMinute: null, requestsPerDay: null, expiresAt: null,
  });
  assert.equal(authContextFromRow({ ...base, requests_per_minute: -1 }), null);
  assert.equal(authContextFromRow({ ...base, requests_per_day: 'not-a-number' }), null);
});

test('mutating and preview authentication both enforce revocation and half-open expiry', async t => {
  const statements: string[] = [];
  const row = {
    id: '11111111-1111-4111-8111-111111111111', name: 'agent', namespaces: ['shared'],
    permissions: ['read'], max_access_level: 'secret', requests_per_minute: 10,
    requests_per_day: 100, expires_at: new Date('2030-01-01T00:00:00Z'),
  };
  setPoolForTesting({
    async query(text: string) { statements.push(text.replace(/\s+/g, ' ')); return { rows: [row] }; },
  } as unknown as pg.Pool);
  t.after(() => setPoolForTesting(null));

  assert.equal((await validateKey('tr_secret'))?.requestsPerMinute, 10);
  assert.equal((await validateKeyReadOnly('tr_secret'))?.requestsPerDay, 100);
  assert.equal(statements.length, 2);
  for (const sql of statements) {
    assert.match(sql, /enabled = true/);
    assert.match(sql, /revoked_at IS NULL/);
    assert.match(sql, /expires_at IS NULL OR expires_at > NOW\(\)/);
  }
  assert.match(statements[0], /UPDATE api_keys SET last_used_at = NOW\(\)/);
  assert.match(statements[1], /^SELECT/);
});
