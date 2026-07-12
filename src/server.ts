import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import dotenv from 'dotenv';
import { dbScopeFromAuth, shutdown } from './db.js';
import { checkPermission, validateKey } from './auth.js';
import type { AuthContext } from './types.js';
import { registerTools } from './tools/register.js';
import { memorySearch, searchSchema } from './tools/search.js';
import { memoryStore, storeSchema } from './tools/store.js';
import {
  isStoreDocumentConflictError,
  memoryStoreDocument,
  storeDocumentSchema,
} from './tools/store-document.js';
import { memoryStats } from './tools/stats.js';
import { mediaSearch, mediaSearchSchema } from './tools/media-search.js';
import { upsertAgent, listAgents } from './agents.js';
import { listTraces } from './traces.js';
import { listAudit } from './audit.js';
import { upsertMediaEvents, listMediaEvents, type MediaEventInput } from './media.js';
import { rollupPendingEvents } from './rollup.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3002', 10);

// Store transports by session ID
interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  keyId: string;
  auth: AuthContext;
  closing: boolean;
}

const sessions = new Map<string, SessionRecord>();
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ValidateKey = typeof validateKey;
type RegisterTools = typeof registerTools;

let keyValidator: ValidateKey = validateKey;
let toolRegistrar: RegisterTools = registerTools;

export function setServerTestOverrides(overrides: {
  validateKey?: ValidateKey;
  registerTools?: RegisterTools;
}): void {
  keyValidator = overrides.validateKey ?? validateKey;
  toolRegistrar = overrides.registerTools ?? registerTools;
}

export async function resetServerTestState(): Promise<void> {
  const records = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(records.map((record) => record.transport.close()));
}

function createServer(getAuth: () => Promise<AuthContext>): Server {
  const server = new Server(
    { name: 'total-recall', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  toolRegistrar(server, getAuth);
  return server;
}

function extractApiKey(req: express.Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  const key = auth.slice(7);
  if (!key.startsWith('tr_')) return null;
  return key;
}

function extractSessionId(req: express.Request): string | undefined | null {
  const header = req.headers['mcp-session-id'];
  if (header === undefined) return undefined;
  if (Array.isArray(header)) return null;

  const sessionId = header.trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  return sessionId;
}

function sendPostUnauthorized(res: express.Response): void {
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Unauthorized: missing or invalid API key' },
    id: null,
  });
}

function sendPostForbidden(res: express.Response): void {
  res.status(403).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Forbidden: invalid API key' },
    id: null,
  });
}

function sendPostNoValidSession(res: express.Response): void {
  res.status(400).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Bad Request: no valid session ID' },
    id: null,
  });
}

function sendPostInternalError(res: express.Response): void {
  res.status(500).json({
    jsonrpc: '2.0',
    error: { code: -32603, message: 'Internal server error' },
    id: null,
  });
}

function safelyEndResponse(res: express.Response): void {
  if (res.headersSent && !res.writableEnded) {
    res.end();
  }
}

async function closeSessionRecord(record: SessionRecord): Promise<void> {
  record.closing = true;
  const sid = record.transport.sessionId;
  if (sid && sessions.get(sid) === record) {
    sessions.delete(sid);
  }
  try {
    await record.transport.close();
  } catch (error) {
    console.error('[total-recall] MCP session close error:', error);
  }
}

async function authenticateMcpRequest(
  req: express.Request,
  res: express.Response,
  responseType: 'json' | 'text'
): Promise<AuthContext | null> {
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    if (responseType === 'json') {
      sendPostUnauthorized(res);
    } else {
      res.status(401).send('Unauthorized');
    }
    return null;
  }

  const authContext = await keyValidator(apiKey);
  if (!authContext) {
    if (responseType === 'json') {
      sendPostForbidden(res);
    } else {
      res.status(403).send('Forbidden');
    }
    return null;
  }

  return authContext;
}

function resolveOwnedSession(
  req: express.Request,
  res: express.Response,
  auth: AuthContext,
  responseType: 'json' | 'text'
): SessionRecord | null {
  const sessionId = extractSessionId(req);
  const record = sessionId ? sessions.get(sessionId) : undefined;

  if (!sessionId || !record || record.keyId !== auth.keyId || record.closing) {
    if (responseType === 'json') {
      sendPostNoValidSession(res);
    } else {
      res.status(400).send('Invalid or missing session ID');
    }
    return null;
  }

  record.auth = auth;
  return record;
}

