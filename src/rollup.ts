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

  const events = await getRollupPendingEvents(auth, scope, batchSize);
  let rolled = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const event of events) {
    try {
      const summary = buildSummary(event);
      const tags = buildTags(event);
      const metadata = {
        service: event.service,
        service_id: event.service_id,
        event_type: event.event_type,
        played_at: event.played_at,
        title: event.title,
        ...(event.artist && { artist: event.artist }),
        ...(event.album && { album: event.album }),
        ...(event.show && { show: event.show }),
        ...(event.season !== null && { season: event.season }),
        ...(event.episode !== null && { episode: event.episode }),
        ...(event.year !== null && { year: event.year }),
        ...(event.duration_ms !== null && { duration_ms: event.duration_ms }),
        ...(event.played_ms !== null && { played_ms: event.played_ms }),
        ...(event.completed !== null && { completed: event.completed }),
        ...event.metadata,
      };

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

function buildSummary(e: MediaEvent): string {
  const date = new Date(e.played_at).toISOString().slice(0, 10);
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
