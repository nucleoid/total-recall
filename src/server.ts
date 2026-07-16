import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import dotenv from 'dotenv';
import { shutdownContradictionRuntime } from './contradictions.js';
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
import { memoryUpdate } from './tools/update.js';
import { isPublicApiError } from './errors.js';
import { mediaSearch, mediaSearchSchema } from './tools/media-search.js';
import { upsertAgent, listAgents } from './agents.js';
import { getTrace, listTraces } from './traces.js';
import { listAudit } from './audit.js';
import { getMediaStats, parsePublicMediaEventBatch, toTrustedRestMediaEvents, upsertMediaEvents, listMediaEvents } from './media.js';
import { getMemory, getMemorySummaries, listMemories } from './memories.js';
import { rollupPendingEvents } from './rollup.js';
import { JSON_BODY_LIMIT_BYTES, validateMetadataInRequest } from './http-limits.js';
import {
  auditQuerySchema,
  mediaEventsQuerySchema,
  mediaRollupSchema,
  mediaStatsQuerySchema,
  memoriesQuerySchema,
  tracesQuerySchema,
} from './http-schemas.js';

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
export type RestMethod = 'get' | 'post' | 'patch' | 'delete';

const restRouteInventory = new Set<string>();

function registerRestRoute(
  app: express.Express,
  method: RestMethod,
  path: string,
  ...handlers: express.RequestHandler[]
): void {
  const documentedPath = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  restRouteInventory.add(`${method.toUpperCase()} ${documentedPath}`);
  app[method](path, ...handlers);
}

/** Registration-derived method/path inventory used by the OpenAPI parity test. */
export function getRestRouteInventory(): string[] {
  return [...restRouteInventory].sort();
}

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
      res.status(401).type('text/plain').send('Unauthorized');
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
  'memory_update',
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
registerRestRoute(app, 'get', '/health', (_req, res) => {
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

function parseUuidParam(value: string | string[]): string {
  if (Array.isArray(value) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Invalid id: expected UUID');
  }
  return value.toLowerCase();
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
  } else if (isPublicApiError(err)) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
  } else if (isStoreDocumentConflictError(err)) {
    res.status(409).json({ error: err.message });
  } else if (permissionDenied(err)) {
    res.status(403).json({ error: err.message });
  } else {
    console.error(`[total-recall] ${label} error:`, err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

registerRestRoute(app, 'get', '/api/capabilities', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    res.json({
      name: auth.name,
      namespaces: auth.namespaces,
      max_access_level: auth.maxAccessLevel,
      capabilities: Object.fromEntries(
        ['read', 'write', 'delete', 'admin'].map((permission) => [permission, auth.permissions.includes(permission)])
      ),
    });
  } catch (err: any) {
    sendApiError(res, '/api/capabilities', err);
  }
});

registerRestRoute(app, 'post', '/api/search', async (req, res) => {
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

registerRestRoute(app, 'post', '/api/store', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const params = storeSchema.parse(req.body);
    const result = await memoryStore(params, auth);
    res.json({
      id: result.id,
      namespace: result.namespace,
      created: result.created,
      deduplicated: result.deduplicated,
      expires_at: result.expires_at,
      ...(result.similarity !== undefined && { similarity: result.similarity }),
      ...(result.idempotency_key_honored && { idempotency_key_honored: true }),
    });
  } catch (err: any) {
    sendApiError(res, '/api/store', err);
  }
});

registerRestRoute(app, 'post', '/api/store-document', async (req, res) => {
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

registerRestRoute(app, 'get', '/api/memories', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const params = memoriesQuerySchema.parse(req.query);
    res.json(await listMemories(auth, params));
  } catch (err: any) {
    sendApiError(res, '/api/memories GET', err);
  }
});

registerRestRoute(app, 'get', '/api/memories/:id', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const memory = await getMemory(auth, parseUuidParam(req.params.id));
    if (!memory) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }
    res.json({ memory });
  } catch (err: any) {
    sendApiError(res, '/api/memories/:id GET', err);
  }
});

registerRestRoute(app, 'patch', '/api/memories/:id', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const id = parseUuidParam(req.params.id);
    const ifMatch = req.headers['if-match'];
    if (ifMatch === undefined) {
      res.status(428).json({ error: 'If-Match with the memory updated_at value is required' });
      return;
    }
    if (Array.isArray(ifMatch)) {
      res.status(400).json({ error: 'Invalid If-Match precondition' });
      return;
    }
    const match = /^"([^"\r\n]+)"$/.exec(ifMatch);
    if (!match || !Number.isFinite(Date.parse(match[1]))) {
      res.status(400).json({ error: 'Invalid If-Match precondition' });
      return;
    }
    const memory = await memoryUpdate({ ...req.body, id }, auth, match[1]);
    res.json({ memory });
  } catch (err: any) {
    sendApiError(res, '/api/memories/:id PATCH', err);
  }
});

registerRestRoute(app, 'delete', '/api/memories', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const result = await memoryForget(req.body, auth);
    res.json(result);
  } catch (err: any) {
    sendApiError(res, '/api/memories DELETE', err);
  }
});

registerRestRoute(app, 'get', '/api/stats', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'admin');
    const result = await memoryStats({}, auth);
    res.json(result);
  } catch (err: any) {
    sendApiError(res, '/api/stats', err);
  }
});

