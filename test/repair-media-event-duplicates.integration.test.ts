import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { repairMediaEventDuplicates, type DuplicateGroupApproval } from '../scripts/repair-media-event-duplicates.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tenantIdentityMigration = join(root, 'migrations', '021_tenant_media_event_identity.sql');
const migration = join(root, 'migrations', '022_media_event_null_id_dedupe.sql');
const CLIENT = '11111111-1111-4111-8111-111111111111';
const EVENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const EVENT_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const MEMORY_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const MEMORY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

let container = '';
let url = '';

test.before(async () => {
  container = execFileSync('docker', ['run','--rm','-d','-e','POSTGRES_PASSWORD=postgres','-p','127.0.0.1::5432','postgres:16'], { encoding: 'utf8' }).trim();
  const port = execFileSync('docker', ['port',container,'5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  await waitForPostgres();
});

test.after(() => { if (container) execFileSync('docker',['rm','-f',container],{stdio:'ignore'}); });

test('preview is bounded and read-only; apply requires exact backup-backed approval and is idempotent', async (t) => {
  await seed();
  const before = await snapshot();
  const preview = await repairMediaEventDuplicates({ connectionString: url, maxGroups: 10, maxEventsPerGroup: 10 });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.totalGroups, 1);
  assert.equal(preview.groups[0].complete, true);
  assert.equal(preview.groups[0].events.length, 2);
  assert.equal(preview.groups[0].memories.length, 2);
  assert.deepEqual(await snapshot(), before);

  const group = preview.groups[0];
  const approval: DuplicateGroupApproval = {
    groupKey: group.groupKey,
    groupFingerprint: group.groupFingerprint,
    clientId: group.clientId,
    service: group.service,
    playedAt: group.playedAt,
    retainedEventId: EVENT_B,
    retainedMemoryId: MEMORY_A,
    events: group.events.map(event => ({ id: event.id, fingerprint: event.fingerprint, action: event.id === EVENT_B ? 'retain' : 'delete' })),
    memories: group.memories.map(memory => ({ id: memory.id, fingerprint: memory.fingerprint, action: memory.id === MEMORY_A ? 'retain' : 'delete' })),
  };

  await t.test('missing backup, incomplete/broad approval, ambiguous retention, and drift all refuse without writes', async () => {
    await assert.rejects(() => repairMediaEventDuplicates({ connectionString:url, apply:true, approvals:[approval] }), /verified restorable backup/i);
    await assert.rejects(() => repairMediaEventDuplicates({ connectionString:url, apply:true, confirmBackup:true, approvals:[{...approval, events: approval.events.slice(0,1)}] }), /complete|exact/i);
    await assert.rejects(() => repairMediaEventDuplicates({ connectionString:url, apply:true, confirmBackup:true, approvals:[{...approval, retainedMemoryId:null, memories: approval.memories.map(memory => ({...memory, action:'delete' as const}))}] }), /retained memory|ambiguous/i);
    await assert.rejects(() => repairMediaEventDuplicates({ connectionString:url, apply:true, confirmBackup:true, approvals:[{...approval, groupFingerprint:'0'.repeat(64)}] }), /drift|fingerprint/i);
    assert.deepEqual(await snapshot(), before);
  });

  await setRoleTimezone('Pacific/Auckland');
  try {
    const owner = new pg.Client({ connectionString:url }); await owner.connect();
    try {
      await owner.query(`UPDATE memories SET accessed_at=NOW(), access_count=access_count+1, last_boosted_at=NOW(), relevance_score=0.5, updated_at=NOW()`);
    } finally { await owner.end(); }
    const afterRecall = await repairMediaEventDuplicates({ connectionString: url, maxGroups: 10, maxEventsPerGroup: 10 });
    assert.equal(afterRecall.groups[0].groupKey, group.groupKey, 'group keys are stable across session timezones');
    assert.equal(afterRecall.groups[0].groupFingerprint, group.groupFingerprint, 'recall and decay bookkeeping do not invalidate approval');

    const applied = await repairMediaEventDuplicates({ connectionString:url, apply:true, confirmBackup:true, approvals:[approval] });
    assert.equal(applied.deletedEvents, 1);
    assert.equal(applied.deletedMemories, 1);
  } finally {
    await setRoleTimezone('UTC');
  }
  const owner = new pg.Client({ connectionString:url });
  await owner.connect();
  try {
    const events = await owner.query<{id:string;memory_id:string}>(`SELECT id::text,memory_id::text FROM media_events ORDER BY id`);
    assert.deepEqual(events.rows, [{ id: EVENT_B, memory_id: MEMORY_A }]);
    assert.deepEqual((await owner.query<{id:string}>(`SELECT id::text FROM memories ORDER BY id`)).rows, [{id:MEMORY_A}]);
    await owner.query(readFileSync(tenantIdentityMigration,'utf8'));
    await owner.query(readFileSync(migration,'utf8'));
  } finally { await owner.end(); }

  const repeated = await repairMediaEventDuplicates({ connectionString:url, apply:true, confirmBackup:true, approvals:[approval] });
  assert.equal(repeated.outcomes[0].status, 'already-reconciled');
});

test('opaque group keys recheck the exact approval and support an explicit oversized-group bound', async () => {
  await seedManyDuplicateGroups();
  const preview = await repairMediaEventDuplicates({ connectionString: url, maxGroups: 10, maxEventsPerGroup: 1_000 });
  assert.equal(preview.groups.length, 4);
  assert.ok(preview.groups.every(group => /^[a-f0-9]{64}$/.test(group.groupKey)), 'database group keys are opaque');

  const ordinaryGroups = preview.groups.filter(group => group.totalEvents === 2);
  assert.equal(ordinaryGroups.length, 3);
  const approvedGroup = ordinaryGroups[2];
  const ordinaryApproval: DuplicateGroupApproval = {
    groupKey: approvedGroup.groupKey,
    groupFingerprint: approvedGroup.groupFingerprint,
    clientId: approvedGroup.clientId,
    service: approvedGroup.service,
    playedAt: approvedGroup.playedAt,
    retainedEventId: approvedGroup.events[0].id,
    retainedMemoryId: null,
    events: approvedGroup.events.map((event, index) => ({ ...event, action: index === 0 ? 'retain' as const : 'delete' as const })),
    memories: [],
  };
  const appliedOrdinary = await repairMediaEventDuplicates({ connectionString: url, apply: true, confirmBackup: true, approvals: [ordinaryApproval] });
  assert.equal(appliedOrdinary.deletedEvents, 1, 'apply selects the approved key even when it is outside a two-group window');

  const oversized = preview.groups.find(group => group.totalEvents === 1_001)!;
  assert.equal(oversized.complete, false);
  assert.equal(oversized.events.length, 1_000);
  const targeted = await repairMediaEventDuplicates({
    connectionString: url,
    targetGroupKey: oversized.groupKey,
    targetMaxEventsPerGroup: 1_001,
  });
  assert.equal(targeted.totalGroups, 1);
  assert.equal(targeted.groups.length, 1);
  assert.equal(targeted.groups[0].groupKey, oversized.groupKey);
  assert.equal(targeted.groups[0].complete, true);
  assert.equal(targeted.groups[0].events.length, 1_001);

  const targetedApproval: DuplicateGroupApproval = {
    groupKey: targeted.groups[0].groupKey,
    groupFingerprint: targeted.groups[0].groupFingerprint,
    clientId: targeted.groups[0].clientId,
    service: targeted.groups[0].service,
    playedAt: targeted.groups[0].playedAt,
    retainedEventId: targeted.groups[0].events[0].id,
    retainedMemoryId: null,
    events: targeted.groups[0].events.map((event, index) => ({ ...event, action: index === 0 ? 'retain' as const : 'delete' as const })),
    memories: [],
  };
  const appliedTargeted = await repairMediaEventDuplicates({
    connectionString: url,
    apply: true,
    confirmBackup: true,
    approvals: [targetedApproval],
    targetMaxEventsPerGroup: 1_001,
  });
  assert.equal(appliedTargeted.deletedEvents, 1_000);
});

async function seed(): Promise<void> {
  const client = new pg.Client({ connectionString:url }); await client.connect();
  try {
    await client.query(`DROP TABLE IF EXISTS media_events,memories CASCADE; DROP FUNCTION IF EXISTS public.media_event_effective_identity(text,text,text,text,text,text,integer,integer,integer,integer);`);
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      DO $$ BEGIN CREATE ROLE total_recall_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE memories(
        id uuid PRIMARY KEY, content text NOT NULL, metadata jsonb DEFAULT '{}', source text DEFAULT 'media',
        namespace text DEFAULT 'media', tags text[] DEFAULT '{}', access_level text DEFAULT 'normal', client_id uuid,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), accessed_at timestamptz DEFAULT now(),
        access_count integer DEFAULT 0, relevance_score float DEFAULT 1.0, decay_rate float DEFAULT 0.01,
        last_boosted_at timestamptz DEFAULT now());
      CREATE TABLE media_events(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service text NOT NULL, service_id text, event_type text NOT NULL,
        title text NOT NULL, artist text, album text, show text, season integer, episode integer, year integer,
        genres text[] DEFAULT '{}', duration_ms integer, played_ms integer, completed boolean, played_at timestamptz NOT NULL,
        metadata jsonb DEFAULT '{}', client_id uuid, agent_id uuid, memory_id uuid REFERENCES memories(id), created_at timestamptz DEFAULT now(),
        UNIQUE(service,service_id,played_at));
      INSERT INTO memories(id,content,metadata) VALUES
        ('${MEMORY_A}','chosen memory','{"version":1}'),('${MEMORY_B}','discarded memory','{"version":2}');
      INSERT INTO media_events(id,service,event_type,title,year,genres,played_ms,played_at,metadata,client_id,memory_id) VALUES
        ('${EVENT_A}','plex','watch','Arrival',2016,ARRAY['sci-fi'],10,'2026-07-01T20:00:00Z','{"source":"old"}','${CLIENT}','${MEMORY_A}'),
        ('${EVENT_B}','plex','watch','Arrival',2016,ARRAY['drama'],20,'2026-07-01T20:00:00Z','{"source":"new"}','${CLIENT}','${MEMORY_B}');
    `);
  } finally { await client.end(); }
}

async function seedManyDuplicateGroups(): Promise<void> {
  const client = new pg.Client({ connectionString: url }); await client.connect();
  try {
    await client.query(`DROP TABLE IF EXISTS media_events,memories CASCADE; DROP FUNCTION IF EXISTS public.media_event_effective_identity(text,text,text,text,text,text,integer,integer,integer,integer);`);
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE memories(id uuid PRIMARY KEY, content text NOT NULL, metadata jsonb DEFAULT '{}');
      CREATE TABLE media_events(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service text NOT NULL, service_id text, event_type text NOT NULL,
        title text NOT NULL, artist text, album text, show text, season integer, episode integer, year integer,
        genres text[] DEFAULT '{}', duration_ms integer, played_ms integer, completed boolean, played_at timestamptz NOT NULL,
        metadata jsonb DEFAULT '{}', client_id uuid, agent_id uuid, memory_id uuid REFERENCES memories(id), created_at timestamptz DEFAULT now(),
        UNIQUE(service,service_id,played_at));
      INSERT INTO media_events(service,event_type,title,played_at,client_id)
      SELECT 'plex','watch', title, '2026-07-02T20:00:00Z', '${CLIENT}'
      FROM unnest(ARRAY['Alpha','Beta','Gamma']) title, generate_series(1,2);
      INSERT INTO media_events(service,event_type,title,played_at,client_id)
      SELECT 'plex','watch','Runaway', '2026-07-03T20:00:00Z', '${CLIENT}' FROM generate_series(1,1001);
    `);
  } finally { await client.end(); }
}

async function setRoleTimezone(timezone: string): Promise<void> {
  const client = new pg.Client({ connectionString: url }); await client.connect();
  try { await client.query(`ALTER ROLE postgres SET timezone TO '${timezone}'`); }
  finally { await client.end(); }
}

async function snapshot(): Promise<unknown> {
  const client = new pg.Client({connectionString:url}); await client.connect();
  try {
    return {
      events:(await client.query(`SELECT row_to_json(e)::text AS row FROM media_events e ORDER BY id`)).rows,
      memories:(await client.query(`SELECT row_to_json(m)::text AS row FROM memories m ORDER BY id`)).rows,
    };
  } finally { await client.end(); }
}

async function waitForPostgres(): Promise<void> {
  for(let i=0;i<60;i++) { const c=new pg.Client({connectionString:url}); try { await c.connect(); await c.query('SELECT 1'); await c.end(); return; } catch { await c.end().catch(()=>undefined); await new Promise(r=>setTimeout(r,250)); } }
  throw new Error('PostgreSQL did not start');
}