export const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// MCP endpoint - POST
app.post('/mcp', async (req, res) => {
  try {
    const authContext = await authenticateMcpRequest(req, res, 'json');
    if (!authContext) return;

    const sessionId = extractSessionId(req);

    if (sessionId !== undefined) {
      const record = resolveOwnedSession(req, res, authContext, 'json');
      if (!record) return;
      await record.transport.handleRequest(req, res, req.body);
    } else if (isInitializeRequest(req.body)) {
      // New session
      let record: SessionRecord | null = null;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          record = {
            transport,
            keyId: authContext.keyId,
            auth: authContext,
            closing: false,
          };
          sessions.set(sid, record);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && record && sessions.get(sid) === record) {
          record.closing = true;
          sessions.delete(sid);
        }
      };

      const server = createServer(async () => {
        if (!record) {
          throw new Error('MCP session is not initialized');
        }
        return record.auth;
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } else {
      sendPostNoValidSession(res);
    }
  } catch (error) {
    console.error('[total-recall] HTTP error:', error);
    if (!res.headersSent) {
      sendPostInternalError(res);
    } else {
      safelyEndResponse(res);
    }
  }
});

// MCP endpoint - GET (SSE stream)
app.get('/mcp', async (req, res) => {
  try {
    const authContext = await authenticateMcpRequest(req, res, 'text');
    if (!authContext) return;

    const record = resolveOwnedSession(req, res, authContext, 'text');
    if (!record) return;

    await record.transport.handleRequest(req, res);
  } catch (error) {
    console.error('[total-recall] HTTP SSE error:', error);
    if (!res.headersSent) {
      res.status(500).send('Internal server error');
    } else {
      safelyEndResponse(res);
    }
  }
});

// MCP endpoint - DELETE (session termination)
app.delete('/mcp', async (req, res) => {
  try {
    const authContext = await authenticateMcpRequest(req, res, 'text');
    if (!authContext) return;

    const record = resolveOwnedSession(req, res, authContext, 'text');
    if (!record) return;

    try {
      record.closing = true;
      await record.transport.handleRequest(req, res);
    } finally {
      await closeSessionRecord(record);
    }
  } catch (error) {
    console.error('[total-recall] HTTP DELETE error:', error);
    if (!res.headersSent) {
      res.status(500).send('Internal server error');
    } else {
      safelyEndResponse(res);
    }
  }
});


// ── REST API routes (for Custom GPT / OpenAPI consumers) ──

async function authenticateRequest(req: express.Request, res: express.Response): Promise<AuthContext | null> {
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    res.status(401).json({ error: 'Unauthorized: missing or invalid API key' });
    return null;
  }
  const auth = await keyValidator(apiKey);
  if (!auth) {
    res.status(403).json({ error: 'Forbidden: invalid API key' });
    return null;
  }
  return auth;
}

function permissionDenied(err: any): boolean {
  const message = err?.message ?? '';
  return (
    typeof message === 'string' &&
    (message.startsWith('Permission denied') ||
      message.startsWith('Access denied') ||
      message.includes('admin-only'))
  );
}

function sendApiError(res: express.Response, label: string, err: any): void {
  if (err.name === 'ZodError') {
    res.status(400).json({ error: 'Invalid request', details: err.errors });
  } else if (typeof err.message === 'string' && err.message.startsWith('Invalid ')) {
    res.status(400).json({ error: err.message });
  } else if (isStoreDocumentConflictError(err)) {
    res.status(409).json({ error: err.message });
  } else if (permissionDenied(err)) {
    res.status(403).json({ error: err.message });
  } else {
    console.error(`[total-recall] ${label} error:`, err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

function parseBoundedInteger(raw: unknown, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function parseUuid(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  const value = String(raw);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function parseDateFilter(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  const value = String(raw);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function parseSingleString(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw) || typeof raw !== 'string') {
    throw new Error(`Invalid ${name}`);
  }
  return raw;
}

app.post('/api/search', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const params = searchSchema.parse(req.body);
    const results = await memorySearch(params, auth);
    res.json({ results });
  } catch (err: any) {
    sendApiError(res, '/api/search', err);
  }
});

app.post('/api/store', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const params = storeSchema.parse(req.body);
    const result = await memoryStore(params, auth);
    res.json({ id: result.id, created: true });
  } catch (err: any) {
    sendApiError(res, '/api/store', err);
  }
});

