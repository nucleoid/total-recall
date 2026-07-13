import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import type express from 'express';
import request from 'supertest';
import type { AuthContext } from '../src/types.js';

let app: express.Express;
let createApp: () => express.Express;
let setServerTestOverrides: (overrides: {
  validateKey?: (apiKey: string) => Promise<AuthContext | null>;
}) => void;

before(async () => {
  process.env.NODE_ENV = 'test';
  ({ app, createApp, setServerTestOverrides } = await import('../src/server.ts'));
});

test('schema-valid 100k memory content reaches authentication for every JSON encoding shape', async () => {
  const cases = [
    'a'.repeat(100_000),
    '😀'.repeat(50_000),
    '\u0000'.repeat(100_000),
    '"\\'.repeat(50_000),
    '\ud800'.repeat(100_000),
  ];

  for (const content of cases) {
    assert.equal(content.length, 100_000);
    const response = await request(app).post('/api/store').send({ content });
    assert.equal(response.status, 401, `encoded bytes: ${Buffer.byteLength(JSON.stringify({ content }))}`);
  }
});

test('REST and MCP enforce the same exact 64 KiB metadata, depth, and key-count contract', async () => {
  const {
    METADATA_MAX_BYTES,
    METADATA_MAX_DEPTH,
    METADATA_MAX_KEYS,
    metadataSchema,
  } = await import('../src/http-limits.js');

  assert.equal(METADATA_MAX_BYTES, 64 * 1024);
  assert.equal(typeof metadataSchema?.safeParse, 'function');
  const nestedFieldNamedMetadata = { schema: 'v2', metadata: 'freeform note' };
  assert.equal(metadataSchema.safeParse(nestedFieldNamedMetadata).success, true);
  assert.equal((await request(app).post('/api/store').send({ content: 'x', metadata: nestedFieldNamedMetadata })).status, 401);

  const exact = { x: 'a'.repeat(METADATA_MAX_BYTES - Buffer.byteLength(JSON.stringify({ x: '' }))) };
  const over = { x: `${exact.x}a` };
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 64 * 1024);
  assert.equal(metadataSchema.safeParse(exact).success, true);
  assert.equal(metadataSchema.safeParse(over).success, false);

  let atDepth: unknown = 'leaf';
  for (let i = 0; i < METADATA_MAX_DEPTH; i++) atDepth = { child: atDepth };
  assert.equal(metadataSchema.safeParse(atDepth).success, true);
  assert.equal(metadataSchema.safeParse({ child: atDepth }).success, false);

  const atKeyCount = Object.fromEntries(Array.from({ length: METADATA_MAX_KEYS }, (_, i) => [`k${i}`, i]));
  assert.equal(metadataSchema.safeParse(atKeyCount).success, true);
  assert.equal(metadataSchema.safeParse({ ...atKeyCount, overflow: true }).success, false);

  for (const path of ['/api/store', '/mcp']) {
    const wrap = (metadata: object) => path === '/mcp'
      ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_store', arguments: { content: 'x', metadata } } }
      : { content: 'x', metadata };
    assert.equal((await request(app).post(path).send(wrap(exact))).status, 401);
    assert.equal((await request(app).post(path).send(wrap(over))).status, 400);
  }
});

test('metadata middleware ignores nested metadata keys in unknown request fields', async () => {
  const ignoredOversizedMetadata = { payload: 'x'.repeat(64 * 1024) };
  const requests = [
    request(app).post('/api/store').send({
      content: 'x',
      extra: { metadata: ignoredOversizedMetadata },
    }),
    request(app).post('/mcp').send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'memory_store',
        arguments: {
          content: 'x',
          extra: { metadata: ignoredOversizedMetadata },
        },
      },
    }),
  ];

  for (const pending of requests) {
    const response = await pending;
    assert.equal(response.status, 401);
    assert.notEqual(response.body.code, 'invalid_metadata');
  }
});

test('agent REST registration enforces the same bounded fields as MCP', async () => {
  setServerTestOverrides({
    validateKey: async () => ({
      keyId: 'agent-field-limit-test',
      name: 'agent field limit test',
      namespaces: ['shared'],
      permissions: ['write'],
    }),
  });

  try {
    const response = await request(app)
      .post('/api/agents')
      .set('Authorization', 'Bearer tr_agent_field_limit_test')
      .send({ name: 'a'.repeat(513) });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'Invalid request');
  } finally {
    setServerTestOverrides({});
  }
});

