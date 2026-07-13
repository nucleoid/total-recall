import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import pg from 'pg';
import { repairMediaRollupDates } from '../scripts/repair-media-rollup-dates.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

async function waitForPostgres(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect(); await client.query('SELECT 1'); await client.end(); return;
    } catch { await client.end().catch(() => undefined); await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('PostgreSQL did not become ready');
}

test('repair is dry-run by default, atomically applies matching rows, resumes by tuple, and detects races', async () => {
  const containerId = execFileSync('docker', ['run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=postgres', '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16'], { encoding: 'utf8' }).trim();
  let client: pg.Client | undefined;
  try {
    const port = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
    const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    await waitForPostgres(url);
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`
      CREATE EXTENSION vector;
      CREATE ROLE repair_app LOGIN PASSWORD 'repair_app';
      CREATE TABLE memories (
        id uuid PRIMARY KEY, content text NOT NULL, embedding vector(3), source text NOT NULL,
        namespace text NOT NULL, tags text[] NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}',
        updated_at timestamptz NOT NULL DEFAULT now(), client_id uuid
      );
      CREATE TABLE media_events (
        id uuid PRIMARY KEY, service text NOT NULL, service_id text, event_type text NOT NULL,
        title text NOT NULL, artist text, album text, show text, season int, episode int, year int,
        genres text[] NOT NULL DEFAULT '{}', duration_ms int, played_ms int, completed boolean,
        played_at timestamptz NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', client_id uuid,
        agent_id uuid, memory_id uuid, created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
      ALTER TABLE media_events ENABLE ROW LEVEL SECURITY;
      CREATE POLICY repair_memories_select ON memories FOR SELECT USING (
        namespace = ANY(ARRAY(SELECT jsonb_array_elements_text(COALESCE(NULLIF(current_setting('app.allowed_namespaces', true), '')::jsonb, '[]'::jsonb))))
      );
      CREATE POLICY repair_memories_update ON memories FOR UPDATE USING (
        namespace = ANY(ARRAY(SELECT jsonb_array_elements_text(COALESCE(NULLIF(current_setting('app.allowed_namespaces', true), '')::jsonb, '[]'::jsonb))))
      ) WITH CHECK (
        namespace = ANY(ARRAY(SELECT jsonb_array_elements_text(COALESCE(NULLIF(current_setting('app.allowed_namespaces', true), '')::jsonb, '[]'::jsonb))))
      );
      CREATE POLICY repair_events_select ON media_events FOR SELECT USING (
        current_setting('app.current_key_is_admin', true) = 'true'
        OR client_id = NULLIF(current_setting('app.current_key_id', true), '')::uuid
      );
      CREATE POLICY repair_events_update ON media_events FOR UPDATE USING (
        client_id = NULLIF(current_setting('app.current_key_id', true), '')::uuid
      ) WITH CHECK (
        client_id = NULLIF(current_setting('app.current_key_id', true), '')::uuid
      );
      GRANT SELECT, UPDATE ON memories TO repair_app;
      GRANT SELECT, UPDATE ON media_events TO repair_app;
      INSERT INTO memories (id, content, embedding, source, namespace, client_id) VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Watched "Arrival" (2016) on 2026-01-02 via plex. Completed.', '[0,0,0]', 'media:plex', 'media', '${CLIENT_ID}'),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'Watched "Dune" (2021) on 2026-01-01 via plex. Completed.', '[0,0,0]', 'media:plex', 'media', '${CLIENT_ID}'),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'unrelated', '[0,0,0]', 'manual', 'media', '${CLIENT_ID}');
      INSERT INTO media_events (id, service, service_id, event_type, title, year, completed, played_at, client_id, memory_id) VALUES
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'plex', '1', 'watch', 'Arrival', 2016, true, '2026-01-02T02:00:00Z', '${CLIENT_ID}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'plex', '2', 'watch', 'Dune', 2021, true, '2026-01-02T03:00:00Z', '${CLIENT_ID}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', 'plex', '3', 'watch', 'Ignored', null, true, '2026-01-02T04:00:00Z', '${CLIENT_ID}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3');
    `);

    const appUrl = `postgresql://repair_app:repair_app@127.0.0.1:${port}/postgres`;
    let embeds = 0;
    const dryRun = await repairMediaRollupDates({ connectionString: appUrl, timeZone: 'America/Chicago', embed: async () => { embeds++; return [1, 2, 3]; } });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.wouldChange, 1);
    assert.equal(embeds, 0);
    assert.deepEqual(dryRun.checkpoint, { playedAt: '2026-01-02T03:00:00.000Z', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2' });

    const applied = await repairMediaRollupDates({ connectionString: appUrl, timeZone: 'America/Chicago', apply: true, batchSize: 1, embed: async () => { embeds++; return [1, 2, 3]; } });
    assert.equal(applied.updated, 1);
    assert.equal(applied.unchanged, 1);
    assert.equal(embeds, 1);
    const repaired = await client.query<{ content: string; embedding: string; tags: string[]; metadata: Record<string, unknown> }>(`SELECT content, embedding::text, tags, metadata FROM memories WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'`);
    assert.match(repaired.rows[0].content, /on 2026-01-01 via plex/);
    assert.equal(repaired.rows[0].embedding, '[1,2,3]');
    assert.deepEqual(repaired.rows[0].tags, ['media', 'plex', 'watch', 'unknown', 'completed']);
    assert.equal(repaired.rows[0].metadata.played_at, '2026-01-02T02:00:00.000Z');

    await client.query(`UPDATE memories SET content = 'Watched "Arrival" (2016) on 2026-01-02 via plex. Completed.', embedding = '[0,0,0]' WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'`);
    const raced = await repairMediaRollupDates({
      connectionString: appUrl, timeZone: 'America/Chicago', apply: true,
      afterPlayedAt: '2026-01-02T01:00:00Z', afterId: '00000000-0000-4000-8000-000000000000',
      embed: async () => {
        await client!.query(`UPDATE memories SET content = 'concurrently changed', updated_at = now() + interval '1 second' WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'`);
        return [9, 9, 9];
      },
    });
    assert.equal(raced.skippedConcurrent, 1);
    assert.equal(raced.scanned, 1, 'a frozen checkpoint must stop later rows from being scanned');
    assert.deepEqual(raced.checkpoint, {
      playedAt: '2026-01-02T01:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000000',
    }, 'resume must retry the concurrently skipped row');
    const concurrent = await client.query<{ content: string; embedding: string }>(`SELECT content, embedding::text FROM memories WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'`);
    assert.equal(concurrent.rows[0].content, 'concurrently changed');
    assert.equal(concurrent.rows[0].embedding, '[0,0,0]');

    await client.query(`UPDATE memories SET content = 'stale UTC summary', updated_at = now() + interval '2 seconds' WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'`);
    const reconciled = await repairMediaRollupDates({
      connectionString: appUrl,
      timeZone: 'America/Chicago',
      apply: true,
      embed: async () => [7, 7, 7],
    });
    assert.equal(reconciled.updated, 1, 'a final no-cursor pass reconciles a prior concurrent skip');
    assert.equal(reconciled.skippedConcurrent, 0);

    await client.query(`
      UPDATE memories
         SET content = CASE id
           WHEN 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' THEN 'stale UTC summary 1'
           WHEN 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' THEN 'stale UTC summary 2'
         END,
             updated_at = now() + interval '3 seconds'
       WHERE id IN ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2')
    `);
    let providerCalls = 0;
    const failed = await repairMediaRollupDates({
      connectionString: appUrl,
      timeZone: 'America/Chicago',
      apply: true,
      embed: async () => { providerCalls++; throw new Error('provider throttled'); },
    });
    assert.equal(providerCalls, 1, 'provider failure aborts without churning remaining rows');
    assert.equal(failed.scanned, 1);
    assert.equal(failed.failed, 1);
    assert.equal(failed.errors.length, 1, 'reported errors stay bounded');
    assert.match(failed.errors[0], /event bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1: provider throttled/);
    assert.equal(failed.checkpoint, null, 'resume checkpoint must remain before the first failed row');
  } finally {
    await client?.end().catch(() => undefined);
    execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
  }
});
