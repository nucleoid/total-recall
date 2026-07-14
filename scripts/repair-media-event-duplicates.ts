import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const DEFAULT_MAX_GROUPS = 100;
const DEFAULT_MAX_EVENTS = 100;
const MAX_GROUPS = 1_000;
const MAX_EVENTS = 1_000;
const MAX_TARGET_EVENTS = 100_000;
const GROUP_KEY = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DuplicateRowApproval { id: string; fingerprint: string; action: 'retain' | 'delete' }
export interface DuplicateGroupApproval {
  groupKey: string;
  groupFingerprint: string;
  clientId: string;
  service: string;
  playedAt: string;
  retainedEventId: string;
  retainedMemoryId: string | null;
  events: DuplicateRowApproval[];
  memories: DuplicateRowApproval[];
}
export interface RepairMediaEventDuplicatesOptions {
  connectionString: string;
  maxGroups?: number;
  maxEventsPerGroup?: number;
  targetGroupKey?: string;
  targetMaxEventsPerGroup?: number;
  apply?: boolean;
  confirmBackup?: boolean;
  approvals?: DuplicateGroupApproval[];
}
export interface PreviewRow { id: string; fingerprint: string }
export interface DuplicateGroupPreview {
  groupKey: string;
  groupFingerprint: string;
  clientId: string;
  service: string;
  playedAt: string;
  complete: boolean;
  totalEvents: number;
  events: PreviewRow[];
  memories: PreviewRow[];
}
export interface RepairMediaEventDuplicatesResult {
  dryRun: boolean;
  totalGroups: number;
  truncated: boolean;
  groups: DuplicateGroupPreview[];
  deletedEvents: number;
  deletedMemories: number;
  outcomes: Array<{ groupFingerprint: string; status: 'reconciled' | 'already-reconciled' }>;
  warning: string;
}

interface EventSnapshotRow {
  id: string; client_id: string; service: string; played_at: Date; memory_id: string | null;
  group_key: string; group_size: string; snapshot: string;
}

export async function repairMediaEventDuplicates(options: RepairMediaEventDuplicatesOptions): Promise<RepairMediaEventDuplicatesResult> {
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    // Approval identities and snapshots must not depend on a role/database TimeZone GUC.
    await client.query(`SET TIME ZONE 'UTC'`);
    if (options.apply) return await applyApprovals(client, options);
    if (options.targetMaxEventsPerGroup !== undefined && options.targetGroupKey === undefined) {
      throw new Error('targetMaxEventsPerGroup requires an exact targetGroupKey');
    }
    const targetGroupKey = options.targetGroupKey === undefined ? undefined : validGroupKey(options.targetGroupKey);
    const maxGroups = targetGroupKey ? 1 : bounded(options.maxGroups ?? DEFAULT_MAX_GROUPS, 'maxGroups', MAX_GROUPS);
    const maxEvents = targetGroupKey
      ? bounded(options.targetMaxEventsPerGroup ?? DEFAULT_MAX_EVENTS, 'targetMaxEventsPerGroup', MAX_TARGET_EVENTS)
      : bounded(options.maxEventsPerGroup ?? DEFAULT_MAX_EVENTS, 'maxEventsPerGroup', MAX_EVENTS);
    const { totalGroups, groups } = await loadGroups(client, maxGroups, maxEvents, targetGroupKey ? { groupKey: targetGroupKey } : undefined);
    return base(true, totalGroups, groups, []);
  } finally { await client.end(); }
}

