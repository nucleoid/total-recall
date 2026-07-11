import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';
import type express from 'express';
import request from 'supertest';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AuthContext } from '../src/types.js';

type AuthResolver = () => Promise<AuthContext>;

const authByToken = new Map<string, AuthContext | null>();
const toolAuthCalls: AuthContext[] = [];
let app: express.Express;
let resetServerTestState: () => Promise<void>;

function registerTestTools(server: Server, getAuth: AuthResolver): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'whoami',
        description: 'Return the current auth context.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async () => {
    const auth = await getAuth();
    toolAuthCalls.push(auth);
    return {
      content: [{ type: 'text', text: JSON.stringify(auth) }],
    };
  });
}

async function validateKey(apiKey: string): Promise<AuthContext | null> {
  return authByToken.get(apiKey) ?? null;
}

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function initializeRequest(id = 1): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0.0' },
    },
  };
}

function initializedNotification(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  };
}

function callWhoamiRequest(id = 2): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'whoami',
      arguments: {},
    },
  };
}

before(async () => {
  process.env.NODE_ENV = 'test';
  const server = await import('../src/server.ts');
  server.setServerTestOverrides({
    validateKey,
    registerTools: registerTestTools,
  });
  app = server.app;
  resetServerTestState = server.resetServerTestState;
});

beforeEach(async () => {
  await resetServerTestState();
  authByToken.clear();
  toolAuthCalls.length = 0;
});

function seedKeys(): void {
  authByToken.set('tr_key_a', {
    keyId: 'key-a',
    name: 'key A',
    namespaces: ['alpha'],
    permissions: ['read'],
  });
  authByToken.set('tr_key_b', {
    keyId: 'key-b',
    name: 'key B',
    namespaces: ['beta'],
    permissions: ['read'],
  });
}

async function createInitializedSession(): Promise<string> {
  const init = await request(app)
    .post('/mcp')
    .set('Authorization', bearer('tr_key_a'))
    .set('Accept', 'application/json, text/event-stream')
    .send(initializeRequest());

  assert.equal(init.status, 200);
  const sessionId = init.headers['mcp-session-id'];
  assert.equal(typeof sessionId, 'string');

  await request(app)
    .post('/mcp')
    .set('Authorization', bearer('tr_key_a'))
    .set('mcp-session-id', sessionId)
    .set('Accept', 'application/json, text/event-stream')
    .send(initializedNotification())
    .expect(202);

  return sessionId;
}

