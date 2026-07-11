import type { MediaEventInput } from '../media.js';
import {
  upsertMediaEvents,
  getSyncState,
  setSyncState,
  getConnectorCredentials,
  setConnectorCredentials,
} from '../media.js';

export interface ConnectorContext {
  /** Optional api_key id to attribute events to (passed through to media_events). */
  apiKeyId?: string;
  /** Optional agent id to attribute events to. */
  agentId?: string;
}

export interface SyncResult {
  service: string;
  events_ingested: number;
  events_skipped: number;
  errors: string[];
  duration_ms: number;
  cursor?: string;
}

export function selectNewestCursorDate(events: MediaEventInput[]): Date | null {
  return events.reduce<Date | null>((acc, e) => {
    if (e.metadata?.played_cursor_eligible === false) return acc;
    const ts = e.played_at instanceof Date ? e.played_at : new Date(e.played_at);
    if (Number.isNaN(ts.getTime())) return acc;
    return !acc || ts > acc ? ts : acc;
  }, null);
}

/**
 * Base class for media connectors. Each concrete connector implements
 * `fetchSince()` which returns canonical MediaEventInput[] for any events
 * newer than the supplied cursor / timestamp. The base class handles
 * upsert, attribution, sync-state, and timing.
 */
export abstract class BaseConnector {
  abstract readonly service: string;

  /**
   * Fetch events from the third-party service. Should return events newer
   * than `since` (a timestamp from the last successful sync). If the
   * service uses an opaque cursor, the connector can ignore `since` and
   * read its cursor from `getSyncState()` directly.
   */
  protected abstract fetchSince(since: Date | null): Promise<{
    events: MediaEventInput[];
    cursor?: string;
  }>;

  /** Load credentials for this service. */
  protected async credentials(): Promise<Record<string, unknown> | null> {
    return getConnectorCredentials(this.service);
  }

  /** Persist credentials (e.g. after OAuth refresh). */
  protected async saveCredentials(data: Record<string, unknown>): Promise<void> {
    await setConnectorCredentials(this.service, data);
  }

  /** Standard incremental sync: pulls new events since last_event_at. */
  async sync(ctx: ConnectorContext = {}): Promise<SyncResult> {
    const start = Date.now();
    const errors: string[] = [];
    let ingested = 0;
    let skipped = 0;
    let cursor: string | undefined;

    try {
      const state = await getSyncState(this.service);
      const since = state?.last_event_at ?? null;

      const { events, cursor: nextCursor } = await this.fetchSince(since);
      cursor = nextCursor;

      const enriched = events.map((e) => ({
        ...e,
        client_id: e.client_id ?? ctx.apiKeyId,
        agent_id: e.agent_id ?? ctx.agentId,
      }));

      const result = await upsertMediaEvents(enriched);
      ingested = result.inserted;
      skipped = result.skipped;

      const newest = selectNewestCursorDate(events);

      await setSyncState(this.service, {
        last_sync_at: new Date(),
        last_event_at: newest ?? since,
        cursor: nextCursor ?? state?.cursor ?? null,
      });
    } catch (err: any) {
      errors.push(err?.message ?? String(err));
    }

    return {
      service: this.service,
      events_ingested: ingested,
      events_skipped: skipped,
      errors,
      duration_ms: Date.now() - start,
      cursor,
    };
  }

  /**
   * Run a backfill over a wider window. Default impl just calls fetchSince
   * with the given date; connectors that support paging should override.
   */
  async backfill(ctx: ConnectorContext = {}, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: string[] = [];
    let ingested = 0;
    let skipped = 0;

    try {
      const { events } = await this.fetchSince(since);
      const enriched = events.map((e) => ({
        ...e,
        client_id: e.client_id ?? ctx.apiKeyId,
        agent_id: e.agent_id ?? ctx.agentId,
      }));
      const result = await upsertMediaEvents(enriched);
      ingested = result.inserted;
      skipped = result.skipped;
    } catch (err: any) {
      errors.push(err?.message ?? String(err));
    }

    return {
      service: this.service,
      events_ingested: ingested,
      events_skipped: skipped,
      errors,
      duration_ms: Date.now() - start,
    };
  }
}
