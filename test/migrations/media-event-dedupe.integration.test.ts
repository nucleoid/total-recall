import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const tenantIdentityMigration = join(root, 'migrations', '021_tenant_media_event_identity.sql');
const migration = join(root, 'migrations', '022_media_event_null_id_dedupe.sql');
const CLIENT = '11111111-1111-4111-8111-111111111111';
const PLAYED = '2026-07-01T20:00:00Z';

let container = '';
let url = '';

test.before(async () => {
  container = execFileSync('docker', ['run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=postgres', '-p', '127.0.0.1::5432', 'postgres:16'], { encoding: 'utf8' }).trim();
  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  await waitForPostgres();
});

test.after(() => {
  if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
});

test('post-#8 migration preserves provider identity and adds the immutable effective identity index', async () => {
  const client = await freshSchema();
  try {
    await client.query(readFileSync(migration, 'utf8'));
    const routine = await client.query<{ provolatile: string; proconfig: string[] | null }>(`
      SELECT provolatile, proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='media_event_effective_identity'
    `);
    assert.equal(routine.rows[0].provolatile, 'i');
    assert.ok(routine.rows[0].proconfig?.some(value => value === 'search_path=pg_catalog, public'));
    const providerConstraint = await client.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      WHERE c.conrelid = 'public.media_events'::regclass
        AND c.conname = 'media_events_client_service_identity_key'
    `);
    assert.match(providerConstraint.rows[0].definition, /UNIQUE \(client_id, service, service_id, played_at\)/i);
    const index = await client.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname='media_events_effective_identity_uidx'`);
    assert.match(index.rows[0].indexdef, /UNIQUE INDEX/i);
    assert.match(index.rows[0].indexdef, /client_id/i);

    const vector = await client.query<{ identity: string }>(`
      SELECT public.media_event_effective_identity(NULL, 'play', 'A|💿', NULL, '', 'Show', -1, 0, 2026, 123)::text AS identity
    `);
    assert.equal(vector.rows[0].identity, expectedFallback(['play', 'A|💿', null, '', 'Show', -1, 0, 2026, 123]));
    const exactId = await client.query<{ identity: string }>(`
      SELECT public.media_event_effective_identity('  id  ', 'play', 'ignored', NULL,NULL,NULL,NULL,NULL,NULL,NULL)::text AS identity
    `);
    assert.equal(exactId.rows[0].identity, 'id:  id  ');
  } finally { await client.end(); }
});

test('database dedupes null/blank and mutable enrichment, while stable differences and later plays insert', async () => {
  const client = await freshSchema();
  try {
    await client.query(readFileSync(migration, 'utf8'));
    const insert = async (overrides: Record<string, unknown> = {}) => {
      const value = { service_id: null, title: 'Arrival', artist: null, genres: ['film'], played_ms: 1, played_at: PLAYED, ...overrides };
      return client.query(`INSERT INTO media_events
        (service,service_id,event_type,title,artist,genres,duration_ms,played_ms,played_at,metadata,client_id)
        VALUES ('plex',$1,'watch',$2,$3,$4,100,$5,$6,$7,$8)
        ON CONFLICT DO NOTHING RETURNING id`, [value.service_id,value.title,value.artist,value.genres,value.played_ms,value.played_at,JSON.stringify(overrides.metadata ?? {}),CLIENT]);
    };
    assert.equal((await insert()).rowCount, 1);
    assert.equal((await insert({ service_id: '   ', genres: ['changed'], played_ms: 99, metadata: { enriched: true } })).rowCount, 0);
    assert.equal((await insert({ title: 'Different' })).rowCount, 1);
    assert.equal((await insert({ played_at: '2026-07-01T21:00:00Z' })).rowCount, 1);
    assert.equal((await insert({ service_id: 'provider-id' })).rowCount, 1);
    assert.equal((await insert({ service_id: 'provider-id' })).rowCount, 0);
    assert.equal((await insert({ service_id: 'provider-id', played_at: '2026-07-02T20:00:00Z' })).rowCount, 1);
  } finally { await client.end(); }
});

test('concurrent identical null-ID inserts produce one insert and one skip', async () => {
  const owner = await freshSchema();
  try {
    await owner.query(readFileSync(migration, 'utf8'));
    const left = new pg.Client({ connectionString: url });
    const right = new pg.Client({ connectionString: url });
    await Promise.all([left.connect(), right.connect()]);
    const sql = `INSERT INTO media_events(service,event_type,title,played_at,client_id)
      VALUES ('plex','watch','Concurrent',$1,$2) ON CONFLICT DO NOTHING RETURNING id`;
    const results = await Promise.all([left.query(sql,[PLAYED,CLIENT]), right.query(sql,[PLAYED,CLIENT])]);
    assert.deepEqual(results.map(result => result.rowCount).sort(), [0, 1]);
    await Promise.all([left.end(), right.end()]);
  } finally { await owner.end(); }
});

test('duplicate preflight aborts without changing events or linked memories', async () => {
  const client = await freshSchema();
  try {
    await client.query(`INSERT INTO memories(id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2')`);
    await client.query(`INSERT INTO media_events(service,event_type,title,played_at,client_id,memory_id)
      VALUES ('plex','watch','Duplicate',$1,$2,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
             ('plex','watch','Duplicate',$1,$2,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2')`, [PLAYED, CLIENT]);
    await assert.rejects(() => client.query(readFileSync(migration, 'utf8')), /duplicate groups.*rows/i);
    const state = await client.query<{ events: number; links: number }>(`SELECT count(*)::int AS events, count(memory_id)::int AS links FROM media_events`);
    assert.deepEqual(state.rows[0], { events: 2, links: 2 });
    assert.equal((await client.query(`SELECT 1 FROM memories`)).rowCount, 2);
  } finally { await client.end(); }
});

async function freshSchema(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP TABLE IF EXISTS media_events, memories CASCADE; DROP FUNCTION IF EXISTS public.media_event_effective_identity(text,text,text,text,text,text,integer,integer,integer,integer);');
  await client.query(`
    DO $$ BEGIN CREATE ROLE total_recall_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE memories(id uuid PRIMARY KEY);
    CREATE TABLE media_events(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service text NOT NULL, service_id text,
      event_type text NOT NULL, title text NOT NULL, artist text, album text, show text,
      season integer, episode integer, year integer, genres text[] DEFAULT '{}', duration_ms integer,
      played_ms integer, completed boolean, played_at timestamptz NOT NULL, metadata jsonb DEFAULT '{}',
      client_id uuid, agent_id uuid, memory_id uuid REFERENCES memories(id), created_at timestamptz DEFAULT now(),
      UNIQUE(service,service_id,played_at)
    );
  `);
  await client.query(readFileSync(tenantIdentityMigration, 'utf8'));
  return client;
}

function expectedFallback(values: unknown[]): string {
  const token = (value: unknown) => value === null ? 'N;' : `V${Buffer.byteLength(String(value), 'utf8')}:${String(value)};`;
  return `fallback:v1:${createHash('sha256').update(`v1;${values.map(token).join('')}`).digest('hex')}`;
}

async function waitForPostgres(): Promise<void> {
  for (let attempt=0; attempt<60; attempt++) {
    const client = new pg.Client({ connectionString: url });
    try { await client.connect(); await client.query('SELECT 1'); await client.end(); return; }
    catch { await client.end().catch(() => undefined); await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  throw new Error('PostgreSQL did not start');
}
