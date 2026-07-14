import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import {
  createMediaEventAtIndex,
  repairMediaEventAt,
} from '../../scripts/repair-media-event-at.js';
import { provisionDatabase } from '../../scripts/provision-db.js';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const migrationsDir = join(repoRoot, 'migrations');
const eventTimeMigration = join(migrationsDir, '015_memory_event_time.sql');
const hasEventTimeMigration = existsSync(eventTimeMigration);
const vector = `[${Array.from({ length: 768 }, () => '0').join(',')}]`;

let containerId: string | undefined;
let adminUrl: string | undefined;
let ownerUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test.after(async () => {
  if (containerId) {
    execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
  }
});

test(
  'event_at repair is bounded and reports malformed historical media values',
  { skip: !hasEventTimeMigration && 'missing 015_memory_event_time.sql' },
  async () => {
    await withFreshDatabase(async () => {
      await resetDatabase();
      await applyMigrationsThrough('014_metadata_rls');

      const owner = await ownerClient();
      try {
        await insertMemory(owner, {
          content: 'valid historical media one',
          namespace: 'media',
          source: 'media:event-at-valid-one',
          metadata: { played_at: '2020-01-02T03:04:05.000Z' },
          createdAt: '2026-01-01T00:00:00Z',
        });
        await insertMemory(owner, {
          content: 'valid historical media two',
          namespace: 'media',
          source: 'media:event-at-valid-two',
          metadata: { played_at: '2021-02-03T04:05:06.000Z' },
          createdAt: '2026-01-02T00:00:00Z',
        });
        await insertMemory(owner, {
          content: 'malformed historical media',
          namespace: 'media',
          source: 'media:event-at-malformed',
          metadata: { played_at: 'not-a-date' },
          createdAt: '2026-01-03T00:00:00Z',
        });
        await insertMemory(owner, {
          content: 'special literal historical media',
          namespace: 'media',
          source: 'media:event-at-special-literal',
          metadata: { played_at: 'now' },
          createdAt: '2026-01-03T12:00:00Z',
        });
        await insertMemory(owner, {
          content: 'tombstoned historical media',
          namespace: 'media',
          source: 'media:event-at-tombstoned',
          metadata: { played_at: '2022-03-04T05:06:07.000Z' },
          createdAt: '2026-01-03T18:00:00Z',
        });
        await insertMemory(owner, {
          content: 'non-media with played_at',
          namespace: 'shared',
          source: 'event-at-non-media',
          metadata: { played_at: '2022-03-04T05:06:07.000Z' },
          createdAt: '2026-01-04T00:00:00Z',
        });
      } finally {
        await owner.end();
      }

      await applyMigration('015_memory_event_time.sql');
      const lifecycle = await ownerClient();
      try {
        await lifecycle.query(`ALTER TABLE memories ADD COLUMN deleted_at TIMESTAMPTZ`);
        await lifecycle.query(`UPDATE memories SET deleted_at = NOW() WHERE content = 'tombstoned historical media'`);
      } finally {
        await lifecycle.end();
      }
      await assertEventAt('valid historical media one', null);
      await assertEventAt('valid historical media two', null);
      await assertIndexAbsent();

      const dryRun = await repairMediaEventAt({
        connectionString: ownerUrl!,
        batchSize: 1,
        maxRows: 1,
        dryRun: true,
        malformedSampleLimit: 5,
      });
      assert.equal(dryRun.dryRun, true);
      assert.equal(dryRun.updatedRows, 0);
      assert.equal(dryRun.remainingRows, 2);
      assert.equal(dryRun.malformedRows, 2);
      assert.deepEqual(dryRun.malformedSamples, [
        {
          source: 'media:event-at-malformed',
          playedAt: 'not-a-date',
        },
        {
          source: 'media:event-at-special-literal',
          playedAt: 'now',
        },
      ]);

      const first = await repairMediaEventAt({
        connectionString: ownerUrl!,
        batchSize: 1,
        maxRows: 1,
      });
      assert.equal(first.updatedRows, 1);
      assert.equal(first.batches, 1);
      assert.equal(first.remainingRows, 1);
      assert.equal(first.malformedRows, 2);

      const second = await repairMediaEventAt({
        connectionString: ownerUrl!,
        batchSize: 10,
        maxRows: 10,
      });
      assert.equal(second.updatedRows, 1);
      assert.equal(second.remainingRows, 0);
      assert.equal(second.malformedRows, 2);

      await assertEventAt('valid historical media one', '2020-01-02T03:04:05.000Z');
      await assertEventAt('valid historical media two', '2021-02-03T04:05:06.000Z');
      await assertEventAt('malformed historical media', null);
      await assertEventAt('special literal historical media', null);
      await assertEventAt('tombstoned historical media', null);
      await assertEventAt('non-media with played_at', null);
    });
  }
);

