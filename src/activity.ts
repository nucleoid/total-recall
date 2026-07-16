import { z } from 'zod';
import { queryScoped, withScopedClient, type DbScope, type ScopedClient } from './db.js';
import type { AuthContext } from './types.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const timestamp = z.union([z.string().datetime({ offset: true }), z.date()]);
const metadata = z.record(z.unknown()).refine(
  (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16 * 1024,
  'metadata must be 16384 bytes or less',
);

export const activityEventSchema = z.object({
  connector: text(128),
  source_id: text(512),
  event_key: text(1024),
  event_type: text(128),
  title: text(4096),
  occurred_at: timestamp,
  observed_at: timestamp.optional(),
  time_precision: z.enum(['instant', 'minute', 'day', 'aggregate']).default('instant'),
  source_timezone: text(128).optional(),
  metadata: metadata.optional(),
  namespace: text(512).default('activity'),
}).strip();

export const activityEventBatchSchema = z.object({
  events: z.array(activityEventSchema).max(500),
});

const queryArray = z.preprocess(
  (value) => typeof value === 'string' ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : value,
  z.array(text(512)).max(100).optional(),
);
export const activityListQuerySchema = z.object({
  namespace: text(512).default('activity'),
  connectors: queryArray,
  source_ids: queryArray,
  event_types: queryArray,
  occurred_after: z.string().datetime({ offset: true }).optional(),
  occurred_before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface ActivityEventInput {
  connector: string;
  source_id: string;
  event_key: string;
  event_type: string;
  title: string;
  occurred_at: Date | string;
  observed_at?: Date | string;
  time_precision?: 'instant' | 'minute' | 'day' | 'aggregate';
  source_timezone?: string;
  metadata?: Record<string, unknown>;
  namespace?: string;
}

export type TrustedActivityEventInput = ActivityEventInput & {
  client_id: string;
  agent_id?: string | null;
};

export interface ActivityEvent extends TrustedActivityEventInput {
  id: string;
  namespace: string;
  time_precision: 'instant' | 'minute' | 'day' | 'aggregate';
  occurred_at: Date;
  observed_at: Date;
  created_at: Date;
}

export interface ActivityListFilters {
  connectors?: string[];
  source_ids?: string[];
  event_types?: string[];
  occurred_after?: string | Date;
  occurred_before?: string | Date;
  limit?: number;
  offset?: number;
}

export function parsePublicActivityEventBatch(body: unknown): ActivityEventInput[] {
  return activityEventBatchSchema.parse(body).events;
}

export function toTrustedActivityEvents(
  events: ActivityEventInput[],
  auth: Pick<AuthContext, 'keyId' | 'namespaces'>,
  agentId: string | null = null,
): TrustedActivityEventInput[] {
  for (const event of events) {
    const namespace = event.namespace ?? 'activity';
    if (!auth.namespaces.includes(namespace)) {
      throw new Error(`Permission denied: namespace '${namespace}' is not accessible`);
    }
  }
  return events.map((event) => ({ ...event, client_id: auth.keyId, agent_id: agentId }));
}

export async function upsertActivityEventsWithClient(
  client: Pick<ScopedClient, 'query'>,
  events: TrustedActivityEventInput[],
  scope: DbScope,
): Promise<{ inserted: number; skipped: number; ids: string[] }> {
  let inserted = 0;
  let skipped = 0;
  const ids: string[] = [];
  for (const raw of events) {
    const event = activityEventSchema.parse(raw);
    const namespace = event.namespace ?? 'activity';
    if (raw.client_id !== scope.keyId || !scope.namespaces.includes(namespace)) {
      throw new Error('Trusted activity event ownership/namespace must match database scope');
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO activity_events
         (connector, source_id, event_key, event_type, title, occurred_at,
          observed_at, time_precision, source_timezone, metadata, namespace, client_id, agent_id)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, statement_timestamp()),$8,$9,$10,$11,$12,$13)
       ON CONFLICT (client_id, connector, source_id, event_key) DO NOTHING
       RETURNING id`,
      [
        event.connector,
        event.source_id,
        event.event_key,
        event.event_type,
        event.title,
        event.occurred_at,
        event.observed_at ?? null,
        event.time_precision,
        event.source_timezone ?? null,
        JSON.stringify(event.metadata ?? {}),
        namespace,
        raw.client_id,
        raw.agent_id ?? null,
      ],
    );
    if (result.rows[0]) {
      inserted++;
      ids.push(result.rows[0].id);
    } else skipped++;
  }
  return { inserted, skipped, ids };
}

export async function upsertActivityEvents(
  events: TrustedActivityEventInput[],
  scope: DbScope,
): Promise<{ inserted: number; skipped: number; ids: string[] }> {
  return withScopedClient(scope, (client) => upsertActivityEventsWithClient(client, events, scope));
}

export async function listActivityEvents(
  auth: AuthContext,
  scope: DbScope,
  namespace: string,
  filters: ActivityListFilters = {},
): Promise<ActivityEvent[]> {
  if (!auth.namespaces.includes(namespace)) return [];
  const values: unknown[] = [auth.keyId, namespace];
  const p = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const conditions = ['client_id = $1', 'namespace = $2'];
  if (filters.connectors?.length) conditions.push(`connector = ANY(${p(filters.connectors)}::text[])`);
  if (filters.source_ids?.length) conditions.push(`source_id = ANY(${p(filters.source_ids)}::text[])`);
  if (filters.event_types?.length) conditions.push(`event_type = ANY(${p(filters.event_types)}::text[])`);
  if (filters.occurred_after) conditions.push(`occurred_at >= ${p(filters.occurred_after)}::timestamptz`);
  if (filters.occurred_before) conditions.push(`occurred_at <= ${p(filters.occurred_before)}::timestamptz`);
  const limit = Math.min(filters.limit ?? 50, 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  const result = await queryScoped<ActivityEvent>(
    scope,
    `SELECT * FROM activity_events WHERE ${conditions.join(' AND ')}
     ORDER BY occurred_at DESC, id DESC LIMIT ${p(limit)} OFFSET ${p(offset)}`,
    values,
  );
  return result.rows;
}