function parseToolAuth(response: request.Response): AuthContext {
  const body = response.body.result
    ? response.body
    : JSON.parse(response.text.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
  const text = body.result.content[0].text;
  return JSON.parse(text) as AuthContext;
}

test('MCP sessions cannot be reused by another valid API key', async () => {
  assert.ok(app, 'server app was captured');
  seedKeys();
  const sessionId = await createInitializedSession();

  const randomSession = '11111111-1111-4111-8111-111111111111';
  const unknown = await request(app)
    .post('/mcp')
    .set('Authorization', bearer('tr_key_b'))
    .set('mcp-session-id', randomSession)
    .set('Accept', 'application/json, text/event-stream')
    .send(callWhoamiRequest());

  const hijack = await request(app)
    .post('/mcp')
    .set('Authorization', bearer('tr_key_b'))
    .set('mcp-session-id', sessionId)
    .set('Accept', 'application/json, text/event-stream')
    .send(callWhoamiRequest());

  assert.equal(hijack.status, unknown.status);
  assert.deepEqual(hijack.body, unknown.body);
  assert.equal(toolAuthCalls.length, 0);
});

test('MCP session ownership is enforced for SSE and DELETE without enumeration', async () => {
  seedKeys();
  const sessionId = await createInitializedSession();
  const randomSession = '11111111-1111-4111-8111-111111111111';

  const unknownSse = await request(app)
    .get('/mcp')
    .set('Authorization', bearer('tr_key_b'))
    .set('mcp-session-id', randomSession)
    .set('Accept', 'text/event-stream');

  const hijackSse = await request(app)
    .get('/mcp')
    .set('Authorization', bearer('tr_key_b'))
    .set('mcp-session-id', sessionId)
    .set('Accept', 'text/event-stream');

  assert.equal(hijackSse.status, unknownSse.status);
  assert.equal(hijackSse.text, unknownSse.text);

  const unknownDelete = await request(app)
    .delete('/mcp')
    .set('Authorization', bearer('tr_key_b'))
    .set('mcp-session-id', randomSession);

  const hijackDelete = await request(app)
    .delete('/mcp')
    .set('Authorization', bearer('tr_key_b'))
    .set('mcp-session-id', sessionId);

  assert.equal(hijackDelete.status, unknownDelete.status);
  assert.equal(hijackDelete.text, unknownDelete.text);
  assert.equal(toolAuthCalls.length, 0);
});

test('MCP initialize rejects malformed and duplicate session headers', async () => {
  seedKeys();

  const malformed = await request(app)
    .post('/mcp')
    .set('Authorization', bearer('tr_key_a'))
    .set('mcp-session-id', 'not-a-session-id')
    .set('Accept', 'application/json, text/event-stream')
    .send(initializeRequest())
    .expect(400);

  assert.equal(malformed.headers['mcp-session-id'], undefined);

  const duplicate = await request(app)
    .post('/mcp')
    .set('Authorization', bearer('tr_key_a'))
    .set('mcp-session-id', [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ])
    .set('Accept', 'application/json, text/event-stream')
    .send(initializeRequest())
    .expect(400);

  assert.equal(duplicate.headers['mcp-session-id'], undefined);
});

test('MCP session owner can POST and receives refreshed auth on each request', async () => {
  seedKeys();
  const sessionId = await createInitializedSession();

  authByToken.set('tr_key_a', {
    keyId: 'key-a',
    name: 'key A refreshed',
    namespaces: ['gamma'],
    permissions: ['read', 'admin'],
  });

  const response = await request(app)
    .post('/mcp')
    .set('Authorization', bearer('tr_key_a'))
    .set('mcp-session-id', sessionId)
    .set('Accept', 'application/json, text/event-stream')
    .send(callWhoamiRequest())
    .expect(200);

  assert.deepEqual(parseToolAuth(response), {
    keyId: 'key-a',
    name: 'key A refreshed',
    namespaces: ['gamma'],
    permissions: ['read', 'admin'],
  });
});

test('MCP session creator disablement rejects the next request before tools run', async () => {
  seedKeys();
  const sessionId = await createInitializedSession();
  authByToken.set('tr_key_a', null);

  await request(app)
    .post('/mcp')
    .set('Authorization', bearer('tr_key_a'))
    .set('mcp-session-id', sessionId)
    .set('Accept', 'application/json, text/event-stream')
    .send(callWhoamiRequest())
    .expect(403);

  assert.equal(toolAuthCalls.length, 0);
});

test('MCP session owner can DELETE and the closed session rejects later POSTs', async () => {
  seedKeys();
  const sessionId = await createInitializedSession();

  await request(app)
    .delete('/mcp')
    .set('Authorization', bearer('tr_key_a'))
    .set('mcp-session-id', sessionId)
    .expect(200);

  await request(app)
    .post('/mcp')
    .set('Authorization', bearer('tr_key_a'))
    .set('mcp-session-id', sessionId)
    .set('Accept', 'application/json, text/event-stream')
    .send(callWhoamiRequest())
    .expect(400);

  assert.equal(toolAuthCalls.length, 0);
});

test('MCP DELETE transport failures evict the closing session', async () => {
  seedKeys();
  const sessionId = await createInitializedSession();
  const originalHandleRequest = StreamableHTTPServerTransport.prototype.handleRequest;

  StreamableHTTPServerTransport.prototype.handleRequest = async function (
    this: StreamableHTTPServerTransport,
    req,
    res,
    body
  ) {
    if (req.method === 'DELETE') {
      throw new Error('forced DELETE failure');
    }
    return originalHandleRequest.call(this, req, res, body);
  };

  try {
    await request(app)
      .delete('/mcp')
      .set('Authorization', bearer('tr_key_a'))
      .set('mcp-session-id', sessionId)
      .expect(500);
  } finally {
    StreamableHTTPServerTransport.prototype.handleRequest = originalHandleRequest;
  }

  await request(app)
    .post('/mcp')
    .set('Authorization', bearer('tr_key_a'))
    .set('mcp-session-id', sessionId)
    .set('Accept', 'application/json, text/event-stream')
    .send(callWhoamiRequest())
    .expect(400);

  assert.equal(toolAuthCalls.length, 0);
});

test('MCP DELETE authenticates before session lookup', async () => {
  seedKeys();
  const sessionId = await createInitializedSession();

  await request(app)
    .delete('/mcp')
    .set('mcp-session-id', sessionId)
    .expect(401);

  authByToken.set('tr_invalid', null);
  await request(app)
    .delete('/mcp')
    .set('Authorization', bearer('tr_invalid'))
    .set('mcp-session-id', sessionId)
    .expect(403);
});
