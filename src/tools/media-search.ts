import { z } from 'zod';
import { hybridSearch } from '../search.js';
import { dbScopeFromAuth } from '../db.js';
import type { AuthContext, SearchParams, SearchResult } from '../types.js';
import { checkPermission, filterNamespaces } from '../auth.js';
import { resolveAgent } from '../agents.js';
import { logTrace } from '../traces.js';
import {
  MEMORY_CONTENT_MAX_CHARS,
  TAG_MAX_CHARS,
  TAG_MAX_COUNT,
  TEXT_FIELD_MAX_CHARS,
} from '../http-limits.js';

const MEDIA_NAMESPACE = 'media';
const ISO_DATE_TIME_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

type NormalizedPlayedBound = {
  value: string;
  exclusive: boolean;
};

const boundedText = z.string().trim().min(1).max(TEXT_FIELD_MAX_CHARS);

export const mediaSearchSchema = z.object({
  query: z.string().min(1).max(MEMORY_CONTENT_MAX_CHARS),
  services: z.array(boundedText).max(TAG_MAX_COUNT).optional(),
  event_types: z.array(boundedText).max(TAG_MAX_COUNT).optional(),
  played_after: z.string().max(TEXT_FIELD_MAX_CHARS).optional(),
  played_before: z.string().max(TEXT_FIELD_MAX_CHARS).optional(),
  tags: z.array(z.string().trim().min(1).max(TAG_MAX_CHARS)).max(TAG_MAX_COUNT).optional(),
  limit: z.number().int().min(1).max(50).default(10),
  threshold: z.number().min(0).max(1).default(0.3),
  agent_name: boundedText.optional(),
  session_id: boundedText.optional(),
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
  const playedAfter = normalizePlayedBound('played_after', params.played_after);
  const playedBefore = normalizePlayedBound('played_before', params.played_before);
  if (playedAfter && playedBefore) {
    const afterMs = Date.parse(playedAfter.value);
    const beforeMs = Date.parse(playedBefore.value);
    const reversed = playedBefore.exclusive ? afterMs >= beforeMs : afterMs > beforeMs;
    if (reversed) {
      throwPlayedDateError('played_before', 'played_before must be after or equal to played_after');
    }
  }
  const mediaFilters =
    services || eventTypes || playedAfter || playedBefore
      ? {
          services,
          eventTypes,
          eventAfter: playedAfter?.value,
          eventBefore: playedBefore?.value,
          eventBeforeExclusive: playedBefore?.exclusive,
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
  const scope = dbScopeFromAuth(auth);
  const agentId = await resolveAgent(
    agentName,
    explicitAgent ? 'llm' : 'system',
    undefined,
    undefined,
    undefined,
    auth.keyId,
    scope
  );

  const start = Date.now();
  const results = await hybridSearch(searchParams, namespaces, scope, auth.maxAccessLevel);
  const durationMs = Date.now() - start;

  logTrace({
    sessionId: params.session_id,
    agentId,
    clientId: auth.keyId,
    queryText: `[media] ${params.query}`,
    memoryIds: results.map((r) => r.id),
    resultCount: results.length,
    scores: results.map((r) => ({
      id: r.id,
      vec: r.vec_score,
      text: r.text_score,
      final: r.final_score,
      embedding: r.embedding_provider && r.embedding_model && r.embedding_dimensions
        ? { provider: r.embedding_provider, model: r.embedding_model, dimensions: r.embedding_dimensions }
        : null,
    })),
    durationMs,
  }, scope).catch((err) => console.error('[total-recall] trace log error:', err.message));

  return results;
}

function normalizeGroup(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePlayedBound(
  name: 'played_after' | 'played_before',
  value: string | undefined
): NormalizedPlayedBound | undefined {
  if (!value) return undefined;

  if (ISO_DATE_ONLY.test(value)) {
    const date = parseUtcDateOnly(name, value);
    if (name === 'played_before') {
      date.setUTCDate(date.getUTCDate() + 1);
      return { value: date.toISOString(), exclusive: true };
    }
    return { value: date.toISOString(), exclusive: false };
  }

  if (!ISO_DATE_TIME_WITH_ZONE.test(value) || Number.isNaN(Date.parse(value))) {
    throwPlayedDateError(name, `${name} must be an offset-aware ISO date-time or YYYY-MM-DD`);
  }
  return { value, exclusive: false };
}

function parseUtcDateOnly(name: 'played_after' | 'played_before', value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throwPlayedDateError(name, `${name} must be a valid YYYY-MM-DD date`);
  }
  return date;
}

function throwPlayedDateError(name: 'played_after' | 'played_before', message: string): never {
  throw new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: [name],
      message,
    },
  ]);
}
