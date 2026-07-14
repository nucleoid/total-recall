import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import pg from 'pg';
import { repairSpotifyProgress } from '../scripts/repair-spotify-progress.js';

const KEY_ID = '11111111-1111-4111-8111-111111111111';
const MATCH_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const PARTIAL_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const AMBIGUOUS_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const WRONG_SOURCE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8';
const MISSING_MEMORY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9';

test('preview and apply work through production-shaped non-owner RLS scope', async () => {
  await withDatabase(async ({ appUrl, owner }) => {
    const preview = await repairSpotifyProgress({ connectionString: appUrl, maxRows: 20 });
    const approval = preview.candidates.find((candidate) => candidate.id === MATCH_ID)!;
    assert.ok(approval);

    const applied = await repairSpotifyProgress({
      connectionString: appUrl, apply: true, confirmBackup: true, approvals: [approval],
    });
    assert.equal(applied.updatedEvents, 1);
    assert.deepEqual(
      (await owner.query('SELECT played_ms, completed FROM media_events WHERE id = $1', [MATCH_ID])).rows[0],
      { played_ms: null, completed: null },
    );
  });
});

test('preview is the default, writes nothing, and reports only bounded matching candidates with fingerprints', async () => {
  await withDatabase(async ({ ownerUrl, owner }) => {
    const before = await snapshot(owner);
    const result = await repairSpotifyProgress({ connectionString: ownerUrl, maxRows: 1 });

    assert.equal(result.dryRun, true);
    assert.equal(result.totalCandidates, 4);
    assert.equal(result.truncated, true);
    assert.equal(result.updatedEvents, 0);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].id, MATCH_ID);
    assert.equal(result.candidates[0].clientId, KEY_ID);
    assert.match(result.candidates[0].fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(await snapshot(owner), before);
  });
});

