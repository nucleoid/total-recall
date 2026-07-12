import { queryScoped, type DbScope } from './db.js';
import { embed } from './embedding.js';
import { getRollupPendingEvents, linkEventToMemory, type MediaEvent } from './media.js';
import { checkPermission } from './auth.js';
import type { AuthContext } from './types.js';

const MEDIA_NAMESPACE = 'media';

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

        const insert = await queryScoped<{ id: string }>(
          scope,
          `INSERT INTO memories (content, embedding, source, namespace, tags, metadata, event_at, client_id, agent_id)
           VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9)
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
          ]
        );

        await linkEventToMemory(auth, scope, event.id, insert.rows[0].id);
        rolled++;
      } catch (err: any) {
        failed++;
        errors.push(`event ${event.id}: ${err?.message ?? String(err)}`);
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

function buildTags(e: MediaEvent): string[] {
  const tags = new Set<string>(['media', e.service, e.event_type]);
  if (e.artist) tags.add('music');
  else if (e.show || e.season != null) tags.add('tv');
  else tags.add('movie');
  if (e.completed === true) tags.add('completed');
  for (const g of e.genres ?? []) tags.add(g.toLowerCase());
  return [...tags];
}