test(
  'event_at index operation builds the partial index concurrently outside migrations',
  { skip: !hasEventTimeMigration && 'missing 015_memory_event_time.sql' },
  async () => {
    await withFreshDatabase(async () => {
      await resetDatabase();
      await applyMigrationsThrough('015_memory_event_time');
      await assertIndexAbsent();

      const result = await createMediaEventAtIndex({ connectionString: ownerUrl! });
      assert.equal(result.indexName, 'memories_media_event_at_idx');
      assert.equal(result.indexExists, true);
      assert.equal(result.created, true);

      const index = await loadIndex();
      assert.match(index, /CREATE INDEX memories_media_event_at_idx/i);
      assert.match(index, /USING btree \(namespace, event_at DESC\)/i);
      assert.match(index, /WHERE \(event_at IS NOT NULL\)/i);
    });
  }
);

async function withFreshDatabase(fn: () => Promise<void>) {
  await ensureDatabase();
  await fn();
}

async function ensureDatabase() {
  if (ownerUrl) {
    return;
  }

  if (!containerId) {
    const image = process.env.MIGRATION_TEST_IMAGE || 'pgvector/pgvector:pg16';
    containerId = execFileSync('docker', [
      'run',
      '--rm',
      '-d',
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-p',
      '127.0.0.1::5432',
      image,
    ], { encoding: 'utf8' }).trim();

    const portLine = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' }).trim();
    const port = portLine.split(':').at(-1);
    adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    ownerUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/total_recall`;
  }

  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: adminUrl ?? ownerUrl });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastError = err;
      try {
        await client.end();
      } catch {
        // Ignore close errors while waiting for PostgreSQL to accept connections.
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  throw lastError;
}

async function resetDatabase() {
  if (adminUrl) {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query('DROP DATABASE IF EXISTS total_recall WITH (FORCE)');
      await admin.query('CREATE DATABASE total_recall');
    } finally {
      await admin.end();
    }

    const owner = await ownerClient();
    try {
      await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
      await owner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await provisionDatabase(owner, {
        appPassword: 'event-time-test-only',
        rotateAppPassword: false,
      });
    } finally {
      await owner.end();
    }
    return;
  }

  const client = await ownerClient();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await provisionDatabase(client, {
      appPassword: 'event-time-test-only',
      rotateAppPassword: false,
    });
  } finally {
    await client.end();
  }
}

async function applyMigrationsThrough(lastVersion: string) {
  const files = readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .filter(file => file.replace('.sql', '') <= lastVersion);

  for (const file of files) {
    await applyMigration(file);
  }
}

async function applyMigration(file: string) {
  const client = await ownerClient();
  try {
    await client.query(readFileSync(join(migrationsDir, file), 'utf8'));
  } finally {
    await client.end();
  }
}

async function ownerClient() {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  return client;
}

async function insertMemory(
  client: pg.Client,
  row: {
    content: string;
    namespace: string;
    source: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }
) {
  await client.query(
    `INSERT INTO memories (content, embedding, source, namespace, metadata, client_id, created_at)
     VALUES ($1, $2::vector, $3, $4, $5, 'test-client', $6)`,
    [row.content, vector, row.source, row.namespace, JSON.stringify(row.metadata), row.createdAt]
  );
}

async function assertEventAt(content: string, expectedIso: string | null) {
  const client = await ownerClient();
  try {
    const { rows } = await client.query<{ event_at: Date | null }>(
      `SELECT event_at
       FROM memories
       WHERE content = $1`,
      [content]
    );

    assert.equal(rows.length, 1);
    if (expectedIso === null) {
      assert.equal(rows[0].event_at, null);
      return;
    }
    assert.equal(rows[0].event_at?.toISOString(), expectedIso);
  } finally {
    await client.end();
  }
}

async function assertIndexAbsent() {
  assert.equal(await loadIndex(), null);
}

async function loadIndex(): Promise<string | null> {
  const client = await ownerClient();
  try {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'memories_media_event_at_idx'`
    );
    return rows[0]?.indexdef ?? null;
  } finally {
    await client.end();
  }
}
