import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import request from 'supertest';
import { app, setServerTestOverrides } from '../src/server.js';
import type { AuthContext } from '../src/types.js';

const token = 'Bearer tr_dashboard_contract_test';
const ordinary: AuthContext = {
  keyId: '00000000-0000-4000-8000-000000000062',
  name: 'dashboard-test',
  namespaces: ['shared'],
  permissions: ['read', 'write', 'delete'],
  maxAccessLevel: 'normal',
};

afterEach(() => setServerTestOverrides({}));

test('dashboard shell and direct routes are public, hardened, and never contain credentials', async () => {
  for (const path of ['/dashboard/', '/dashboard/memories', '/dashboard/traces/00000000-0000-4000-8000-000000000001']) {
    const response = await request(app).get(path);
    assert.equal(response.status, 200, path);
    assert.match(response.type, /html/);
    assert.match(response.text, /Total Recall/);
    assert.doesNotMatch(response.text, /tr_[A-Za-z0-9_-]+/);
    assert.match(response.headers['cache-control'] ?? '', /no-cache/);
    assert.match(response.headers['content-security-policy'] ?? '', /default-src 'self'/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
  }
});

test('dashboard API routes remain authenticated and are not swallowed by the SPA fallback', async () => {
  for (const path of [
    '/api/capabilities',
    '/api/memories',
    '/api/memories/00000000-0000-4000-8000-000000000001',
    '/api/traces/00000000-0000-4000-8000-000000000001',
    '/api/media/stats',
  ]) {
    const response = await request(app).get(path);
    assert.equal(response.status, 401, path);
    assert.match(response.type, /json/);
  }

  const mcp = await request(app).get('/mcp');
  assert.equal(mcp.status, 401);
  assert.doesNotMatch(mcp.type, /html/);
});

test('capabilities are derived from the authenticated key without exposing the key', async () => {
  setServerTestOverrides({ validateKey: async () => ordinary });
  const response = await request(app).get('/api/capabilities').set('Authorization', token);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    name: 'dashboard-test',
    namespaces: ['shared'],
    max_access_level: 'normal',
    capabilities: { read: true, write: true, delete: true, admin: false },
  });
  assert.doesNotMatch(JSON.stringify(response.body), /tr_dashboard/);
  assert.equal(Object.hasOwn(response.body, 'keyId'), false);
});
