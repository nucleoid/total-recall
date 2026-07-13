import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import pg from 'pg';
import type { AuthContext, SearchResult } from '../src/types.js';
import { provisionDatabase } from '../scripts/provision-db.js';

const API_KEY_ID = '11111111-1111-4111-8111-111111111111';
const TEST_SOURCE_PREFIX = 'media-search-filter-test';
const TEST_AGENT_NAME = 'media-search-filter-test-agent';
const VECTOR = `[1,${Array(767).fill(0).join(',')}]`;
const ORTHOGONAL_VECTOR = `[0,1,${Array(766).fill(0).join(',')}]`;

process.env.OLLAMA_URL = 'http://total-recall-test-ollama.invalid';
process.env.GEMINI_API_KEY = '';

globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === `${process.env.OLLAMA_URL}/api/embed`) {
    return new Response(JSON.stringify({ embeddings: [[1, ...Array(767).fill(0)]] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`unexpected fetch in integration test: ${url}`);
};

const { Client } = pg;

let admin: pg.Client;
let adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
let containerId: string | null = null;
let mediaSearch: (params: any, auth: AuthContext) => Promise<SearchResult[]>;
let rollupPendingEvents: (auth: AuthContext, scope: any, batchSize?: number) => Promise<{ rolled: number; failed: number; errors: string[] }>;
let dbScopeFromAuth: (auth: AuthContext) => any;
let shutdown: () => Promise<void>;

before(async () => {
  if (!adminUrl) {
    containerId = docker([
      'run',
      '-d',
      '--rm',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      'POSTGRES_DB=total_recall',
      '-p',
      '127.0.0.1::5432',
      process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16',
    ]);
    const port = docker(['port', containerId, '5432/tcp']).split(':').pop();
    adminUrl = `postgres://postgres:postgres@127.0.0.1:${port}/total_recall`;
    await waitForPostgres(adminUrl);
    await applyMigrations(adminUrl);
  } else {
    await waitForPostgres(adminUrl);
  }

  admin = new Client({ connectionString: adminUrl });
  await admin.connect();

  await admin.query(
    `INSERT INTO api_keys (id, key_hash, name, namespaces, permissions)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       key_hash = EXCLUDED.key_hash,
       name = EXCLUDED.name,
       namespaces = EXCLUDED.namespaces,
       permissions = EXCLUDED.permissions`,
    [API_KEY_ID, 'media-search-filter-test-key', 'media-search-filter-test', ['media'], ['read', 'write']]
  );

  process.env.DATABASE_URL = process.env.TEST_APP_DATABASE_URL ?? appRoleUrl(adminUrl);
  ({ mediaSearch } = await import('../src/tools/media-search.js'));
  ({ rollupPendingEvents } = await import('../src/rollup.js'));
  ({ dbScopeFromAuth, shutdown } = await import('../src/db.js'));
});

beforeEach(async () => {
  await admin.query(`DELETE FROM media_events WHERE service LIKE $1`, [`${TEST_SOURCE_PREFIX}%`]);
  await admin.query(`DELETE FROM memories WHERE source LIKE $1 OR source LIKE $2`, [
    `${TEST_SOURCE_PREFIX}%`,
    `media:${TEST_SOURCE_PREFIX}%`,
  ]);
});

after(async () => {
  await admin?.query(`DELETE FROM media_events WHERE service LIKE $1`, [`${TEST_SOURCE_PREFIX}%`]);
  await admin?.query(`DELETE FROM memories WHERE source LIKE $1 OR source LIKE $2`, [
    `${TEST_SOURCE_PREFIX}%`,
    `media:${TEST_SOURCE_PREFIX}%`,
  ]);
  await shutdown?.();
  await admin?.end();
  if (containerId) {
    docker(['stop', containerId]);
  }
});

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

async function waitForPostgres(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastError = err;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

async function applyMigrations(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await provisionDatabase(client, {
      appPassword: decodeURIComponent(new URL(appRoleUrl(url)).password),
      rotateAppPassword: false,
    });
    const files = readdirSync('migrations').filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      await client.query(readFileSync(join('migrations', file), 'utf8'));
    }
  } finally {
    await client.end();
  }
}

function appRoleUrl(url: string): string {
  return url.replace(/postgres(?:ql)?:\/\/[^:]+:[^@]+@/, 'postgres://total_recall_app:total_recall_app_dev@');
}

test('media service filters OR within the service group', async () => {
  await seedMemory({
    content: 'filter target anthem spotify play',
    source: `${TEST_SOURCE_PREFIX}:spotify`,
    tags: ['media', 'spotify', 'play'],
    metadata: {
      service: 'spotify',
      event_type: 'play',
      played_at: '2024-01-01T10:00:00.000Z',
    },
  });
  await seedMemory({
    content: 'filter target anthem plex watch',
    source: `${TEST_SOURCE_PREFIX}:plex`,
    tags: ['media', 'plex', 'watch'],
    metadata: {
      service: 'plex',
      event_type: 'watch',
      played_at: '2024-01-02T10:00:00.000Z',
    },
  });

  const results = await mediaSearch(
    {
      query: 'filter target anthem',
      services: ['spotify', 'plex'],
      limit: 10,
      threshold: 0,
      agent_name: TEST_AGENT_NAME,
    },
    authContext()
  );

  assert.deepEqual(services(results), ['plex', 'spotify']);
});

test('media event type filters OR within their group and AND with services', async () => {
  await seedMemory({
    content: 'filter target anthem spotify play',
    source: `${TEST_SOURCE_PREFIX}:spotify-play`,
    tags: ['media', 'spotify', 'play'],
    metadata: {
      service: 'spotify',
      event_type: 'play',
      played_at: '2024-01-01T10:00:00.000Z',
    },
  });
  await seedMemory({
    content: 'filter target anthem plex watch',
    source: `${TEST_SOURCE_PREFIX}:plex-watch`,
    tags: ['media', 'plex', 'watch'],
    metadata: {
      service: 'plex',
      event_type: 'watch',
      played_at: '2024-01-02T10:00:00.000Z',
    },
  });
  await seedMemory({
    content: 'filter target anthem plex play',
    source: `${TEST_SOURCE_PREFIX}:plex-play`,
    tags: ['media', 'plex', 'play'],
    metadata: {
      service: 'plex',
      event_type: 'play',
      played_at: '2024-01-03T10:00:00.000Z',
    },
  });
  await seedMemory({
    content: 'filter target anthem neon complete',
    source: `${TEST_SOURCE_PREFIX}:neon-complete`,
    tags: ['media', 'neon', 'complete'],
    metadata: {
      service: 'neon',
      event_type: 'complete',
      played_at: '2024-01-04T10:00:00.000Z',
    },
  });

  const eventResults = await mediaSearch(
    {
      query: 'filter target anthem',
      event_types: ['watch', 'play'],
      limit: 10,
      threshold: 0,
      agent_name: TEST_AGENT_NAME,
    },
    authContext()
  );

  assert.deepEqual(eventTypes(eventResults), ['play', 'play', 'watch']);

  const serviceAndEventResults = await mediaSearch(
    {
      query: 'filter target anthem',
      services: ['spotify', 'plex'],
      event_types: ['play'],
      limit: 10,
      threshold: 0,
      agent_name: TEST_AGENT_NAME,
    },
    authContext()
  );

  assert.deepEqual(sources(serviceAndEventResults), [
    `${TEST_SOURCE_PREFIX}:plex-play`,
    `${TEST_SOURCE_PREFIX}:spotify-play`,
  ]);
});

test('media played date filters use event_at and exclude null event times', async () => {
  await seedMemory({
    content: 'filter target anthem old spotify play',
    source: `${TEST_SOURCE_PREFIX}:old-played-new-rollup`,
    tags: ['media', 'spotify', 'play'],
    metadata: {
      service: 'spotify',
      event_type: 'play',
      played_at: '2020-01-01T10:00:00.000Z',
    },
    eventAt: '2020-01-01T10:00:00.000Z',
    createdAt: '2026-01-01T10:00:00.000Z',
  });
  await seedMemory({
    content: 'filter target anthem new spotify play',
    source: `${TEST_SOURCE_PREFIX}:new-played-old-rollup`,
    tags: ['media', 'spotify', 'play'],
    metadata: {
      service: 'spotify',
      event_type: 'play',
      played_at: '2026-01-01T10:00:00.000Z',
    },
    eventAt: '2026-01-01T10:00:00.000Z',
    createdAt: '2020-01-01T10:00:00.000Z',
  });
  await seedMemory({
    content: 'filter target anthem malformed spotify play',
    source: `${TEST_SOURCE_PREFIX}:malformed-played`,
    tags: ['media', 'spotify', 'play'],
    metadata: {
      service: 'spotify',
      event_type: 'play',
      played_at: 'not-a-date',
    },
    createdAt: '2020-06-01T10:00:00.000Z',
  });

  const beforeResults = await mediaSearch(
    {
      query: 'filter target anthem',
      played_before: '2020-12-31T23:59:59.999Z',
      limit: 10,
      threshold: 0,
      agent_name: TEST_AGENT_NAME,
    },
    authContext()
  );

  assert.deepEqual(sources(beforeResults), [`${TEST_SOURCE_PREFIX}:old-played-new-rollup`]);

  const afterResults = await mediaSearch(
    {
      query: 'filter target anthem',
      played_after: '2025-01-01T00:00:00.000Z',
      limit: 10,
      threshold: 0,
      agent_name: TEST_AGENT_NAME,
    },
    authContext()
  );

  assert.deepEqual(sources(afterResults), [`${TEST_SOURCE_PREFIX}:new-played-old-rollup`]);
});

test('media event_at migration exposes a nullable column without building the operational index', async () => {
  const column = await admin.query<{ is_nullable: string }>(
    `SELECT is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'memories'
       AND column_name = 'event_at'`
  );
  const index = await admin.query<{ indexdef: string }>(
    `SELECT indexdef
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'memories_media_event_at_idx'`
  );

  assert.equal(column.rowCount, 1);
  assert.equal(column.rows[0].is_nullable, 'YES');
  assert.equal(index.rowCount, 0);
});

test('media played date filters use event_at instead of created_at or metadata played_at', async () => {
  await seedMemory({
    content: 'filter target anthem old event new rollup',
    source: `${TEST_SOURCE_PREFIX}:old-event-new-rollup`,
    tags: ['media', 'spotify', 'play'],
    metadata: {
      service: 'spotify',
      event_type: 'play',
      played_at: '2026-01-01T10:00:00.000Z',
    },
    eventAt: '2020-01-01T10:00:00.000Z',
    createdAt: '2026-01-01T10:00:00.000Z',
  });
  await seedMemory({
    content: 'filter target anthem new event old rollup',
    source: `${TEST_SOURCE_PREFIX}:new-event-old-rollup`,
    tags: ['media', 'spotify', 'play'],
    metadata: {
      service: 'spotify',
      event_type: 'play',
      played_at: '2020-01-01T10:00:00.000Z',
    },
    eventAt: '2026-01-01T10:00:00.000Z',
    createdAt: '2020-01-01T10:00:00.000Z',
  });

  const historicalResults = await mediaSearch(
    {
      query: 'filter target anthem',
      played_before: '2020-12-31T23:59:59.999Z',
      limit: 10,
      threshold: 0,
      agent_name: TEST_AGENT_NAME,
    },
    authContext()
  );

  assert.deepEqual(sources(historicalResults), [`${TEST_SOURCE_PREFIX}:old-event-new-rollup`]);

  const currentResults = await mediaSearch(
    {
      query: 'filter target anthem',
      played_after: '2025-01-01T00:00:00.000Z',
      limit: 10,
      threshold: 0,
      agent_name: TEST_AGENT_NAME,
    },
    authContext()
  );

  assert.deepEqual(sources(currentResults), [`${TEST_SOURCE_PREFIX}:new-event-old-rollup`]);
});

test('media played date-only bounds normalize to full UTC days', async () => {
  await seedMemory({
    content: 'filter target anthem late utc day',
    source: `${TEST_SOURCE_PREFIX}:late-utc-day`,
    tags: ['media', 'plex', 'watch'],
    metadata: {
      service: 'plex',
      event_type: 'watch',
      played_at: '2024-06-05T23:59:59.999Z',
    },
    eventAt: '2024-06-05T23:59:59.999Z',
    createdAt: '2026-01-01T10:00:00.000Z',
  });
  await seedMemory({
    content: 'filter target anthem next utc day',
    source: `${TEST_SOURCE_PREFIX}:next-utc-day`,
    tags: ['media', 'plex', 'watch'],
    metadata: {
      service: 'plex',
      event_type: 'watch',
      played_at: '2024-06-06T00:00:00.000Z',
    },
    eventAt: '2024-06-06T00:00:00.000Z',
    createdAt: '2026-01-01T10:00:00.000Z',
  });

  const beforeResults = await mediaSearch(
    {
      query: 'filter target anthem',
      played_before: '2024-06-05',
      limit: 10,
      threshold: 0,
      agent_name: TEST_AGENT_NAME,
    },
    authContext()
  );

  assert.deepEqual(sources(beforeResults), [`${TEST_SOURCE_PREFIX}:late-utc-day`]);
});

test('media played date inputs are validated before searching', async () => {
  await assert.rejects(
    () =>
      mediaSearch(
        {
          query: 'filter target anthem',
          played_after: 'not-a-date',
          limit: 10,
          threshold: 0,
          agent_name: TEST_AGENT_NAME,
        },
        authContext()
      ),
    /played_after must be an offset-aware ISO date-time or YYYY-MM-DD/
  );

  await assert.rejects(
    () =>
      mediaSearch(
        {
          query: 'filter target anthem',
          played_after: '2025-01-01T00:00:00.000Z',
          played_before: '2024-01-01T00:00:00.000Z',
          limit: 10,
          threshold: 0,
          agent_name: TEST_AGENT_NAME,
        },
        authContext()
      ),
    /played_before must be after or equal to played_after/
  );
});

test('media rollup writes event_at from the structured event played_at', async () => {
  const service = `${TEST_SOURCE_PREFIX}-rollup`;
  const playedAt = '2019-07-08T09:10:11.000Z';
  await admin.query(
    `INSERT INTO media_events
       (service, service_id, event_type, title, artist, album, genres, played_at, client_id)
     VALUES ($1, 'track-1', 'play', 'Rollup Event Time', 'Test Artist', 'Test Album', $2, $3::timestamptz, $4)`,
    [service, ['integration'], playedAt, API_KEY_ID]
  );

  const auth = authContext(['read', 'write']);
  const result = await rollupPendingEvents(auth, dbScopeFromAuth(auth), 10);

  assert.equal(result.rolled, 1);
  assert.equal(result.failed, 0);

  const memory = await admin.query<{ event_at: Date; played_at: string }>(
    `SELECT event_at, metadata->>'played_at' AS played_at
     FROM memories
     WHERE source = $1`,
    [`media:${service}`]
  );

  assert.equal(memory.rowCount, 1);
  assert.equal(memory.rows[0].event_at.toISOString(), playedAt);
  assert.equal(new Date(memory.rows[0].played_at).toISOString(), playedAt);
});

test('structured service filters do not match arbitrary tag collisions', async () => {
  await seedMemory({
    content: 'filter target anthem spotify play',
    source: `${TEST_SOURCE_PREFIX}:actual-spotify`,
    tags: ['media', 'spotify', 'play'],
    metadata: {
      service: 'spotify',
      event_type: 'play',
      played_at: '2024-01-01T10:00:00.000Z',
    },
  });
  await seedMemory({
    content: 'filter target anthem plex tagged spotify',
    source: `${TEST_SOURCE_PREFIX}:plex-tagged-spotify`,
    tags: ['media', 'plex', 'watch', 'spotify'],
    metadata: {
      service: 'plex',
      event_type: 'watch',
      played_at: '2024-01-02T10:00:00.000Z',
    },
  });

  const results = await mediaSearch(
    {
      query: 'filter target anthem',
      services: ['spotify'],
      limit: 10,
      threshold: 0,
      agent_name: TEST_AGENT_NAME,
    },
    authContext()
  );

  assert.deepEqual(sources(results), [`${TEST_SOURCE_PREFIX}:actual-spotify`]);
});

test('user tags remain contains-all and empty filter arrays are ignored', async () => {
  await seedMemory({
    content: 'filter target anthem favorite completed',
    source: `${TEST_SOURCE_PREFIX}:favorite-completed`,
    tags: ['media', 'spotify', 'play', 'favorite', 'completed'],
    metadata: {
      service: 'spotify',
      event_type: 'play',
      played_at: '2024-01-01T10:00:00.000Z',
    },
  });
  await seedMemory({
    content: 'filter target anthem favorite only',
    source: `${TEST_SOURCE_PREFIX}:favorite-only`,
    tags: ['media', 'spotify', 'play', 'favorite'],
    metadata: {
      service: 'spotify',
      event_type: 'play',
      played_at: '2024-01-02T10:00:00.000Z',
    },
  });

  const taggedResults = await mediaSearch(
    {
      query: 'filter target anthem',
      tags: ['favorite', 'completed'],
      limit: 10,
      threshold: 0,
      agent_name: TEST_AGENT_NAME,
    },
    authContext()
  );

  assert.deepEqual(sources(taggedResults), [`${TEST_SOURCE_PREFIX}:favorite-completed`]);

  const emptyFilterResults = await mediaSearch(
    {
      query: 'filter target anthem',
      services: [],
      event_types: [],
      tags: [],
      limit: 10,
      threshold: 0,
      agent_name: TEST_AGENT_NAME,
    },
    authContext()
  );

  assert.deepEqual(sources(emptyFilterResults), [
    `${TEST_SOURCE_PREFIX}:favorite-completed`,
    `${TEST_SOURCE_PREFIX}:favorite-only`,
  ]);
});

test('media filters apply to text-only candidates outside vector top results', async () => {
  for (let i = 0; i < 55; i++) {
    await seedMemory({
      content: `vector filler ${i}`,
      source: `${TEST_SOURCE_PREFIX}:vector-filler-${i}`,
      tags: ['media', 'spotify', 'play'],
      metadata: {
        service: 'spotify',
        event_type: 'play',
        played_at: '2024-01-01T10:00:00.000Z',
      },
    });
  }
  await seedMemory({
    content: 'rarebranch text only spotify play',
    source: `${TEST_SOURCE_PREFIX}:text-only-spotify`,
    tags: ['media', 'spotify', 'play'],
    metadata: {
      service: 'spotify',
      event_type: 'play',
      played_at: '2024-01-02T10:00:00.000Z',
    },
    vector: ORTHOGONAL_VECTOR,
  });
  await seedMemory({
    content: 'rarebranch text only plex play',
    source: `${TEST_SOURCE_PREFIX}:text-only-plex`,
    tags: ['media', 'plex', 'play'],
    metadata: {
      service: 'plex',
      event_type: 'play',
      played_at: '2024-01-03T10:00:00.000Z',
    },
    vector: ORTHOGONAL_VECTOR,
  });

  const results = await mediaSearch(
    {
      query: 'rarebranch',
      services: ['spotify'],
      event_types: ['play'],
      limit: 50,
      threshold: 0.5,
      agent_name: TEST_AGENT_NAME,
    },
    authContext()
  );

  assert(sources(results).includes(`${TEST_SOURCE_PREFIX}:text-only-spotify`));
  assert(!sources(results).includes(`${TEST_SOURCE_PREFIX}:text-only-plex`));
});

async function seedMemory(input: {
  content: string;
  source: string;
  tags: string[];
  metadata: Record<string, unknown>;
  eventAt?: string;
  createdAt?: string;
  vector?: string;
}): Promise<void> {
  await admin.query(
    `INSERT INTO memories
       (content, embedding, source, namespace, tags, metadata, client_id, event_at, created_at)
     VALUES ($1, $2::vector, $3, 'media', $4, $5, $6, $7::timestamptz, COALESCE($8::timestamptz, NOW()))`,
    [
      input.content,
      input.vector ?? VECTOR,
      input.source,
      input.tags,
      JSON.stringify(input.metadata),
      API_KEY_ID,
      input.eventAt ?? null,
      input.createdAt ?? null,
    ]
  );
}

function authContext(permissions: string[] = ['read']): AuthContext {
  return {
    keyId: API_KEY_ID,
    name: 'media-search-filter-test',
    namespaces: ['media'],
    permissions,
    maxAccessLevel: 'secret',
  };
}

function services(results: SearchResult[]): string[] {
  return results
    .map((result) => String(result.metadata.service))
    .sort((a, b) => a.localeCompare(b));
}

function eventTypes(results: SearchResult[]): string[] {
  return results
    .map((result) => String(result.metadata.event_type))
    .sort((a, b) => a.localeCompare(b));
}

function sources(results: SearchResult[]): string[] {
  return results
    .map((result) => result.source)
    .sort((a, b) => a.localeCompare(b));
}