registerRestRoute(app, 'get', '/api/agents', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'admin');
    checkPermission(auth, 'read');
    const result = await listAgents(auth, dbScopeFromAuth(auth));
    res.json({ agents: result });
  } catch (err: any) {
    sendApiError(res, '/api/agents', err);
  }
});

registerRestRoute(app, 'post', '/api/agents', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'write');
    const params = agentRegisterSchema.parse(req.body);
    checkPermission(auth, 'admin');
    const result = await upsertAgent({
      ...params,
      api_key_id: auth.keyId,
    }, dbScopeFromAuth(auth));
    res.json(result);
  } catch (err: any) {
    sendApiError(res, '/api/agents POST', err);
  }
});

registerRestRoute(app, 'get', '/api/traces', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'admin');
    checkPermission(auth, 'read');
    const params = tracesQuerySchema.parse(req.query);
    const result = await listTraces(
      auth,
      dbScopeFromAuth(auth),
      params.limit,
      params.offset,
      params.agent_id,
      params.session_id
    );
    res.json({ traces: result });
  } catch (err: any) {
    sendApiError(res, '/api/traces', err);
  }
});

registerRestRoute(app, 'get', '/api/traces/:id', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'admin');
    checkPermission(auth, 'read');
    const trace = await getTrace(auth, parseUuidParam(req.params.id), dbScopeFromAuth(auth));
    if (!trace) {
      res.status(404).json({ error: 'Trace not found' });
      return;
    }
    const memories = await getMemorySummaries(auth, trace.memory_ids ?? []);
    res.json({ trace, memories });
  } catch (err: any) {
    sendApiError(res, '/api/traces/:id', err);
  }
});

registerRestRoute(app, 'get', '/api/audit', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'admin');
    checkPermission(auth, 'read');
    const params = auditQuerySchema.parse(req.query);
    const result = await listAudit(auth, dbScopeFromAuth(auth), {
      limit: params.limit,
      offset: params.offset,
      action: params.action,
      agentId: params.agent_id,
    });
    res.json({ audit: result });
  } catch (err: any) {
    sendApiError(res, '/api/audit', err);
  }
});

// === Media endpoints ===

registerRestRoute(app, 'post', '/api/media/search', async (req, res) => {
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

registerRestRoute(app, 'post', '/api/media/events', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'admin');
    checkPermission(auth, 'write');
    const events = parsePublicMediaEventBatch(req.body);
    const enriched = toTrustedRestMediaEvents(events, auth);
    const result = await upsertMediaEvents(enriched, dbScopeFromAuth(auth));
    res.json(result);
  } catch (err: any) {
    sendApiError(res, '/api/media/events', err);
  }
});

registerRestRoute(app, 'get', '/api/media/events', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'admin');
    checkPermission(auth, 'read');
    const params = mediaEventsQuerySchema.parse(req.query);
    const events = await listMediaEvents(auth, dbScopeFromAuth(auth), params);
    res.json({ events });
  } catch (err: any) {
    sendApiError(res, '/api/media/events GET', err);
  }
});

registerRestRoute(app, 'get', '/api/media/stats', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'admin');
    checkPermission(auth, 'read');
    const params = mediaStatsQuerySchema.parse(req.query);
    res.json(await getMediaStats(auth, dbScopeFromAuth(auth), params));
  } catch (err: any) {
    sendApiError(res, '/api/media/stats', err);
  }
});

registerRestRoute(app, 'post', '/api/media/rollup', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    checkPermission(auth, 'admin');
    checkPermission(auth, 'write');
    const params = mediaRollupSchema.parse(req.body);
    const result = await rollupPendingEvents(auth, dbScopeFromAuth(auth), params.batch_size);
    res.json(result);
  } catch (err: any) {
    sendApiError(res, '/api/media/rollup', err);
  }
});

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const builtDashboardDirectory = resolve(process.cwd(), 'dist', 'dashboard');
const dashboardDirectory = existsSync(resolve(builtDashboardDirectory, 'index.html'))
  ? builtDashboardDirectory
  : resolve(moduleDirectory, 'dashboard');
const dashboardSecurity: express.RequestHandler = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
};
app.use('/dashboard', dashboardSecurity, express.static(dashboardDirectory, {
  index: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', filePath.includes(`${resolve(dashboardDirectory, 'assets')}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache');
  },
}));
app.get(/^\/dashboard\/assets(?:\/.*)?$/, dashboardSecurity, (_req, res) => {
  res.status(404).type('text/plain').send('Not Found');
});
app.get(/^\/dashboard(?:\/.*)?$/, dashboardSecurity, (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile('index.html', { root: dashboardDirectory });
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
  // Gate provider egress before awaiting any session close. The listener is
  // stopped by the signal handler first, but already-running REST stores also
  // observe this process-wide fail-closed gate.
  await shutdownContradictionRuntime();
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
  const httpServer = app.listen(PORT, () => {
    console.error(`[total-recall] HTTP server listening on port ${PORT}`);
  });

  process.on('SIGINT', async () => {
    console.error('[total-recall] Shutting down HTTP server...');
    httpServer.close();
    await closeAllSessions();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    httpServer.close();
    await closeAllSessions();
    process.exit(0);
  });
}
