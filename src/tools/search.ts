import { z } from 'zod';
import { hybridSearch } from '../search.js';
import { dbScopeFromAuth } from '../db.js';
import type { AuthContext, SearchResult } from '../types.js';
import { checkPermission, filterNamespaces } from '../auth.js';
import { resolveAgent } from '../agents.js';
import { logTrace } from '../traces.js';

export const searchSchema = z.object({
  query: z.string().min(1),
  namespaces: z.array(z.string()).optional(),
  limit: z.number().min(1).max(50).default(10),
  threshold: z.number().min(0).max(1).default(0.3),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  valid_at: z.string().datetime({ offset: true }).optional(),
  agent_name: z.string().optional(),
  session_id: z.string().optional(),
});

export async function memorySearch(
  params: z.infer<typeof searchSchema>,
  auth: AuthContext
): Promise<SearchResult[]> {
  checkPermission(auth, 'read');
  const namespaces = filterNamespaces(params.namespaces, auth.namespaces);
  if (namespaces.length === 0) {
    return [];
  }

  const explicitAgent = !!params.agent_name;
  const agentName = params.agent_name || auth.name;
  if (!explicitAgent) {
    console.warn(
      `[total-recall] memory_search called without agent_name; defaulting to api_key name "${auth.name}". ` +
      `Pass agent_name explicitly for accurate provenance.`
    );
  }
  const agentId = await resolveAgent(
    agentName,
    explicitAgent ? 'llm' : 'system',
    undefined,
    undefined,
    undefined,
    auth.keyId,
    dbScopeFromAuth(auth)
  );

  const start = Date.now();
  const results = await hybridSearch(params, namespaces, dbScopeFromAuth(auth), auth.maxAccessLevel);
  const durationMs = Date.now() - start;

  logTrace({
    sessionId: params.session_id,
    agentId,
    clientId: auth.keyId,
    queryText: params.query,
    memoryIds: results.map((r) => r.id),
    resultCount: results.length,
    scores: results.map((r) => ({ id: r.id, vec: r.vec_score, text: r.text_score, final: r.final_score })),
    durationMs,
  }, dbScopeFromAuth(auth)).catch((err) => console.error('[total-recall] trace log error:', err.message));

  return results;
}
