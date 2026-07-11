import { z } from 'zod';
import { hybridSearch } from '../search.js';
import type { AuthContext, SearchParams, SearchResult } from '../types.js';
import { checkPermission, filterNamespaces } from '../auth.js';
import { resolveAgent } from '../agents.js';
import { logTrace } from '../traces.js';

const MEDIA_NAMESPACE = 'media';
const ISO_DATE_TIME_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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

  const tags = normalizeGroup(params.tags);
  const services = normalizeGroup(params.services);
  const eventTypes = normalizeGroup(params.event_types);
  const playedAfter = validatePlayedDate('played_after', params.played_after);
  const playedBefore = validatePlayedDate('played_before', params.played_before);
  if (playedAfter && playedBefore && Date.parse(playedAfter) > Date.parse(playedBefore)) {
    throw new Error('played_after must be before or equal to played_before');
  }
  const mediaFilters =
    services || eventTypes || playedAfter || playedBefore
      ? {
          services,
          eventTypes,
          playedAfter,
          playedBefore,
        }
      : undefined;

  const searchParams: SearchParams = {
    query: params.query,
    tags,
    mediaFilters,
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
  const results = await hybridSearch(searchParams, namespaces);
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

function normalizeGroup(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function validatePlayedDate(name: 'played_after' | 'played_before', value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!ISO_DATE_TIME_WITH_ZONE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO date-time with timezone`);
  }
  return value;
}