test('media event metadata keeps its endpoint-specific compatibility contract', async () => {
  const oversizedForMemoryContract = {
    payload: 'x'.repeat(64 * 1024),
  };
  const response = await request(app).post('/api/media/events').send({
    events: [{
      service: 'test',
      event_type: 'play',
      title: 'Compatibility fixture',
      played_at: '2026-07-13T00:00:00Z',
      metadata: oversizedForMemoryContract,
    }],
  });

  assert.equal(response.status, 401);
  assert.notEqual(response.body.code, 'invalid_metadata');
});

test('parser failures and unsupported encodings return stable JSON without route invocation', async () => {
  assert.equal(typeof createApp, 'function');
  const isolatedApp = createApp();

  const malformed = await request(isolatedApp)
    .post('/api/store')
    .set('Content-Type', 'application/json')
    .send('{"content":');
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, { code: 'invalid_json' });

  const compressed = await request(isolatedApp)
    .post('/api/store')
    .set('Content-Type', 'application/json')
    .set('Content-Encoding', 'gzip')
    .send('{}');
  assert.equal(compressed.status, 415);
  assert.deepEqual(compressed.body, { code: 'unsupported_content_encoding' });

  const { JSON_BODY_LIMIT_BYTES } = await import('../src/http-limits.js');
  const server = isolatedApp.listen(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: address.port,
        path: '/api/store',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (part) => { body += part; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.write('{"content":"');
      const chunk = 'a'.repeat(64 * 1024);
      for (let sent = 0; sent <= JSON_BODY_LIMIT_BYTES; sent += chunk.length) req.write(chunk);
      req.end('"}');
    });
    assert.equal(result.status, 413);
    assert.deepEqual(JSON.parse(result.body), { code: 'payload_too_large' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('maximum valid document envelope fits transport and published limits equal code', async () => {
  const {
    DOCUMENT_TITLE_MAX_CHARS,
    METADATA_MAX_BYTES,
    METADATA_MAX_DEPTH,
    METADATA_MAX_KEYS,
    TAG_MAX_CHARS,
    TAG_MAX_COUNT,
  } = await import('../src/http-limits.js');
  const { MAX_DOCUMENT_CONTENT_BYTES } = await import('../src/tools/store-document.js');

  const metadataOverhead = Buffer.byteLength(JSON.stringify({ x: '' }));
  const body = {
    title: '\u0000'.repeat(DOCUMENT_TITLE_MAX_CHARS),
    content: '\u0000'.repeat(MAX_DOCUMENT_CONTENT_BYTES),
    tags: Array.from({ length: TAG_MAX_COUNT }, () => '\u0000'.repeat(TAG_MAX_CHARS)),
    metadata: { x: 'a'.repeat(METADATA_MAX_BYTES - metadataOverhead) },
  };
  const encodedBytes = Buffer.byteLength(JSON.stringify(body));
  assert.ok(encodedBytes < 8 * 1024 * 1024, `maximum envelope is ${encodedBytes} bytes`);
  assert.equal((await request(app).post('/api/store-document').send(body)).status, 401);

  const [openapi, readme] = await Promise.all([
    readFile(new URL('../openapi.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
  ]);
  for (const contract of [
    '100,000 JavaScript characters',
    `${MAX_DOCUMENT_CONTENT_BYTES} UTF-8 bytes`,
    `${METADATA_MAX_BYTES} serialized JSON bytes`,
    `depth ${METADATA_MAX_DEPTH}`,
    `${METADATA_MAX_KEYS} keys`,
    `${TAG_MAX_COUNT} tags`,
    `${TAG_MAX_CHARS} JavaScript characters per tag`,
    '8 MiB',
  ]) {
    assert.match(openapi, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(readme, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(openapi, /payload_too_large/);
  assert.match(openapi, /invalid_json/);
  assert.match(openapi, /unsupported_content_encoding/);
  assert.match(openapi, /InvalidRequest:/);
  assert.match(openapi, /enum: \[invalid_json, invalid_metadata\]/);
  assert.match(openapi, /required: \[code\]/);
  assert.match(readme, /invalid_metadata/);

  const searchContract = openapi.slice(openapi.indexOf('  \/api\/search:'), openapi.indexOf('  \/api\/store:'));
  assert.match(searchContract, /"400":/);
  assert.match(searchContract, /"413":/);
  assert.match(searchContract, /"415":/);
  assert.match(openapi, /per-request metadata/i);
  assert.match(readme, /per-request metadata/i);
});
