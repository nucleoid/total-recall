import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import dotenv from 'dotenv';
import { dbScopeFromAuth, shutdown } from './db.js';
import { checkPermission, validateKey } from './auth.js';
import type { AuthContext } from './types.js';
import { agentRegisterSchema, registerTools } from './tools/register.js';
import { memorySearch, searchSchema } from './tools/search.js';
import { memoryStore, storeSchema } from './tools/store.js';
import {
  isStoreDocumentConflictError,
  memoryStoreDocument,
  storeDocumentSchema,
} from './tools/store-document.js';
import { memoryStats } from './tools/stats.js';
import { memoryForget } from './tools/forget.js';
import { isPublicApiError } from './errors.js';
import { mediaSearch, mediaSearchSchema } from './tools/media-search.js';
import { upsertAgent, listAgents } from './agents.js';
import { listTraces } from './traces.js';
import { listAudit } from './audit.js';
import { parsePublicMediaEventBatch, toTrustedRestMediaEvents, upsertMediaEvents, listMediaEvents } from './media.js';
import { rollupPendingEvents } from './rollup.js';
import { JSON_BODY_LIMIT_BYTES, validateMetadataInRequest } from './http-limits.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3002', 10);

// Store transports by session ID
interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  boundKeyId: string;
  boundApiKey: string;
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

  if (!sessionId || !record || record.boundKeyId !== auth.keyId || record.closing) {
    if (responseType === 'json') {
      sendPostNoValidSession(res);
    } else {
      res.status(400).send('Invalid or missing session ID');
    }
    return null;
  }

  return record;
}

const METADATA_CONTRACT_REST_PATHS = new Set([
  '/api/store',
  '/api/store-document',
  '/api/agents',
]);
const METADATA_CONTRACT_MCP_TOOLS = new Set([
  'memory_store',
  'memory_store_document',
  'agent_register',
]);

function metadataContractPayloads(req: express.Request): unknown[] {
  if (req.method !== 'POST') return [];
  if (METADATA_CONTRACT_REST_PATHS.has(req.path)) return [req.body];
  if (req.path !== '/mcp') return [];

  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const payloads: unknown[] = [];
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    const params = (message as { params?: unknown }).params;
    if (params === null || typeof params !== 'object') continue;
    const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
    if (typeof name === 'string' && METADATA_CONTRACT_MCP_TOOLS.has(name)) {
      payloads.push(args);
    }
  }
  return payloads;
}

export function createApp(): express.Express {
const app = express();
app.use((req, res, next) => {
  const encoding = req.headers['content-encoding'];
  if (encoding !== undefined && String(encoding).trim().toLowerCase() !== 'identity') {
    res.status(415).json({ code: 'unsupported_content_encoding' });
    return;
  }
  next();
});
app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES, inflate: false }));
app.use((req, res, next) => {
  if (metadataContractPayloads(req).some((payload) => !validateMetadataInRequest(payload))) {
    res.status(400).json({ code: 'invalid_metadata' });
    return;
  }
  next();
});

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
      const boundApiKey = extractApiKey(req);
      if (!boundApiKey) {
        sendPostUnauthorized(res);
        return;
      }
      let record: SessionRecord | null = null;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          record = {
            transport,
            boundKeyId: authContext.keyId,
            boundApiKey,
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
        if (!record || record.closing) {
          throw new Error('MCP session is not initialized');
        }
        const freshAuth = await keyValidator(record.boundApiKey);
        if (!freshAuth || freshAuth.keyId !== record.boundKeyId) {
          throw new Error('Invalid API key');
        }
        return freshAuth;
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
  } else if (isPublicApiError(err)) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
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
    res.json({
      id: result.id,
      created: true,
      ...(result.idempotency_key_honored && { idempotency_key_honored: true }),
    });
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

app.delete('/api/memories', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const result = await memoryForget(req.body, auth);
    res.json(result);
  } catch (err: any) {
    sendApiError(res, '/api/memories DELETE', err);
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
    const params = agentRegisterSchema.parse(req.body);
    const result = await upsertAgent({
      ...params,
      api_key_id: auth.keyId,
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
    const events = parsePublicMediaEventBatch(req.body);
    const enriched = toTrustedRestMediaEvents(events, auth);
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

app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const parserError = err as { type?: unknown; status?: unknown; body?: unknown };
  if (parserError.type === 'entity.too.large' || parserError.status === 413) {
    res.status(413).json({ code: 'payload_too_large' });
    return;
  }
  if (parserError.type === 'entity.parse.failed' ||
      (err instanceof SyntaxError && parserError.status === 400 && 'body' in parserError)) {
    res.status(400).json({ code: 'invalid_json' });
    return;
  }
  next(err);
});

return app;
}

export const app = createApp();

async function closeAllSessions(): Promise<void> {
  for (const [sid, record] of sessions) {
    record.closing = true;
    await record.transport.close();
    sessions.delete(sid);
  }
  await shutdown();
}

const isDirectExecution = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  app.listen(PORT, () => {
    console.error(`[total-recall] HTTP server listening on port ${PORT}`);
  });

  process.on('SIGINT', async () => {
    console.error('[total-recall] Shutting down HTTP server...');
    await closeAllSessions();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await closeAllSessions();
    process.exit(0);
  });
}
