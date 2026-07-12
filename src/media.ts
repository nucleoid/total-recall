import { queryScoped, queryUnscoped, type DbScope, type ScopedClient } from './db.js';
import type { AuthContext } from './types.js';
import type { QueryResultRow } from 'pg';

export interface MediaEvent {
  id: string;
  service: string;
  service_id: string | null;
  event_type: string;
  title: string;
  artist: string | null;
  album: string | null;
  show: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
  genres: string[];
  duration_ms: number | null;
  played_ms: number | null;
  completed: boolean | null;
  played_at: Date;
  metadata: Record<string, unknown>;
  client_id: string | null;
  agent_id: string | null;
  memory_id: string | null;
  created_at: Date;
}

export interface MediaEventInput {
  service: string;
  service_id?: string;
  event_type: string;
  title: string;
  artist?: string;
  album?: string;
  show?: string;
  season?: number;
  episode?: number;
  year?: number;
  genres?: string[];
  duration_ms?: number;
  played_ms?: number;
  completed?: boolean;
  played_at: Date | string;
  metadata?: Record<string, unknown>;
  client_id?: string;
  agent_id?: string;
}

export interface MediaListFilters {
  service?: string;
  event_type?: string;
  played_after?: Date | string;
  played_before?: Date | string;
  limit?: number;
  offset?: number;
}

export interface UpsertResult {
  inserted: number;
  skipped: number;
  ids: string[];
}

async function upsertMediaEventsWithQuery(
  events: MediaEventInput[],
  scope: DbScope,
  query: <T extends QueryResultRow>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>
): Promise<UpsertResult> {
  if (events.length === 0) return { inserted: 0, skipped: 0, ids: [] };

  const ids: string[] = [];
  let inserted = 0;
  let skipped = 0;

  for (const e of events) {
    const res = await query<{ id: string; inserted: boolean }>(
      `INSERT INTO media_events
         (service, service_id, event_type, title, artist, album, show, season, episode, year,
          genres, duration_ms, played_ms, completed, played_at, metadata, client_id, agent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (service, service_id, played_at) DO NOTHING
       RETURNING id, (xmax = 0) AS inserted`,
      [
        e.service,
        e.service_id ?? null,
        e.event_type,
        e.title,
        e.artist ?? null,
        e.album ?? null,
        e.show ?? null,
        e.season ?? null,
        e.episode ?? null,
        e.year ?? null,
        e.genres ?? [],
        e.duration_ms ?? null,
        e.played_ms ?? null,
        e.completed ?? null,
        e.played_at,
        JSON.stringify(e.metadata ?? {}),
        scope.keyId,
        e.agent_id ?? null,
      ]
    );

    if (res.rows.length > 0) {
      inserted++;
      ids.push(res.rows[0].id);
    } else {
      skipped++;
    }
  }

  return { inserted, skipped, ids };
}

/**
 * Idempotent batch upsert of media events. Conflict key is
 * (service, service_id, played_at). Events without a service_id always insert.
 */
export async function upsertMediaEvents(events: MediaEventInput[], scope: DbScope): Promise<UpsertResult> {
  return upsertMediaEventsWithQuery(events, scope, (text, params) =>
    queryScoped(scope, text, params)
  );
}

export async function upsertMediaEventsWithClient(
  client: ScopedClient,
  events: MediaEventInput[],
  scope: DbScope
): Promise<UpsertResult> {
  return upsertMediaEventsWithQuery(events, scope, (text, params) =>
    client.query(text, params)
  );
}

export async function listMediaEvents(auth: AuthContext, scope: DbScope, filters: MediaListFilters = {}): Promise<MediaEvent[]> {
  const isAdmin = auth.permissions.includes('admin');
  const conditions: string[] = ['($2::boolean OR client_id = $1)'];
  const values: unknown[] = [auth.keyId, isAdmin];
  let idx = 2;
  const p = (v: unknown) => { values.push(v); return `$${++idx}`; };

  if (filters.service) conditions.push(`service = ${p(filters.service)}`);
  if (filters.event_type) conditions.push(`event_type = ${p(filters.event_type)}`);
  if (filters.played_after) conditions.push(`played_at >= ${p(filters.played_after)}`);
  if (filters.played_before) conditions.push(`played_at <= ${p(filters.played_before)}`);

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(filters.limit ?? 50, 500);
  const offset = filters.offset ?? 0;

  const res = await queryScoped<MediaEvent>(
    { ...scope, isAdmin },
    `SELECT * FROM media_events ${where}
     ORDER BY played_at DESC
     LIMIT ${p(limit)} OFFSET ${p(offset)}`,
    values
  );
  return res.rows;
}

