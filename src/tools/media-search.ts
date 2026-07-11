import { z } from 'zod';
import { hybridSearch } from '../search.js';
import type { AuthContext, SearchResult } from '../types.js';
import { checkPermission, filterNamespaces } from '../auth.js';
import { resolveAgent } from '../agents.js';
import { logTrace } from '../traces.js';

const MEDIA_NAMESPACE = 'media';

export const mediaSearchSchema = z.object({
  query: z.string().min(1),
  services: z.array(z.string()).optional(),
  event_types: z.array(z.string()).optional(),
  played_after: z.string().optional(),
  played_before: z.string().optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().min(1).max(50).default(10),
  threshold: z.number().min(0).max(1).default(0.3),
  agent_name: z.string().optional(),
  session_id: z.string().optional(),
});

export type MediaSearchParams = z.infer<typeof mediaSearchSchema>;

export async function mediaSearch(
  params: MediaSearchParams,
  auth: AuthContext
): Promise<SearchResult[]> {
  checkPermission(auth, 'read');

  const namespaces = filterNamespaces([MEDIA_NAMESPACE], auth.namespaces);
  if (namespaces.length === 0) return [];

  const combinedTags = new Set<string>(params.tags ?? []);
  for (const svc of params.services ?? []) combinedTags.add(svc);
  for (const et of params.event_types ?? []) combinedTags.add(et);

  const searchParams = {
    query: params.query,
    tags: combinedTags.size ? [...combinedTags] : undefined,
    after: params.played_after,
    before: params.played_before,
    limit: params.limit,
    threshold: params.threshold,
  };

  const explicitAgent = !!params.agent_name;
  const agentName = params.agent_name || auth.name;
  const agentId = await resolveAgent(
    agentName,
    explicitAgent ? 'llm' : 'system',
    undefined,
    undefined,
    undefined,
    auth.keyId
  );

  const start = Date.now();
  const results = await hybridSearch(searchParams, namespaces, auth.maxAccessLevel);
  const durationMs = Date.now() - start;

  logTrace({
    sessionId: params.session_id,
    agentId,
    clientId: auth.keyId,
    queryText: `[media] ${params.query}`,
    memoryIds: results.map((r) => r.id),
    resultCount: results.length,
    scores: results.map((r) => ({ id: r.id, vec: r.vec_score, text: r.text_score, final: r.final_score })),
    durationMs,
  }).catch((err) => console.error('[total-recall] trace log error:', err.message));

  return results;
}