async function loadGroups(
  client: pg.Client,
  maxGroups: number,
  maxEvents: number,
  filter?: { clientId?: string; service?: string; playedAt?: string; groupKey?: string },
): Promise<{ totalGroups: number; groups: DuplicateGroupPreview[] }> {
  const params: unknown[] = [maxGroups, filter?.clientId ?? null, filter?.service ?? null, filter?.playedAt ?? null, filter?.groupKey ?? null];
  const identity = `jsonb_build_object(
    'clientId', client_id, 'service', service, 'playedAt', played_at,
    'kind', CASE WHEN NULLIF(BTRIM(service_id),'') IS NULL THEN 'fallback:v1' ELSE 'id' END,
    'serviceId', CASE WHEN NULLIF(BTRIM(service_id),'') IS NULL THEN NULL ELSE service_id END,
    'eventType', CASE WHEN NULLIF(BTRIM(service_id),'') IS NULL THEN event_type END,
    'title', CASE WHEN NULLIF(BTRIM(service_id),'') IS NULL THEN title END,
    'artist', CASE WHEN NULLIF(BTRIM(service_id),'') IS NULL THEN artist END,
    'album', CASE WHEN NULLIF(BTRIM(service_id),'') IS NULL THEN album END,
    'show', CASE WHEN NULLIF(BTRIM(service_id),'') IS NULL THEN show END,
    'season', CASE WHEN NULLIF(BTRIM(service_id),'') IS NULL THEN season END,
    'episode', CASE WHEN NULLIF(BTRIM(service_id),'') IS NULL THEN episode END,
    'year', CASE WHEN NULLIF(BTRIM(service_id),'') IS NULL THEN year END,
    'durationMs', CASE WHEN NULLIF(BTRIM(service_id),'') IS NULL THEN duration_ms END
  )::text`;
  const opaqueKey = `(pg_catalog.md5('media-duplicate-group:v1:' || (${identity})) || pg_catalog.md5('media-duplicate-group:v1b:' || (${identity})))`;
  const common = `
    WITH identified AS (
      SELECT e.*, ${identity} AS identity_key, ${opaqueKey} AS group_key
      FROM public.media_events e
      WHERE client_id IS NOT NULL
        AND ($2::uuid IS NULL OR client_id = $2::uuid)
        AND ($3::text IS NULL OR service = $3)
        AND ($4::timestamptz IS NULL OR played_at = $4::timestamptz)
    ), counted AS (
      SELECT identified.*, count(*) OVER (PARTITION BY identity_key) AS group_size
      FROM identified
    ), duplicate_groups AS (
      SELECT identity_key, group_key, min(played_at) AS first_played
      FROM counted WHERE group_size > 1 GROUP BY identity_key, group_key
    ), selected_groups AS (
      SELECT identity_key FROM duplicate_groups
      WHERE ($5::text IS NULL OR group_key = $5::text)
      ORDER BY first_played, group_key LIMIT $1
    )`;
  const total = await client.query<{ count: string }>(`
    WITH identified AS (SELECT ${identity} AS identity_key, ${opaqueKey} AS group_key FROM public.media_events e WHERE client_id IS NOT NULL
      AND ($1::uuid IS NULL OR client_id=$1::uuid) AND ($2::text IS NULL OR service=$2)
      AND ($3::timestamptz IS NULL OR played_at=$3::timestamptz)), grouped AS
      (SELECT identity_key FROM identified WHERE ($4::text IS NULL OR group_key=$4::text) GROUP BY identity_key HAVING count(*)>1)
    SELECT count(*)::text AS count FROM grouped`, [filter?.clientId ?? null, filter?.service ?? null, filter?.playedAt ?? null, filter?.groupKey ?? null]);
  const rows = await client.query<EventSnapshotRow>(`${common}
    SELECT id::text, client_id::text, service, played_at, memory_id::text,
           group_key, group_size::text, to_jsonb(counted)::text AS snapshot
    FROM counted JOIN selected_groups USING(identity_key)
    ORDER BY played_at, group_key, id`, params);

  const grouped = new Map<string, EventSnapshotRow[]>();
  for (const row of rows.rows) {
    const bucket = grouped.get(row.group_key) ?? [];
    bucket.push(row);
    grouped.set(row.group_key, bucket);
  }
  const previews: DuplicateGroupPreview[] = [];
  for (const [groupKey, eventRows] of grouped) {
    const totalEvents = Number.parseInt(eventRows[0].group_size, 10);
    const boundedRows = eventRows.slice(0, maxEvents);
    const memoryIds = [...new Set(boundedRows.map(row => row.memory_id).filter((id): id is string => id !== null))];
    const memories = memoryIds.length === 0 ? [] : (await client.query<{ id: string; snapshot: string }>(
      `SELECT id::text, (to_jsonb(m) - ARRAY[
         'embedding', 'accessed_at', 'access_count', 'last_boosted_at', 'relevance_score', 'decay_rate', 'updated_at'
       ]::text[])::text AS snapshot
       FROM public.memories m
       WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
       ORDER BY id`, [memoryIds]
    )).rows.map(row => ({ id: row.id, fingerprint: hash(row.snapshot) }));
    const events = boundedRows.map(row => ({ id: row.id, fingerprint: hash(row.snapshot) }));
    const seed = JSON.parse(eventRows[0].snapshot) as Record<string, unknown>;
    const complete = totalEvents <= maxEvents && memories.length === memoryIds.length;
    previews.push({
      groupKey,
      groupFingerprint: hash(JSON.stringify({ groupKey, events, memories })),
      clientId: String(seed.client_id), service: String(seed.service), playedAt: new Date(String(seed.played_at)).toISOString(),
      complete, totalEvents, events, memories,
    });
  }
  return { totalGroups: Number.parseInt(total.rows[0]?.count ?? '0', 10), groups: previews };
}

