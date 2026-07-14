import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import pg from 'pg';
import { repairMediaRollupTags } from '../scripts/repair-media-rollup-tags.js';

const KEY_ID = '11111111-1111-4111-8111-111111111111';

test('media tag repair is bounded, dry-run safe, deterministic, idempotent, and scoped to linked rollups', async () => {
  const image = process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16';
  const containerId = execFileSync('docker', ['run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=postgres', '-p', '127.0.0.1::5432', image], { encoding: 'utf8' }).trim();
  let owner: pg.Client | undefined;
  try {
    const port = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
    const ownerUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    await waitForPostgres(ownerUrl);
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    await owner.query(`
      CREATE ROLE total_recall_app LOGIN PASSWORD 'repair_app';
      CREATE TABLE api_keys (id uuid PRIMARY KEY);
      CREATE TABLE memories (id uuid PRIMARY KEY, source text NOT NULL, namespace text NOT NULL, tags text[] NOT NULL, client_id text NOT NULL, updated_at timestamptz DEFAULT now(), deleted_at timestamptz, superseded_at timestamptz);
      CREATE TABLE documents (id uuid PRIMARY KEY, namespace text NOT NULL);
      CREATE TABLE agents (id uuid PRIMARY KEY, name text, api_key_id uuid);
      CREATE TABLE recall_traces (id uuid PRIMARY KEY, client_id text);
      CREATE TABLE audit_log (id uuid PRIMARY KEY, client_id text);
      CREATE TABLE media_events (
        id uuid PRIMARY KEY, service text NOT NULL, service_id text, event_type text NOT NULL, title text NOT NULL,
        artist text, album text, show text, season int, episode int, year int, genres text[], duration_ms int,
        played_ms int, completed boolean, played_at timestamptz NOT NULL, metadata jsonb, client_id uuid,
        agent_id uuid, memory_id uuid, created_at timestamptz DEFAULT now()
      );
    `);
    await owner.query(readFileSync(new URL('../migrations/013_rls_context.sql', import.meta.url), 'utf8'));
    await owner.query(readFileSync(new URL('../migrations/014_metadata_rls.sql', import.meta.url), 'utf8'));
    await owner.query(`
      GRANT SELECT ON api_keys TO total_recall_app;
      GRANT SELECT, UPDATE ON memories TO total_recall_app;
      INSERT INTO api_keys VALUES ('${KEY_ID}');
      INSERT INTO memories (id, source, namespace, tags, client_id) VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'media:spotify', 'media', ARRAY['media','spotify','play','movie','old-custom'], '${KEY_ID}'),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'media:plex', 'media', ARRAY['media','plex','watch','movie'], '${KEY_ID}'),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'manual', 'media', ARRAY['movie'], '${KEY_ID}'),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', 'media:other', 'media', ARRAY['movie'], '${KEY_ID}'),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', 'media:spotify', 'media', ARRAY['movie'], '${KEY_ID}');
      UPDATE memories SET deleted_at = '2026-01-01T00:00:00Z'
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5';
      INSERT INTO media_events (id, service, event_type, title, artist, album, show, season, episode, year, genres, duration_ms, played_ms, completed, played_at, metadata, client_id, memory_id) VALUES
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'spotify', 'play', 'Track', NULL, NULL, NULL, NULL, NULL, NULL, ARRAY['ROCK'], NULL, NULL, true, '2026-01-01', '{}', '${KEY_ID}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'plex', 'watch', 'Movie', NULL, NULL, NULL, NULL, NULL, NULL, ARRAY[]::text[], NULL, NULL, NULL, '2026-01-02', '{"plex_type":"movie"}', '${KEY_ID}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', 'spotify', 'play', 'Manual', NULL, NULL, NULL, NULL, NULL, NULL, ARRAY[]::text[], NULL, NULL, NULL, '2026-01-03', '{}', '${KEY_ID}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', 'other', 'watch', 'Mystery', NULL, NULL, NULL, NULL, NULL, NULL, ARRAY['MOVIE','Drama'], NULL, NULL, NULL, '2026-01-04', '{}', '${KEY_ID}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5', 'spotify', 'play', 'Deleted', NULL, NULL, NULL, NULL, NULL, NULL, ARRAY['ROCK'], NULL, NULL, true, '2026-01-05', '{}', '${KEY_ID}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5');
    `);

    const connectionString = `postgresql://total_recall_app:repair_app@127.0.0.1:${port}/postgres`;
    const before = await loadTags(owner);
    await assert.rejects(
      repairMediaRollupTags({ connectionString, batchSize: 1, maxRows: 1 }),
      /backup confirmation/i,
    );
    const dryRun = await repairMediaRollupTags({ connectionString, batchSize: 2, maxRows: 100, dryRun: true });
    assert.deepEqual(dryRun, { scannedRows: 3, differingRows: 2, updatedRows: 0, batches: 2, dryRun: true, limitReached: false, nextCursor: null });
    assert.deepEqual(await loadTags(owner), before);

    let cursor: string | undefined;
    let totalUpdated = 0;
    let runs = 0;
    do {
      const applied = await repairMediaRollupTags({ connectionString, batchSize: 1, maxRows: 1, cursor, confirmBackup: true });
      totalUpdated += applied.updatedRows;
      cursor = applied.nextCursor ?? undefined;
      runs += 1;
      assert.ok(runs < 10, 'repair cursor must make progress');
    } while (cursor);
    assert.equal(totalUpdated, 2);
    assert.equal(runs, 4, 'three bounded pages plus one exhaustion check');
    const tags = await loadTags(owner);
    assert.deepEqual(tags.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'), ['media', 'spotify', 'play', 'music', 'completed', 'rock']);
    assert.deepEqual(tags.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'), ['media', 'plex', 'watch', 'movie']);
    assert.deepEqual(tags.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'), ['movie']);
    assert.deepEqual(tags.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'), ['media', 'other', 'watch', 'unknown', 'drama']);
    assert.deepEqual(tags.get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'), ['movie']);

    const repeated = await repairMediaRollupTags({ connectionString, batchSize: 10, maxRows: 100, confirmBackup: true });
    assert.equal(repeated.updatedRows, 0);
    assert.equal(repeated.differingRows, 0);
    assert.equal(repeated.nextCursor, null);
  } finally {
    await owner?.end().catch(() => undefined);
    execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
  }
});

async function loadTags(client: pg.Client): Promise<Map<string, string[]>> {
  const result = await client.query<{ id: string; tags: string[] }>('SELECT id::text, tags FROM memories ORDER BY id');
  return new Map(result.rows.map((row) => [row.id, row.tags]));
}

async function waitForPostgres(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect(); await client.query('SELECT 1'); await client.end(); return;
    } catch (error) {
      lastError = error; await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}
