import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import request from 'supertest';
import {
  app,
  setServerTestOverrides,
} from '../src/server.js';
import type { AuthContext } from '../src/types.js';

const token = 'Bearer tr_openapi_contract_test';

function auth(permissions: string[]): AuthContext {
  return {
    keyId: '00000000-0000-4000-8000-000000000001',
    name: 'openapi-contract',
    namespaces: ['shared', 'media'],
    permissions,
    maxAccessLevel: 'normal',
  };
}

afterEach(() => setServerTestOverrides({}));

test('health is public while every documented API operation requires bearer auth', async () => {
  const health = await request(app).get('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok', version: '1.0.0' });

  const operations: Array<['get' | 'post' | 'delete', string]> = [
    ['post', '/api/search'],
    ['post', '/api/store'],
    ['post', '/api/store-document'],
    ['delete', '/api/memories'],
    ['get', '/api/stats'],
    ['get', '/api/agents'],
    ['post', '/api/agents'],
    ['get', '/api/traces'],
    ['get', '/api/audit'],
    ['post', '/api/media/search'],
    ['get', '/api/media/events'],
    ['post', '/api/media/events'],
    ['post', '/api/media/rollup'],
  ];

  for (const [method, path] of operations) {
    const response = await (request(app) as any)[method](path).send({});
    assert.equal(response.status, 401, `${method.toUpperCase()} ${path}`);
  }
});

test('global observability and media administration require explicit admin permission', async () => {
  setServerTestOverrides({ validateKey: async () => auth(['read', 'write', 'delete']) });
  const operations: Array<['get' | 'post', string]> = [
    ['get', '/api/stats'],
    ['get', '/api/agents'],
    ['post', '/api/agents'],
    ['get', '/api/traces'],
    ['get', '/api/audit'],
    ['get', '/api/media/events'],
    ['post', '/api/media/events'],
    ['post', '/api/media/rollup'],
  ];

  for (const [method, path] of operations) {
    const body = method === 'post' && path === '/api/agents' ? { name: 'ordinary-agent' } : {};
    const response = await (request(app) as any)[method](path)
      .set('Authorization', token)
      .send(body);
    assert.equal(response.status, 403, `${method.toUpperCase()} ${path}`);
    assert.match(response.body.error, /admin/);
  }
});

test('shared Zod contracts reject invalid bodies and query coercions as 400', async () => {
  setServerTestOverrides({ validateKey: async () => auth(['admin', 'read', 'write', 'delete']) });

  const requests = [
    request(app).post('/api/search').set('Authorization', token).send({ query: 'x', after: 'yesterday' }),
    request(app).post('/api/store').set('Authorization', token).send({}),
    request(app).post('/api/store-document').set('Authorization', token).send({ title: 'missing content' }),
    request(app).delete('/api/memories').set('Authorization', token).send({}),
    request(app).post('/api/agents').set('Authorization', token).send({ name: '' }),
    request(app).get('/api/traces?limit=0').set('Authorization', token),
    request(app).get('/api/audit?offset=-1').set('Authorization', token),
    request(app).post('/api/media/search').set('Authorization', token).send({ query: 'x', played_after: 'not-a-date' }),
    request(app).get('/api/media/events?played_after=not-a-date').set('Authorization', token),
    request(app).post('/api/media/events').set('Authorization', token).send({ events: Array.from({ length: 501 }, () => ({
      service: 'test', event_type: 'play', title: 'x', played_at: '2026-07-16T00:00:00Z',
    })) }),
    request(app).post('/api/media/rollup').set('Authorization', token).send({ batch_size: 0 }),
  ];

  for (const pending of requests) {
    const response = await pending;
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(typeof response.body.error === 'string' || typeof response.body.code === 'string', true);
  }
});