test('apply requires backup and exact approvals, rejects drift, and preserves unrelated event and memory state', async () => {
  await withDatabase(async ({ ownerUrl, owner }) => {
    const preview = await repairSpotifyProgress({ connectionString: ownerUrl, maxRows: 10 });
    const approval = preview.candidates.find((candidate) => candidate.id === MATCH_ID)!;

    await assert.rejects(
      repairSpotifyProgress({ connectionString: ownerUrl, apply: true, maxRows: 20_000, approvals: [approval] }),
      /backup/i,
      'preview bounds are irrelevant in apply mode',
    );
    await assert.rejects(
      repairSpotifyProgress({ connectionString: ownerUrl, apply: true, confirmBackup: true, approvals: [] }),
      /explicit.*approval/i,
    );
    await assert.rejects(
      repairSpotifyProgress({ connectionString: ownerUrl, apply: true, confirmBackup: true, approvals: [approval, approval] }),
      /duplicate/i,
    );
    await assert.rejects(
      repairSpotifyProgress({
        connectionString: ownerUrl,
        apply: true,
        confirmBackup: true,
        approvals: [{ ...approval, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
      }),
      /unapproved|missing|nonmatching/i,
    );

    await owner.query(`UPDATE media_events SET duration_ms = 201 WHERE id = $1`, [MATCH_ID]);
    await assert.rejects(
      repairSpotifyProgress({ connectionString: ownerUrl, apply: true, confirmBackup: true, approvals: [approval] }),
      /drift/i,
    );
    await owner.query(`UPDATE media_events SET duration_ms = 200 WHERE id = $1`, [MATCH_ID]);

    const beforeOther = await owner.query('SELECT * FROM media_events WHERE id <> $1 ORDER BY id', [MATCH_ID]);
    const applied = await repairSpotifyProgress({
      connectionString: ownerUrl,
      apply: true,
      confirmBackup: true,
      approvals: [approval],
    });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.updatedEvents, 1);
    assert.equal(applied.updatedMemories, 1);
    assert.equal(applied.outcomes[0].status, 'updated');

    const event = await owner.query('SELECT played_ms, completed FROM media_events WHERE id = $1', [MATCH_ID]);
    assert.deepEqual(event.rows[0], { played_ms: null, completed: null });
    const memory = await owner.query('SELECT tags, metadata, content, embedding FROM memories WHERE id = $1', ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1']);
    assert.deepEqual(memory.rows[0].tags, ['media', 'completed-remix', 'favorite']);
    assert.deepEqual(memory.rows[0].metadata, { duration_ms: 200, keep: 'yes' });
    assert.equal(memory.rows[0].content, 'unchanged summary');
    assert.equal(memory.rows[0].embedding, '[1,2,3]');
    const afterOther = await owner.query('SELECT * FROM media_events WHERE id <> $1 ORDER BY id', [MATCH_ID]);
    assert.deepEqual(afterOther.rows, beforeOther.rows);
  });
});

test('tombstoned linked memories remain byte-for-byte unchanged while the approved event repair proceeds', async () => {
  await withDatabase(async ({ ownerUrl, owner }) => {
    const preview = await repairSpotifyProgress({ connectionString: ownerUrl, maxRows: 20 });
    const approval = preview.candidates.find((candidate) => candidate.id === MATCH_ID)!;
    await owner.query(`UPDATE memories SET deleted_at = NOW() WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'`);
    const before = await owner.query(`SELECT row_to_json(m)::text AS row FROM memories m WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'`);

    const applied = await repairSpotifyProgress({
      connectionString: ownerUrl, apply: true, confirmBackup: true, approvals: [approval],
    });
    assert.equal(applied.updatedEvents, 1);
    assert.equal(applied.updatedMemories, 0);
    assert.equal(applied.outcomes[0].memory, 'missing-or-unrelated');
    const after = await owner.query(`SELECT row_to_json(m)::text AS row FROM memories m WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'`);
    assert.deepEqual(after.rows, before.rows);
  });
});

test('guard cases stay untouched, missing or unrelated rollups are safe, relinks drift, and reruns are idempotent', async () => {
  await withDatabase(async ({ ownerUrl, owner }) => {
    const preview = await repairSpotifyProgress({ connectionString: ownerUrl, maxRows: 20 });
    const approval = (id: string) => preview.candidates.find((candidate) => candidate.id === id)!;
    assert.equal(
      preview.candidates.some((candidate) => candidate.id === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4'),
      false,
      'zero-duration rows are not plausible completed plays and must not be candidates',
    );

    const first = await repairSpotifyProgress({
      connectionString: ownerUrl, apply: true, confirmBackup: true, approvals: [approval(MATCH_ID)],
    });
    assert.equal(first.updatedEvents, 1);
    const repeated = await repairSpotifyProgress({
      connectionString: ownerUrl, apply: true, confirmBackup: true, approvals: [approval(MATCH_ID)],
    });
    assert.equal(repeated.updatedEvents, 0);
    assert.equal(repeated.updatedMemories, 0);
    assert.equal(repeated.outcomes[0].status, 'already-repaired');

    const unrelatedBefore = await owner.query('SELECT * FROM memories WHERE id = $1', ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8']);
    const safeRollups = await repairSpotifyProgress({
      connectionString: ownerUrl,
      apply: true,
      confirmBackup: true,
      approvals: [approval(WRONG_SOURCE_ID), approval(MISSING_MEMORY_ID)],
    });
    assert.equal(safeRollups.updatedEvents, 2);
    assert.equal(safeRollups.updatedMemories, 0);
    assert.deepEqual((await owner.query('SELECT * FROM memories WHERE id = $1', ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8'])).rows, unrelatedBefore.rows);

    const relinkApproval = approval(AMBIGUOUS_ID);
    await owner.query('UPDATE media_events SET memory_id = $1 WHERE id = $2', ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', AMBIGUOUS_ID]);
    await assert.rejects(
      repairSpotifyProgress({ connectionString: ownerUrl, apply: true, confirmBackup: true, approvals: [relinkApproval] }),
      /drift/i,
    );
    const relinked = await owner.query('SELECT played_ms, completed FROM media_events WHERE id = $1', [AMBIGUOUS_ID]);
    assert.deepEqual(relinked.rows[0], { played_ms: 300, completed: true });

    const guarded = await owner.query(
      `SELECT id::text, duration_ms, played_ms, completed FROM media_events
       WHERE id IN ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
                    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6',
                    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7') ORDER BY id`,
    );
    assert.deepEqual(guarded.rows, [
      { id: PARTIAL_ID, duration_ms: 200, played_ms: 100, completed: false },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', duration_ms: 0, played_ms: 0, completed: true },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5', duration_ms: null, played_ms: null, completed: true },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6', duration_ms: 200, played_ms: 200, completed: false },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7', duration_ms: 200, played_ms: 200, completed: true },
    ]);
  });
});

interface Fixture { ownerUrl: string; appUrl: string; owner: pg.Client }

async function withDatabase(run: (fixture: Fixture) => Promise<void>): Promise<void> {
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
      CREATE ROLE repair_app LOGIN PASSWORD 'repair_app';
      CREATE TABLE api_keys (id uuid PRIMARY KEY);
      CREATE TABLE memories (
        id uuid PRIMARY KEY, source text NOT NULL, namespace text NOT NULL, tags text[] NOT NULL,
        metadata jsonb NOT NULL, content text NOT NULL, embedding text NOT NULL,
        client_id text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, superseded_at timestamptz
      );
      CREATE TABLE media_events (
        id uuid PRIMARY KEY, service text NOT NULL, duration_ms int, played_ms int, completed boolean,
        played_at timestamptz NOT NULL, client_id uuid NOT NULL, memory_id uuid
      );
      INSERT INTO api_keys VALUES ('${KEY_ID}');
      INSERT INTO memories (id, source, namespace, tags, metadata, content, embedding, client_id) VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'media:spotify', 'media', ARRAY['media','completed','completed-remix','favorite'], '{"duration_ms":200,"played_ms":200,"completed":true,"keep":"yes"}', 'unchanged summary', '[1,2,3]', '${KEY_ID}'),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'media:spotify', 'media', ARRAY['media','favorite'], '{"duration_ms":200,"played_ms":100,"completed":false}', 'partial', '[4,5,6]', '${KEY_ID}'),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'media:spotify', 'media', ARRAY['media','completed'], '{"duration_ms":300,"played_ms":300,"completed":true}', 'ambiguous', '[7,8,9]', '${KEY_ID}'),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8', 'manual', 'media', ARRAY['completed'], '{"played_ms":400,"completed":true}', 'manual', '[8,8,8]', '${KEY_ID}');
      INSERT INTO media_events VALUES
        ('${MATCH_ID}', 'spotify', 200, 200, true, '2026-01-01', '${KEY_ID}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
        ('${PARTIAL_ID}', 'spotify', 200, 100, false, '2026-01-02', '${KEY_ID}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'),
        ('${AMBIGUOUS_ID}', 'spotify', 300, 300, true, '2026-01-03', '${KEY_ID}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', 'spotify', 0, 0, true, '2026-01-04', '${KEY_ID}', NULL),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5', 'spotify', NULL, NULL, true, '2026-01-05', '${KEY_ID}', NULL),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6', 'spotify', 200, 200, false, '2026-01-06', '${KEY_ID}', NULL),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7', 'plex', 200, 200, true, '2026-01-07', '${KEY_ID}', NULL),
        ('${WRONG_SOURCE_ID}', 'spotify', 400, 400, true, '2026-01-08', '${KEY_ID}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8'),
        ('${MISSING_MEMORY_ID}', 'spotify', 500, 500, true, '2026-01-09', '${KEY_ID}', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9');
      GRANT SELECT ON api_keys TO repair_app;
      GRANT SELECT, UPDATE ON memories, media_events TO repair_app;
      ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
      ALTER TABLE media_events ENABLE ROW LEVEL SECURITY;
      CREATE POLICY repair_memories_select ON memories FOR SELECT TO repair_app
        USING (client_id = current_setting('app.current_key_id', true));
      CREATE POLICY repair_memories_update ON memories FOR UPDATE TO repair_app
        USING (client_id = current_setting('app.current_key_id', true))
        WITH CHECK (client_id = current_setting('app.current_key_id', true));
      CREATE POLICY repair_events_select ON media_events FOR SELECT TO repair_app
        USING (client_id::text = current_setting('app.current_key_id', true));
      CREATE POLICY repair_events_update ON media_events FOR UPDATE TO repair_app
        USING (client_id::text = current_setting('app.current_key_id', true))
        WITH CHECK (client_id::text = current_setting('app.current_key_id', true));
    `);
    const appUrl = `postgresql://repair_app:repair_app@127.0.0.1:${port}/postgres`;
    await run({ ownerUrl, appUrl, owner });
  } finally {
    await owner?.end().catch(() => undefined);
    execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
  }
}

async function snapshot(client: pg.Client): Promise<unknown> {
  const events = await client.query('SELECT * FROM media_events ORDER BY id');
  const memories = await client.query('SELECT id, source, namespace, tags, metadata, content, embedding, client_id, updated_at, deleted_at FROM memories ORDER BY id');
  return { events: events.rows, memories: memories.rows };
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
