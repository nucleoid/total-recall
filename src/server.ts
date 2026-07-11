import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import dotenv from 'dotenv';
import { shutdown, setNamespaceContext, query } from './db.js';
import { validateKey } from './auth.js';
import type { AuthContext } from './types.js';
import { registerTools } from './tools/register.js';
import { memorySearch, searchSchema } from './tools/search.js';
import { memoryStore, storeSchema } from './tools/store.js';
import { memoryStoreDocument, storeDocumentSchema } from './tools/store-document.js';
import { memoryStats } from './tools/stats.js';
import { mediaSearch, mediaSearchSchema } from './tools/media-search.js';
import { upsertAgent, listAgents } from './agents.js';
import { listTraces } from './traces.js';
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

    if (sessionId) {
      const record = resolveOwnedSession(req, res, authContext, 'json');
      if (!record) return;
      await record.transport.handleRequest(req, res, req.body);
    } else if (!sessionId && isInitializeRequest(req.body)) {
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

    record.closing = true;
    await record.transport.handleRequest(req, res);
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
  await setNamespaceContext(auth.namespaces);
  return auth;
}

app.post('/api/search', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const params = searchSchema.parse(req.body);
    const results = await memorySearch(params, auth);
    res.json({ results });
  } catch (err: any) {
    if (err.name === 'ZodError') {
      res.status(400).json({ error: 'Invalid request', details: err.errors });
    } else {
      console.error('[total-recall] /api/search error:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
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
    if (err.name === 'ZodError') {
      res.status(400).json({ error: 'Invalid request', details: err.errors });
    } else {
      console.error('[total-recall] /api/store error:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
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
    if (err.name === 'ZodError') {
      res.status(400).json({ error: 'Invalid request', details: err.errors });
    } else {
      console.error('[total-recall] /api/store-document error:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const result = await memoryStats({}, auth);
    res.json(result);
  } catch (err: any) {
    console.error('[total-recall] /api/stats error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.get('/api/agents', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const result = await listAgents();
    res.json({ agents: result });
  } catch (err: any) {
    console.error('[total-recall] /api/agents error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/api/agents', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
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
    });
    res.json(result);
  } catch (err: any) {
    console.error('[total-recall] /api/agents POST error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.get('/api/traces', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const agentId = req.query.agent_id as string | undefined;
    const sessionId = req.query.session_id as string | undefined;
    const result = await listTraces(limit, offset, agentId, sessionId);
    res.json({ traces: result });
  } catch (err: any) {
    console.error('[total-recall] /api/traces error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.get('/api/audit', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const action = req.query.action as string | undefined;
    const agentId = req.query.agent_id as string | undefined;

    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 0;
    const p = (v: unknown) => { values.push(v); return `$${++idx}`; };

    if (action) conditions.push(`action = ${p(action)}`);
    if (agentId) conditions.push(`agent_id = ${p(agentId)}`);

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await query(
      `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ${p(limit)} OFFSET ${p(offset)}`,
      values
    );
    res.json({ audit: result.rows });
  } catch (err: any) {
    console.error('[total-recall] /api/audit error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
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
    if (err.name === 'ZodError') {
      res.status(400).json({ error: 'Invalid request', details: err.errors });
    } else {
      console.error('[total-recall] /api/media/search error:', err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  }
});

app.post('/api/media/events', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const body = req.body as { events?: MediaEventInput[] };
    if (!Array.isArray(body.events)) {
      res.status(400).json({ error: 'events array required' });
      return;
    }
    const enriched = body.events.map((e) => ({
      ...e,
      client_id: e.client_id ?? auth.keyId,
    }));
    const result = await upsertMediaEvents(enriched);
    res.json(result);
  } catch (err: any) {
    console.error('[total-recall] /api/media/events error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.get('/api/media/events', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 500);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const events = await listMediaEvents({
      service: req.query.service as string | undefined,
      event_type: req.query.event_type as string | undefined,
      played_after: req.query.played_after as string | undefined,
      played_before: req.query.played_before as string | undefined,
      limit,
      offset,
    });
    res.json({ events });
  } catch (err: any) {
    console.error('[total-recall] /api/media/events GET error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.post('/api/media/rollup', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, res);
    if (!auth) return;
    const batchSize = Math.min(parseInt((req.body?.batch_size as string) ?? '50', 10) || 50, 500);
    const result = await rollupPendingEvents(batchSize);
    res.json(result);
  } catch (err: any) {
    console.error('[total-recall] /api/media/rollup error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
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
