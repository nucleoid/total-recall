import { withScopedClient, type DbScope } from './db.js';
import { embed, embeddingDescriptorParams } from './embedding.js';
import { getRollupPendingEvents, linkEventToMemoryWithClient, type MediaEvent } from './media.js';
import { checkPermission } from './auth.js';
import type { AuthContext } from './types.js';

const MEDIA_NAMESPACE = 'media';

class ConcurrentRollupNoOp extends Error {}

export interface RollupResult {
  rolled: number;
  failed: number;
  errors: string[];
}

/**
 * Roll pending media_events into summary memories. Each event becomes one
 * embedded memory in the 'media' namespace, with structured metadata for
 * downstream filtering. The event is linked back via memory_id so we don't
 * roll it up twice.
 */
export async function rollupPendingEvents(auth: AuthContext, scope: DbScope, batchSize = 50): Promise<RollupResult> {
  checkPermission(auth, 'write');
  if (!scope.namespaces.includes(MEDIA_NAMESPACE)) {
    throw new Error(`Permission denied: requires '${MEDIA_NAMESPACE}' namespace`);
  }

  const timeZone = resolveMediaTimeZone(process.env.MEDIA_TIME_ZONE);
  const dateFormatter = createMediaDateFormatter(timeZone);
  const events = await getRollupPendingEvents(auth, scope, batchSize);
  let rolled = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const event of events) {
    try {
      const summary = buildSummary(event, dateFormatter);
      const tags = buildTags(event);
      const metadata = buildMetadata(event);

      const vec = await embed(summary);
      const vecStr = `[${vec.join(',')}]`;

      await withScopedClient(
        { namespaces: [MEDIA_NAMESPACE], keyId: auth.keyId },
        async (client) => {
          const insert = await client.query<{ id: string }>(
            `INSERT INTO memories (content, embedding, source, namespace, tags, metadata, event_at, client_id, agent_id, embedding_provider, embedding_model, embedding_dimensions)
             VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING id`,
            [
              summary,
              vecStr,
              `media:${event.service}`,
              MEDIA_NAMESPACE,
              tags,
              JSON.stringify(metadata),
              event.played_at,
              event.client_id,
              event.agent_id,
              ...embeddingDescriptorParams(),
            ]
          );

          const linked = await linkEventToMemoryWithClient(client, event.id, insert.rows[0].id, auth.keyId);
          if (!linked) throw new ConcurrentRollupNoOp();
        }
      );
      rolled++;
    } catch (err: unknown) {
      if (err instanceof ConcurrentRollupNoOp) continue;
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`event ${event.id}: ${message}`);
    }
  }

  return { rolled, failed, errors };
}

export type MediaDateFormatter = Intl.DateTimeFormat;

export function resolveMediaTimeZone(configured: string | undefined): string {
  const timeZone = configured?.trim() || 'UTC';
  try {
    createMediaDateFormatter(timeZone);
  } catch (error) {
    throw new Error(`Invalid MEDIA_TIME_ZONE '${timeZone}': expected an IANA time zone`, { cause: error });
  }
  return timeZone;
}

export function createMediaDateFormatter(timeZone: string): MediaDateFormatter {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

export function formatMediaDate(
  playedAt: Date | string,
  formatter: MediaDateFormatter
): string {
  const instant = playedAt instanceof Date ? playedAt : new Date(playedAt);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error(`Invalid played_at timestamp: ${String(playedAt)}`);
  }

  const parts = new Map(
    formatter.formatToParts(instant)
      .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
      .map((part) => [part.type, part.value])
  );
  const date = `${parts.get('year') ?? ''}-${parts.get('month') ?? ''}-${parts.get('day') ?? ''}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Unable to format played_at as an ASCII calendar date: ${String(playedAt)}`);
  }
  return date;
}

export function buildSummary(e: MediaEvent, formatter: MediaDateFormatter): string {
  const date = formatMediaDate(e.played_at, formatter);
  const completion = e.completed === true ? ' Completed.' : e.completed === false ? ' Did not finish.' : '';
  const genres = e.genres?.length ? ` Genres: ${e.genres.join(', ')}.` : '';

  if (e.artist) {
    const album = e.album ? ` from "${e.album}"` : '';
    return `Listened to "${e.title}" by ${e.artist}${album} on ${date} via ${e.service}.${genres}`;
  }

  if (e.show) {
    const seasonEp = e.season != null && e.episode != null
      ? ` S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`
      : '';
    return `Watched ${e.show}${seasonEp} "${e.title}" on ${date} via ${e.service}.${completion}${genres}`;
  }

  const year = e.year ? ` (${e.year})` : '';
  return `Watched "${e.title}"${year} on ${date} via ${e.service}.${completion}${genres}`;
}

export function buildMetadata(e: MediaEvent): Record<string, unknown> {
  return {
    service: e.service,
    service_id: e.service_id,
    event_type: e.event_type,
    played_at: e.played_at,
    title: e.title,
    ...(e.artist && { artist: e.artist }),
    ...(e.album && { album: e.album }),
    ...(e.show && { show: e.show }),
    ...(e.season !== null && { season: e.season }),
    ...(e.episode !== null && { episode: e.episode }),
    ...(e.year !== null && { year: e.year }),
    ...(e.duration_ms !== null && { duration_ms: e.duration_ms }),
    ...(e.played_ms !== null && { played_ms: e.played_ms }),
    ...(e.completed !== null && { completed: e.completed }),
    ...e.metadata,
  };
}

export type MediaKind = 'music' | 'tv' | 'movie' | 'unknown';

const MEDIA_KINDS = new Set<MediaKind>(['music', 'tv', 'movie', 'unknown']);

export function classifyMediaKind(e: MediaEvent): MediaKind {
  const service = e.service.trim().toLowerCase();
  const eventType = e.event_type.trim().toLowerCase();
  const metadata = e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata)
    ? e.metadata
    : {};
  const rawPlexType = metadata.plex_type;
  const plexType = typeof rawPlexType === 'string' ? rawPlexType.trim().toLowerCase() : '';

  if (service === 'plex') {
    if (plexType === 'track') return 'music';
    if (plexType === 'episode') return 'tv';
    if (plexType === 'movie') return 'movie';
  }
  if (e.artist) return 'music';
  if (e.show || e.season != null || e.episode != null) return 'tv';
  if ((service === 'spotify' || service === 'ytmusic') && eventType === 'play') return 'music';
  return 'unknown';
}

export function buildTags(e: MediaEvent): string[] {
  const kind = classifyMediaKind(e);
  const tags = new Set<string>(['media', e.service, e.event_type, kind]);
  if (e.completed === true) tags.add('completed');
  if (Array.isArray(e.genres)) {
    for (const genre of e.genres) {
      if (typeof genre !== 'string') continue;
      const normalized = genre.trim().toLowerCase();
      if (!normalized || (MEDIA_KINDS.has(normalized as MediaKind) && normalized !== kind)) continue;
      tags.add(normalized);
    }
  }
  return [...tags];
}
