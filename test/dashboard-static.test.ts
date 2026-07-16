import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
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

test('missing immutable assets return 404 instead of the SPA shell and production emits no source maps', async () => {
  const response = await request(app).get('/dashboard/assets/app-stale-hash.js').set('Accept', '*/*');
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.type, /html/);
  const assets = await readdir(new URL('../dist/dashboard/assets/', import.meta.url));
  assert.equal(assets.some((name) => name.endsWith('.map')), false);
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

test('dashboard edits require a valid optimistic-concurrency precondition before database work', async () => {
  setServerTestOverrides({ validateKey: async () => ordinary });
  const path = '/api/memories/00000000-0000-4000-8000-000000000001';
  const missing = await request(app).patch(path).set('Authorization', token).send({ tags: [] });
  assert.equal(missing.status, 428);
  assert.match(missing.body.error, /If-Match/);

  const malformed = await request(app).patch(path).set('Authorization', token).set('If-Match', 'yesterday').send({ tags: [] });
  assert.equal(malformed.status, 400);
  assert.match(malformed.body.error, /If-Match/);
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
