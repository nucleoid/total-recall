import { createHash } from 'node:crypto';
import { z } from 'zod';
import { queryScoped, queryUnscoped, withScopedClient, type DbScope, type ScopedClient } from './db.js';
import type { AuthContext } from './types.js';
import type { QueryResultRow } from 'pg';

export interface MediaEvent {
  id: string;
  service: string;
  source_id: string;
  event_key: string;
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

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const MAX_TEXT_LENGTH = 4096;
const MAX_SHORT_TEXT_LENGTH = 512;
const MAX_GENRES = 50;
const MAX_METADATA_BYTES = 16 * 1024;

export const MAX_MEDIA_EVENT_BATCH = 500;

const requiredText = (max = MAX_SHORT_TEXT_LENGTH) => z.string().trim().min(1).max(max);
const optionalText = (max = MAX_TEXT_LENGTH) =>
  z.preprocess(
    (value) => typeof value === 'string' && value.trim().length === 0 ? undefined : value,
    z
      .string()
      .trim()
      .min(1)
      .max(max)
      .nullish()
      .transform((value) => value ?? undefined)
  );
const optionalInt32 = z
  .number()
  .finite()
  .int()
  .min(INT32_MIN)
  .max(INT32_MAX)
  .nullish()
  .transform((value) => value ?? undefined);
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const timestampOffsetPattern = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
const calendarDatePattern = /^(\d{4})-(\d{2})-(\d{2})/;

const hasValidCalendarDate = (value: string) => {
  const match = calendarDatePattern.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
};

const normalizeTimestampForParse = (value: string) => {
  const normalized = value.replace(' ', 'T');
  if (!timestampOffsetPattern.test(normalized)) return `${normalized}Z`;
  return normalized.replace(/([+-]\d{2})$/, '$1:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
};
const normalizeTimestampForPostgres = (value: string) => {
  const trimmed = value.trim();
  if (timestampOffsetPattern.test(trimmed)) return trimmed;
  return `${trimmed.replace(' ', 'T')}Z`;
};
const timestamp = z
  .string()
  .trim()
  .refine(
    (value) =>
      timestampPattern.test(value) &&
      hasValidCalendarDate(value) &&
      Number.isFinite(Date.parse(normalizeTimestampForParse(value))),
    { message: 'played_at must be a valid timestamp' }
  )
  .transform(normalizeTimestampForPostgres);

const metadataSchema = z
  .record(z.unknown())
  .refine((value) => JSON.stringify(value).length <= MAX_METADATA_BYTES, {
    message: `metadata must be ${MAX_METADATA_BYTES} bytes or less`,
  })
  .optional();

export const publicMediaEventSchema = z
  .object({
    service: requiredText(128),
    source_id: optionalText(512),
    event_key: optionalText(1024),
    service_id: optionalText(512),
    event_type: requiredText(128),
    title: requiredText(MAX_TEXT_LENGTH),
    artist: optionalText(),
    album: optionalText(),
    show: optionalText(),
    season: optionalInt32,
    episode: optionalInt32,
    year: optionalInt32,
    genres: z.array(requiredText(256)).max(MAX_GENRES).optional(),
    duration_ms: optionalInt32,
    played_ms: optionalInt32,
    completed: z.boolean().nullish().transform((value) => value ?? undefined),
    played_at: timestamp,
    metadata: metadataSchema,
  })
  .strip();

export const publicMediaEventBatchSchema = z.object({
  events: z.array(publicMediaEventSchema).max(MAX_MEDIA_EVENT_BATCH),
});

export interface PublicMediaEventInput {
  service: string;
  source_id?: string;
  event_key?: string;
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
}

export type MediaEventInput = PublicMediaEventInput & {
  client_id?: string | null;
  agent_id?: string | null;
};

export type TrustedMediaEventInput = PublicMediaEventInput & {
  client_id: string;
  agent_id?: string | null;
};

export interface MediaListFilters {
  service?: string;
  source_id?: string;
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

export interface MediaEventUpsertPreviewItem {
  event: MediaEventInput;
  status: 'would_insert' | 'tuple_conflict' | 'possible_legacy_duplicate';
  conflicting_event_ids: string[];
  legacy_duplicate_event_ids: string[];
}

export interface MediaEventUpsertPreview {
  items: MediaEventUpsertPreviewItem[];
  would_insert: number;
  tuple_conflicts: number;
  possible_legacy_duplicates: number;
}

function playedAtKey(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function ytmusicLegacyBucketBounds(event: MediaEventInput): {
  start: string;
  end: string;
} | null {
  if (event.service !== 'ytmusic' || !event.service_id) return null;

  const precision = event.metadata?.played_precision;
  const start = event.metadata?.played_bucket_start;
  const end = event.metadata?.played_bucket_end;
  if (
    precision === 'exact' ||
    precision === 'instant' ||
    typeof start !== 'string' ||
    typeof end !== 'string'
  ) {
    return null;
  }

  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) {
    return null;
  }

  return { start, end };
}

export function parsePublicMediaEventBatch(body: unknown): PublicMediaEventInput[] {
  return publicMediaEventBatchSchema.parse(body).events;
}

export function toTrustedRestMediaEvents(
  events: PublicMediaEventInput[],
  auth: AuthContext
): TrustedMediaEventInput[] {
  return events.map((event) => ({
    ...event,
    source_id: event.source_id ?? 'default',
    event_key: event.event_key ?? mediaEventKey(event),
    client_id: auth.keyId,
    agent_id: null,
  }));
}

export function mediaEventKey(event: PublicMediaEventInput): string {
  const instant = event.played_at instanceof Date ? event.played_at : new Date(event.played_at);
  if (!Number.isFinite(instant.getTime())) throw new Error(`Invalid played_at: ${String(event.played_at)}`);
  const identity = event.service_id?.trim()
    ? `id:${event.service_id.trim()}`
    : `fallback:v1:${createHash('sha256').update(JSON.stringify([
        event.event_type, event.title, event.artist ?? null, event.album ?? null,
        event.show ?? null, event.season ?? null, event.episode ?? null,
        event.year ?? null, event.duration_ms ?? null,
      ])).digest('hex')}`;
  return `${identity}:at:${instant.toISOString()}`;
}

async function upsertMediaEventsWithQuery(
  events: TrustedMediaEventInput[],
  scope: DbScope,
  query: <T extends QueryResultRow>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>
): Promise<UpsertResult> {
  if (events.length === 0) return { inserted: 0, skipped: 0, ids: [] };

  const ids: string[] = [];
  let inserted = 0;
  let skipped = 0;

  for (const e of events) {
    if (!e.client_id || e.client_id !== scope.keyId) {
      throw new Error('Trusted media event client_id must match database scope');
    }

    const sourceId = e.source_id?.trim() || 'default';
    const eventKey = e.event_key?.trim() || mediaEventKey(e);
    const legacyBounds = ytmusicLegacyBucketBounds(e);
    if (legacyBounds) {
      const legacy = await query<{ id: string }>(
        `SELECT id FROM media_events
         WHERE client_id = $1
           AND service = $2
           AND source_id = $3
           AND service_id = $4
           AND NOT (metadata ? 'played_raw')
           AND NOT (metadata ? 'played_bucket')
           AND played_at >= $5::timestamptz
           AND played_at < $6::timestamptz
         LIMIT 1`,
        [scope.keyId, e.service, sourceId, e.service_id, legacyBounds.start, legacyBounds.end]
      );
      if (legacy.rows.length > 0) {
        skipped++;
        continue;
      }
    }

    const res = await query<{ id: string }>(
      `INSERT INTO media_events
         (service, source_id, event_key, service_id, event_type, title, artist, album, show, season, episode, year,
          genres, duration_ms, played_ms, completed, played_at, metadata, client_id, agent_id, namespace)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'media')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        e.service,
        sourceId,
        eventKey,
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
        e.client_id,
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
 * Idempotent batch insert of media events. The database owns the effective
 * identity contract, including fallback identity for null/blank service IDs.
 * Untargeted conflict handling intentionally honors every applicable unique
 * rule; RETURNING alone determines whether each event inserted or skipped.
 */
export async function upsertMediaEvents(events: TrustedMediaEventInput[], scope: DbScope): Promise<UpsertResult> {
  if (events.length === 0) return { inserted: 0, skipped: 0, ids: [] };
  return withScopedClient(scope, (client) =>
    upsertMediaEventsWithQuery(events, scope, (text, params) => client.query(text, params))
  );
}

export async function upsertMediaEventsOnClient(
  client: Pick<ScopedClient, 'query'>,
  events: TrustedMediaEventInput[],
  scope: DbScope
): Promise<UpsertResult> {
  return upsertMediaEventsWithQuery(events, scope, (text, params) => client.query(text, params));
}

export const upsertMediaEventsWithClient = upsertMediaEventsOnClient;

/**
 * Read-only view of how media events would behave under the database tuple key.
 * This reports recovery candidates without writing, merging, deleting, or
 * relinking historical rows.
 */
export async function previewMediaEventUpsertsWithQuery(
  service: string,
  events: MediaEventInput[],
  scope: DbScope,
  query: <T extends QueryResultRow>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>
): Promise<MediaEventUpsertPreview> {
  type PreviewRow = {
    id: string;
    service_id: string;
    played_at: Date | string;
    metadata: Record<string, unknown>;
  };

  const serviceIds = [
    ...new Set(
      events
        .filter((event) => event.service === service)
        .map((event) => event.service_id)
        .filter((id): id is string => Boolean(id))
    ),
  ];

  const existing = serviceIds.length > 0
    ? await query<PreviewRow>(
        `SELECT id, service_id, played_at, metadata FROM media_events
         WHERE client_id = $1 AND service = $2 AND service_id = ANY($3)`,
        [scope.keyId, service, serviceIds]
      )
    : { rows: [] };

  const byServiceId = new Map<string, PreviewRow[]>();
  for (const row of existing.rows) {
    const related = byServiceId.get(row.service_id) ?? [];
    related.push(row);
    byServiceId.set(row.service_id, related);
  }

  const items = events.map<MediaEventUpsertPreviewItem>((event) => {
    if (event.service !== service || !event.service_id) {
      return {
        event,
        status: 'would_insert',
        conflicting_event_ids: [],
        legacy_duplicate_event_ids: [],
      };
    }

    const playedAt = playedAtKey(event.played_at);
    const related = byServiceId.get(event.service_id) ?? [];
    const conflicting = related
      .filter((row) => playedAtKey(row.played_at) === playedAt)
      .map((row) => row.id);
    if (conflicting.length > 0) {
      return {
        event,
        status: 'tuple_conflict',
        conflicting_event_ids: conflicting,
        legacy_duplicate_event_ids: [],
      };
    }

    const bounds = ytmusicLegacyBucketBounds(event);
    const start = bounds ? Date.parse(bounds.start) : Number.NaN;
    const end = bounds ? Date.parse(bounds.end) : Number.NaN;
    const legacyDuplicates = bounds
      ? related
          .filter((row) => {
            const metadata = row.metadata ?? {};
            const rowTime = new Date(row.played_at).getTime();
            return (
              !Object.hasOwn(metadata, 'played_raw') &&
              !Object.hasOwn(metadata, 'played_bucket') &&
              rowTime >= start &&
              rowTime < end
            );
          })
          .map((row) => row.id)
      : [];

    return {
      event,
      status: legacyDuplicates.length > 0 ? 'possible_legacy_duplicate' : 'would_insert',
      conflicting_event_ids: [],
      legacy_duplicate_event_ids: legacyDuplicates,
    };
  });

  return {
    items,
    would_insert: items.filter((item) => item.status === 'would_insert').length,
    tuple_conflicts: items.filter((item) => item.status === 'tuple_conflict').length,
    possible_legacy_duplicates: items.filter((item) => item.status === 'possible_legacy_duplicate').length,
  };
}

export async function previewMediaEventUpserts(
  service: string,
  events: MediaEventInput[],
  scope: DbScope
): Promise<MediaEventUpsertPreview> {
  return previewMediaEventUpsertsWithQuery(
    service,
    events,
    scope,
    (text, params) => queryScoped(scope, text, params)
  );
}

export async function listMediaEvents(auth: AuthContext, scope: DbScope, filters: MediaListFilters = {}): Promise<MediaEvent[]> {
  const isAdmin = auth.permissions.includes('admin');
  const conditions: string[] = ['client_id = $1'];
  const values: unknown[] = [auth.keyId];
  let idx = 1;
  const p = (v: unknown) => { values.push(v); return `$${++idx}`; };

  if (filters.service) conditions.push(`service = ${p(filters.service)}`);
  if (filters.source_id) conditions.push(`source_id = ${p(filters.source_id)}`);
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

export interface MediaStatsFilters {
  service?: string;
  played_after?: string;
  played_before?: string;
  limit?: number;
}

export interface MediaStats {
  total_events: number;
  listening_duration_ms: number;
  plays_by_service: Array<{ service: string; count: number; duration_ms: number }>;
  top_artists: Array<{ artist: string; plays: number; duration_ms: number }>;
  top_albums: Array<{ album: string; artist: string | null; plays: number; duration_ms: number }>;
  top_tracks: Array<{ title: string; artist: string | null; plays: number; duration_ms: number }>;
  daily: Array<{ date: string; count: number; duration_ms: number }>;
}

/** Aggregate only the requesting owner's media history. The REST route also requires admin. */
export async function getMediaStats(auth: AuthContext, scope: DbScope, filters: MediaStatsFilters = {}): Promise<MediaStats> {
  const isAdmin = auth.permissions.includes('admin');
  const values: unknown[] = [auth.keyId];
  const conditions = ['client_id = $1::uuid'];
  const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (filters.service) conditions.push(`service = ${parameter(filters.service)}`);
  if (filters.played_after) conditions.push(`played_at >= ${parameter(filters.played_after)}::timestamptz`);
  if (filters.played_before) conditions.push(`played_at <= ${parameter(filters.played_before)}::timestamptz`);
  const limit = parameter(filters.limit ?? 10);
  const duration = 'COALESCE(played_ms, CASE WHEN completed IS TRUE THEN duration_ms ELSE 0 END, 0)';

  const result = await queryScoped<{ stats: MediaStats }>(
    { ...scope, isAdmin },
    `WITH filtered AS (
       SELECT *, ${duration}::bigint AS listen_ms
       FROM media_events WHERE ${conditions.join(' AND ')}
     ), services AS (
       SELECT service, COUNT(*)::int AS count, COALESCE(SUM(listen_ms), 0)::bigint AS duration_ms
       FROM filtered GROUP BY service ORDER BY count DESC, service
     ), artists AS (
       SELECT artist, COUNT(*)::int AS plays, COALESCE(SUM(listen_ms), 0)::bigint AS duration_ms
       FROM filtered WHERE artist IS NOT NULL GROUP BY artist ORDER BY plays DESC, artist LIMIT ${limit}
     ), albums AS (
       SELECT album, artist, COUNT(*)::int AS plays, COALESCE(SUM(listen_ms), 0)::bigint AS duration_ms
       FROM filtered WHERE artist IS NOT NULL AND album IS NOT NULL
       GROUP BY album, artist ORDER BY plays DESC, album, artist LIMIT ${limit}
     ), tracks AS (
       SELECT title, artist, COUNT(*)::int AS plays, COALESCE(SUM(listen_ms), 0)::bigint AS duration_ms
       FROM filtered WHERE artist IS NOT NULL GROUP BY title, artist ORDER BY plays DESC, title, artist LIMIT ${limit}
     ), days AS (
       SELECT (played_at AT TIME ZONE 'UTC')::date::text AS date, COUNT(*)::int AS count,
              COALESCE(SUM(listen_ms), 0)::bigint AS duration_ms
       FROM filtered GROUP BY (played_at AT TIME ZONE 'UTC')::date ORDER BY (played_at AT TIME ZONE 'UTC')::date
     )
     SELECT jsonb_build_object(
       'total_events', (SELECT COUNT(*)::int FROM filtered),
       'listening_duration_ms', (SELECT COALESCE(SUM(listen_ms), 0)::bigint FROM filtered),
       'plays_by_service', COALESCE((SELECT jsonb_agg(to_jsonb(services)) FROM services), '[]'::jsonb),
       'top_artists', COALESCE((SELECT jsonb_agg(to_jsonb(artists)) FROM artists), '[]'::jsonb),
       'top_albums', COALESCE((SELECT jsonb_agg(to_jsonb(albums)) FROM albums), '[]'::jsonb),
       'top_tracks', COALESCE((SELECT jsonb_agg(to_jsonb(tracks)) FROM tracks), '[]'::jsonb),
       'daily', COALESCE((SELECT jsonb_agg(to_jsonb(days)) FROM days), '[]'::jsonb)
     ) AS stats`,
    values
  );
  return result.rows[0].stats;
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

export async function linkEventToMemoryWithClient(
  client: ScopedClient,
  eventId: string,
  memoryId: string,
  keyId: string
): Promise<boolean> {
  const res = await client.query(
    `UPDATE media_events
     SET memory_id = $1
     WHERE id = $2 AND client_id = $3 AND memory_id IS NULL
     RETURNING id`,
    [memoryId, eventId, keyId]
  );
  return res.rowCount !== 1 ? false : true;
}

// === Connector credentials ===

export async function getConnectorCredentials(
  service: string,
  sourceId = 'default',
  scope?: DbScope,
  namespace = 'media',
): Promise<Record<string, unknown> | null> {
  const resolvedScope = scope ?? await configuredConnectorScope(namespace);
  const res = await queryScoped<{ data: Record<string, unknown> }>(
    resolvedScope,
    `SELECT data FROM connector_credentials
     WHERE client_id = $1 AND namespace = $2 AND service = $3 AND source_id = $4`,
    [resolvedScope.keyId, namespace, service, sourceId]
  );
  return res.rows[0]?.data ?? null;
}

export async function setConnectorCredentials(
  service: string,
  data: Record<string, unknown>,
  sourceId = 'default',
  scope?: DbScope,
  namespace = 'media',
): Promise<void> {
  const resolvedScope = scope ?? await configuredConnectorScope(namespace);
  await queryScoped(
    resolvedScope,
    `INSERT INTO connector_credentials (service, source_id, namespace, client_id, data, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (client_id, namespace, service, source_id) DO UPDATE
       SET data = EXCLUDED.data, updated_at = NOW()`,
    [service, sourceId, namespace, resolvedScope.keyId, JSON.stringify(data)]
  );
}

async function configuredConnectorScope(namespace: string): Promise<DbScope> {
  const configured = namespace === 'media'
    ? process.env.MEDIA_CONNECTOR_API_KEY_NAMES ?? process.env.MEDIA_DEFAULT_API_KEY_NAME ?? 'openclaw-v2'
    : process.env.ACTIVITY_CONNECTOR_API_KEY_NAME;
  const keyName = configured?.split(',')[0]?.trim();
  if (!keyName) throw new Error(`No connector API-key name configured for namespace ${namespace}`);
  const result = await queryUnscoped<{ id: string; namespaces: string[]; permissions: string[] }>(
    `SELECT id, namespaces, permissions FROM api_keys
     WHERE name = $1 AND enabled = true AND (expires_at IS NULL OR expires_at > statement_timestamp())
       AND revoked_at IS NULL LIMIT 1`,
    [keyName],
  );
  const key = result.rows[0];
  if (!key || !key.namespaces.includes(namespace) || !key.permissions.includes('write')) {
    throw new Error(`Configured connector api_key "${keyName}" is not enabled for ${namespace}/write`);
  }
  return { keyId: key.id, namespaces: key.namespaces };
}

// === Per-connector sync state ===

export interface ConnectorSyncState {
  service: string;
  source_id: string;
  namespace: string;
  client_id: string;
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

export async function getSyncState(
  service: string,
  sourceId = 'default',
  scope?: DbScope,
  namespace = 'media',
): Promise<ConnectorSyncState | null> {
  const resolvedScope = scope ?? await configuredConnectorScope(namespace);
  const res = await queryScoped<ConnectorSyncState>(
    resolvedScope,
    `SELECT * FROM connector_sync_state
     WHERE client_id = $1 AND namespace = $2 AND service = $3 AND source_id = $4`,
    [resolvedScope.keyId, namespace, service, sourceId]
  );
  return res.rows[0] ?? null;
}

export async function mutateConnectorSyncStateWithClient(
  client: ScopedClient,
  service: string,
  mutate: (current: ConnectorSyncState) => ConnectorSyncStatePatch,
  sourceId = 'default',
  namespace = 'media',
): Promise<ConnectorSyncState> {
  await client.query(
    `INSERT INTO connector_sync_state (service, source_id, namespace, client_id, metadata, updated_at)
     VALUES ($1, $2, $3, app_current_key_id()::uuid, '{}'::jsonb, NOW())
     ON CONFLICT (client_id, namespace, service, source_id) DO NOTHING`,
    [service, sourceId, namespace]
  );

  const currentRes = await client.query<ConnectorSyncState>(
    `SELECT * FROM connector_sync_state
     WHERE client_id = app_current_key_id()::uuid AND namespace = $2 AND service = $1 AND source_id = $3
     FOR UPDATE`,
    [service, namespace, sourceId]
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
     SET last_sync_at = $4,
         last_event_at = $5,
         cursor = $6,
         metadata = $7,
         updated_at = NOW()
     WHERE service = $1 AND namespace = $2 AND source_id = $3
       AND client_id = app_current_key_id()::uuid
     RETURNING *`,
    [
      service,
      namespace,
      sourceId,
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
  patch: Partial<Omit<ConnectorSyncState, 'service' | 'updated_at'>>,
  sourceId = 'default',
  scope?: DbScope,
  namespace = 'media',
): Promise<void> {
  const resolvedScope = scope ?? await configuredConnectorScope(namespace);
  await queryScoped(
    resolvedScope,
    `INSERT INTO connector_sync_state
       (service, source_id, namespace, client_id, last_sync_at, last_event_at, cursor, metadata, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::jsonb, '{}'::jsonb), NOW())
     ON CONFLICT (client_id, namespace, service, source_id) DO UPDATE SET
       last_sync_at  = COALESCE(EXCLUDED.last_sync_at,  connector_sync_state.last_sync_at),
       last_event_at = COALESCE(EXCLUDED.last_event_at, connector_sync_state.last_event_at),
       cursor        = COALESCE(EXCLUDED.cursor,        connector_sync_state.cursor),
       metadata      = COALESCE($8::jsonb, connector_sync_state.metadata),
       updated_at    = NOW()`,
    [
      service,
      sourceId,
      namespace,
      resolvedScope.keyId,
      patch.last_sync_at ?? null,
      patch.last_event_at ?? null,
      patch.cursor ?? null,
      patch.metadata !== undefined ? JSON.stringify(patch.metadata) : null,
    ]
  );
}