async function applyApprovals(client: pg.Client, options: RepairMediaEventDuplicatesOptions): Promise<RepairMediaEventDuplicatesResult> {
  if (options.confirmBackup !== true) throw new Error('Apply requires acknowledgement of a verified restorable backup (--confirm-backup)');
  const approvals = options.approvals ?? [];
  if (approvals.length === 0) throw new Error('Apply requires an explicit approval manifest; broad predicate-wide apply is not supported');
  approvals.forEach(validateApproval);
  const maxEvents = bounded(options.targetMaxEventsPerGroup ?? MAX_EVENTS, 'targetMaxEventsPerGroup', MAX_TARGET_EVENTS);
  const outcomes: RepairMediaEventDuplicatesResult['outcomes'] = [];
  let deletedEvents = 0;
  let deletedMemories = 0;
  await client.query('BEGIN');
  try {
    for (const approval of approvals) {
      await client.query(`SELECT id FROM public.media_events WHERE client_id=$1::uuid AND service=$2 AND played_at=$3::timestamptz FOR UPDATE`, [approval.clientId, approval.service, approval.playedAt]);
      const expectedDeletedEvents = approval.events.filter(row => row.action === 'delete').map(row => row.id);
      const existing = await client.query<{ id: string; memory_id: string | null }>(`SELECT id::text,memory_id::text FROM public.media_events WHERE id=ANY($1::uuid[])`, [[approval.retainedEventId, ...expectedDeletedEvents]]);
      const retained = existing.rows.find(row => row.id === approval.retainedEventId);
      if (retained && existing.rows.every(row => row.id === approval.retainedEventId)) {
        const memoryOk = approval.retainedMemoryId === retained.memory_id;
        const deletedMemoryIds = approval.memories.filter(row => row.action === 'delete').map(row => row.id);
        const leftovers = deletedMemoryIds.length ? await client.query(`SELECT 1 FROM public.memories WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL`, [deletedMemoryIds]) : { rowCount: 0 };
        if (memoryOk && leftovers.rowCount === 0) {
          outcomes.push({ groupFingerprint: approval.groupFingerprint, status: 'already-reconciled' });
          continue;
        }
      }
      const current = await loadGroups(client, 1, maxEvents, {
        clientId: approval.clientId,
        service: approval.service,
        playedAt: approval.playedAt,
        groupKey: approval.groupKey,
      });
      const group = current.groups.find(candidate => candidate.groupFingerprint === approval.groupFingerprint);
      if (!group) throw new Error(`State drift or fingerprint mismatch for approved group ${approval.groupFingerprint}`);
      if (!group.complete) throw new Error('Approval cannot apply to an incomplete bounded preview group');
      assertExactRows(approval.events, group.events, 'event');
      assertExactRows(approval.memories, group.memories, 'memory');

      const deleteMemoryIds = approval.memories.filter(row => row.action === 'delete').map(row => row.id);
      if (deleteMemoryIds.length) {
        const external = await client.query(`SELECT 1 FROM public.media_events WHERE memory_id=ANY($1::uuid[]) AND NOT (id=ANY($2::uuid[])) LIMIT 1`, [deleteMemoryIds, approval.events.map(row => row.id)]);
        if (external.rowCount) throw new Error('Approved memory is linked from an unapproved event');
      }
      const relinked = await client.query(`UPDATE public.media_events
        SET memory_id=$1::uuid
        WHERE id=$2::uuid
          AND ($1::uuid IS NULL OR EXISTS (
            SELECT 1 FROM public.memories m WHERE m.id=$1::uuid AND m.deleted_at IS NULL
          ))`, [approval.retainedMemoryId, approval.retainedEventId]);
      if (relinked.rowCount !== 1) throw new Error('Retained memory was deleted or changed during apply');
      if (expectedDeletedEvents.length) {
        const removed = await client.query(`DELETE FROM public.media_events WHERE id=ANY($1::uuid[]) RETURNING id`, [expectedDeletedEvents]);
        if (removed.rowCount !== expectedDeletedEvents.length) throw new Error('Exact approved event delete set changed during apply');
        deletedEvents += removed.rowCount ?? 0;
      }
      if (deleteMemoryIds.length) {
        const removed = await client.query(`DELETE FROM public.memories WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL RETURNING id`, [deleteMemoryIds]);
        if (removed.rowCount !== deleteMemoryIds.length) throw new Error('Exact approved memory delete set changed during apply');
        deletedMemories += removed.rowCount ?? 0;
      }
      outcomes.push({ groupFingerprint: approval.groupFingerprint, status: 'reconciled' });
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  const result = base(false, approvals.length, [], outcomes);
  result.deletedEvents = deletedEvents; result.deletedMemories = deletedMemories;
  return result;
}

function validateApproval(value: DuplicateGroupApproval): void {
  if (!GROUP_KEY.test(value.groupKey) || !/^[a-f0-9]{64}$/.test(value.groupFingerprint) || !UUID.test(value.clientId) || !UUID.test(value.retainedEventId)) throw new Error('Every approval requires exact UUIDs and a preview group fingerprint');
  if (value.events.length < 2) throw new Error('Approval must name the complete exact duplicate event set');
  if (new Set(value.events.map(row => row.id)).size !== value.events.length) throw new Error('Approval contains duplicate event rows');
  for (const row of [...value.events, ...value.memories]) if (!UUID.test(row.id) || !/^[a-f0-9]{64}$/.test(row.fingerprint)) throw new Error('Every approved row requires an exact UUID and fingerprint');
  const retainedEvents = value.events.filter(row => row.action === 'retain');
  if (retainedEvents.length !== 1 || retainedEvents[0].id !== value.retainedEventId) throw new Error('Approval has ambiguous retained event');
  const retainedMemories = value.memories.filter(row => row.action === 'retain');
  if (value.memories.length > 0 && (retainedMemories.length !== 1 || retainedMemories[0].id !== value.retainedMemoryId)) throw new Error('Approval has ambiguous retained memory');
  if (value.memories.length === 0 && value.retainedMemoryId !== null) throw new Error('Retained memory is not in the approved group');
}

function assertExactRows(approved: DuplicateRowApproval[], current: PreviewRow[], label: string): void {
  const expected = approved.map(row => `${row.id}:${row.fingerprint}`).sort();
  const actual = current.map(row => `${row.id}:${row.fingerprint}`).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`Approval does not name the complete exact ${label} row set or state drift occurred`);
}
function base(dryRun: boolean, totalGroups: number, groups: DuplicateGroupPreview[], outcomes: RepairMediaEventDuplicatesResult['outcomes']): RepairMediaEventDuplicatesResult {
  return { dryRun, totalGroups, truncated: dryRun && totalGroups > groups.length, groups, deletedEvents:0, deletedMemories:0, outcomes,
    warning:'Effective identity is collision evidence, not proof of interchangeability. Independently verify every row and linked memory before approval.' };
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function validGroupKey(value: string): string { if (!GROUP_KEY.test(value)) throw new Error('targetGroupKey must be an opaque 64-character preview group key'); return value; }
function bounded(value: number, name: string, max: number): number { if (!Number.isInteger(value)||value<1||value>max) throw new Error(`${name} must be an integer from 1 to ${max}`); return value; }
function flag(name: string): string|undefined { const i=process.argv.indexOf(name); if(i<0)return undefined; const v=process.argv[i+1]; if(!v)throw new Error(`${name} requires a value`); return v; }
async function main(): Promise<void> {
  const connectionString=process.env.MIGRATION_DATABASE_URL??process.env.DATABASE_URL; if(!connectionString)throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
  const manifest=flag('--approval-manifest');
  const approvals=manifest?JSON.parse(await readFile(manifest,'utf8')) as DuplicateGroupApproval[]:undefined;
  const targetMaxEvents = flag('--target-max-events-per-group');
  console.log(JSON.stringify(await repairMediaEventDuplicates({connectionString,apply:process.argv.includes('--apply'),confirmBackup:process.argv.includes('--confirm-backup'),approvals,maxGroups:Number(flag('--max-groups')??DEFAULT_MAX_GROUPS),maxEventsPerGroup:Number(flag('--max-events-per-group')??DEFAULT_MAX_EVENTS),targetGroupKey:flag('--group-key'),targetMaxEventsPerGroup:targetMaxEvents===undefined?undefined:Number(targetMaxEvents)}),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{console.error('Media duplicate repair failed:',error instanceof Error?error.message:error);process.exitCode=1;});