export async function getRollupPendingEvents(auth: AuthContext, scope: DbScope, limit = 50): Promise<MediaEvent[]> {
  const res = await queryScoped<MediaEvent>(
    scope,
    `SELECT * FROM media_events
     WHERE client_id = $1 AND memory_id IS NULL
     ORDER BY played_at ASC
     LIMIT $2`,
    [auth.keyId, limit]
  );
  return res.rows;
}

export async function linkEventToMemory(auth: AuthContext, scope: DbScope, eventId: string, memoryId: string): Promise<void> {
  const res = await queryScoped(
    scope,
    `UPDATE media_events SET memory_id = $1 WHERE id = $2 AND client_id = $3`,
    [memoryId, eventId, auth.keyId]
  );
  if (res.rowCount !== 1) {
    throw new Error('Media event link failed: event not found for authenticated key');
  }
}

// === Connector credentials ===

export async function getConnectorCredentials(service: string): Promise<Record<string, unknown> | null> {
  const res = await queryUnscoped<{ data: Record<string, unknown> }>(
    `SELECT data FROM connector_credentials WHERE service = $1`,
    [service]
  );
  return res.rows[0]?.data ?? null;
}

export async function setConnectorCredentials(
  service: string,
  data: Record<string, unknown>
): Promise<void> {
  await queryUnscoped(
    `INSERT INTO connector_credentials (service, data, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (service) DO UPDATE
       SET data = EXCLUDED.data, updated_at = NOW()`,
    [service, JSON.stringify(data)]
  );
}

// === Per-connector sync state ===

export interface ConnectorSyncState {
  service: string;
  last_sync_at: Date | null;
  last_event_at: Date | null;
  cursor: string | null;
  metadata: Record<string, unknown>;
  updated_at: Date;
}

export interface ConnectorSyncStatePatch {
  last_sync_at?: Date | null;
  last_event_at?: Date | null;
  cursor?: string | null;
  metadata?: Record<string, unknown>;
}

export async function getSyncState(service: string): Promise<ConnectorSyncState | null> {
  const res = await queryUnscoped<ConnectorSyncState>(
    `SELECT * FROM connector_sync_state WHERE service = $1`,
    [service]
  );
  return res.rows[0] ?? null;
}

export async function mutateConnectorSyncStateWithClient(
  client: ScopedClient,
  service: string,
  mutate: (current: ConnectorSyncState) => ConnectorSyncStatePatch
): Promise<ConnectorSyncState> {
  await client.query(
    `INSERT INTO connector_sync_state (service, metadata, updated_at)
     VALUES ($1, '{}'::jsonb, NOW())
     ON CONFLICT (service) DO NOTHING`,
    [service]
  );

  const currentRes = await client.query<ConnectorSyncState>(
    `SELECT * FROM connector_sync_state WHERE service = $1 FOR UPDATE`,
    [service]
  );
  const current = currentRes.rows[0];
  if (!current) {
    throw new Error(`Failed to lock connector sync state for ${service}`);
  }

  const patch = mutate(current);
  const next = {
    last_sync_at: patch.last_sync_at !== undefined ? patch.last_sync_at : current.last_sync_at,
    last_event_at: patch.last_event_at !== undefined ? patch.last_event_at : current.last_event_at,
    cursor: patch.cursor !== undefined ? patch.cursor : current.cursor,
    metadata: patch.metadata !== undefined ? patch.metadata : current.metadata,
  };

  const updated = await client.query<ConnectorSyncState>(
    `UPDATE connector_sync_state
     SET last_sync_at = $2,
         last_event_at = $3,
         cursor = $4,
         metadata = $5,
         updated_at = NOW()
     WHERE service = $1
     RETURNING *`,
    [
      service,
      next.last_sync_at,
      next.last_event_at,
      next.cursor,
      JSON.stringify(next.metadata ?? {}),
    ]
  );
  return updated.rows[0];
}

export async function setSyncState(
  service: string,
  patch: Partial<Omit<ConnectorSyncState, 'service' | 'updated_at'>>
): Promise<void> {
  await queryUnscoped(
    `INSERT INTO connector_sync_state (service, last_sync_at, last_event_at, cursor, metadata, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (service) DO UPDATE SET
       last_sync_at  = COALESCE(EXCLUDED.last_sync_at,  connector_sync_state.last_sync_at),
       last_event_at = COALESCE(EXCLUDED.last_event_at, connector_sync_state.last_event_at),
       cursor        = COALESCE(EXCLUDED.cursor,        connector_sync_state.cursor),
       metadata      = COALESCE(EXCLUDED.metadata,      connector_sync_state.metadata),
       updated_at    = NOW()`,
    [
      service,
      patch.last_sync_at ?? null,
      patch.last_event_at ?? null,
      patch.cursor ?? null,
      patch.metadata !== undefined ? JSON.stringify(patch.metadata) : null,
    ]
  );
}