app.post('/api/store-document', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const params = storeDocumentSchema.parse(req.body);
    const result = await memoryStoreDocument(params, auth);
    res.json({ id: result.document_id, chunks: result.chunks_stored });
  } catch (err: any) {
    sendApiError(res, '/api/store-document', err);
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const result = await memoryStats({}, auth);
    res.json(result);
  } catch (err: any) {
    sendApiError(res, '/api/stats', err);
  }
});

app.get('/api/agents', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'read');
    const result = await listAgents(auth, dbScopeFromAuth(auth));
    res.json({ agents: result });
  } catch (err: any) {
    sendApiError(res, '/api/agents', err);
  }
});

app.post('/api/agents', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'write');
    const { name, type, model, runtime, parent_agent_name, metadata } = req.body;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const result = await upsertAgent({
      name,
      type,
      model,
      runtime,
      parent_agent_name,
      api_key_id: auth.keyId,
      metadata,
    }, dbScopeFromAuth(auth));
    res.json(result);
  } catch (err: any) {
    sendApiError(res, '/api/agents POST', err);
  }
});

app.get('/api/traces', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'read');
    const limit = parseBoundedInteger(req.query.limit, 20, 1, 100, 'limit');
    const offset = parseBoundedInteger(req.query.offset, 0, 0, 10_000, 'offset');
    const agentId = parseUuid(req.query.agent_id, 'agent_id');
    const sessionId = parseSingleString(req.query.session_id, 'session_id');
    const result = await listTraces(auth, dbScopeFromAuth(auth), limit, offset, agentId, sessionId);
    res.json({ traces: result });
  } catch (err: any) {
    sendApiError(res, '/api/traces', err);
  }
});

app.get('/api/audit', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'read');
    const limit = parseBoundedInteger(req.query.limit, 50, 1, 200, 'limit');
    const offset = parseBoundedInteger(req.query.offset, 0, 0, 10_000, 'offset');
    const action = parseSingleString(req.query.action, 'action');
    const agentId = parseUuid(req.query.agent_id, 'agent_id');
    const result = await listAudit(auth, dbScopeFromAuth(auth), { limit, offset, action, agentId });
    res.json({ audit: result });
  } catch (err: any) {
    sendApiError(res, '/api/audit', err);
  }
});

// === Media endpoints ===

app.post('/api/media/search', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const params = mediaSearchSchema.parse(req.body);
    const results = await mediaSearch(params, auth);
    res.json({ results });
  } catch (err: any) {
    sendApiError(res, '/api/media/search', err);
  }
});

app.post('/api/media/events', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'write');
    const body = req.body as { events?: MediaEventInput[] };
    if (!Array.isArray(body.events)) {
      res.status(400).json({ error: 'events array required' });
      return;
    }
    const enriched = body.events.map((e) => ({
      ...e,
      client_id: auth.keyId,
    }));
    const result = await upsertMediaEvents(enriched, dbScopeFromAuth(auth));
    res.json(result);
  } catch (err: any) {
    sendApiError(res, '/api/media/events', err);
  }
});

app.get('/api/media/events', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'read');
    const limit = parseBoundedInteger(req.query.limit, 50, 1, 500, 'limit');
    const offset = parseBoundedInteger(req.query.offset, 0, 0, 10_000, 'offset');
    const events = await listMediaEvents(auth, dbScopeFromAuth(auth), {
      service: parseSingleString(req.query.service, 'service'),
      event_type: parseSingleString(req.query.event_type, 'event_type'),
      played_after: parseDateFilter(req.query.played_after, 'played_after'),
      played_before: parseDateFilter(req.query.played_before, 'played_before'),
      limit,
      offset,
    });
    res.json({ events });
  } catch (err: any) {
    sendApiError(res, '/api/media/events GET', err);
  }
});

app.post('/api/media/rollup', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const batchSize = parseBoundedInteger(req.body?.batch_size, 50, 1, 500, 'batch_size');
    const result = await rollupPendingEvents(auth, dbScopeFromAuth(auth), batchSize);
    res.json(result);
  } catch (err: any) {
    sendApiError(res, '/api/media/rollup', err);
  }
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.error(`[total-recall] HTTP server listening on port ${PORT}`);
  });
}

process.on('SIGINT', async () => {
  console.error('[total-recall] Shutting down HTTP server...');
  for (const [sid, record] of sessions) {
    record.closing = true;
    await record.transport.close();
    sessions.delete(sid);
  }
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  for (const [sid, record] of sessions) {
    record.closing = true;
    await record.transport.close();
    sessions.delete(sid);
  }
  await shutdown();
  process.exit(0);
});
