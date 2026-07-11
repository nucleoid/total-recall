import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import pg from 'pg';
import type { AuthContext, SearchResult } from '../src/types.js';

const ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:55432/total_recall';

const APP_DATABASE_URL =
  process.env.TEST_APP_DATABASE_URL ??
  ADMIN_DATABASE_URL;

const API_KEY_ID = '11111111-1111-4111-8111-111111111111';
const TEST_SOURCE_PREFIX = 'media-search-filter-test';
const TEST_AGENT_NAME = 'media-search-filter-test-agent';
const VECTOR = `[1,${Array(767).fill(0).join(',')}]`;
const ORTHOGONAL_VECTOR = `[0,1,${Array(766).fill(0).join(',')}]`;

process.env.DATABASE_URL = APP_DATABASE_URL;
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
let mediaSearch: (params: any, auth: AuthContext) => Promise<SearchResult[]>;
let setNamespaceContext: (namespaces: string[]) => Promise<void>;
let shutdown: () => Promise<void>;

before(async () => {
  admin = new Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();

  await ensureSearchSchema();

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

  ({ mediaSearch } = await import('../src/tools/media-search.js'));
  ({ setNamespaceContext, shutdown } = await import('../src/db.js'));
});

beforeEach(async () => {
  await setNamespaceContext(['media']);
  await admin.query(`DELETE FROM memories WHERE source LIKE $1`, [`${TEST_SOURCE_PREFIX}%`]);
});

after(async () => {
  await setNamespaceContext([]);
  await admin.query(`DELETE FROM memories WHERE source LIKE $1`, [`${TEST_SOURCE_PREFIX}%`]);
  await shutdown();
  await admin.end();
});

async function ensureSearchSchema(): Promise<void> {
  await admin.query(`
    ALTER TABLE memories
      ADD COLUMN IF NOT EXISTS relevance_score FLOAT DEFAULT 1.0,
      ADD COLUMN IF NOT EXISTS decay_rate FLOAT DEFAULT 0.01,
      ADD COLUMN IF NOT EXISTS last_boosted_at TIMESTAMPTZ DEFAULT NOW()
  `);
  await admin.query(`
    CREATE OR REPLACE FUNCTION calculate_relevance(
      p_relevance_score FLOAT,
      p_decay_rate FLOAT,
      p_accessed_at TIMESTAMPTZ,
      p_access_count INTEGER
    ) RETURNS FLOAT AS $$
    DECLARE
      days_since FLOAT;
      access_bonus FLOAT;
    BEGIN
      days_since := EXTRACT(EPOCH FROM (NOW() - COALESCE(p_accessed_at, NOW()))) / 86400.0;
      access_bonus := LEAST(COALESCE(p_access_count, 0) * 0.1, 1.0);
      RETURN COALESCE(p_relevance_score, 1.0) * EXP(-COALESCE(p_decay_rate, 0.01) * days_since) + access_bonus;
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;
  `);
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

test('media played date filters use metadata played_at and ignore malformed values', async () => {
  await seedMemory({
    content: 'filter target anthem old spotify play',
    source: `${TEST_SOURCE_PREFIX}:old-played-new-rollup`,
    tags: ['media', 'spotify', 'play'],
    metadata: {
      service: 'spotify',
      event_type: 'play',
      played_at: '2020-01-01T10:00:00.000Z',
    },
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
    /played_after must be an ISO date-time/
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
    /played_after must be before or equal to played_before/
  );
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
  createdAt?: string;
  vector?: string;
}): Promise<void> {
  await admin.query(
    `INSERT INTO memories
       (content, embedding, source, namespace, tags, metadata, client_id, created_at)
     VALUES ($1, $2::vector, $3, 'media', $4, $5, $6, COALESCE($7::timestamptz, NOW()))`,
    [
      input.content,
      input.vector ?? VECTOR,
      input.source,
      input.tags,
      JSON.stringify(input.metadata),
      API_KEY_ID,
      input.createdAt ?? null,
    ]
  );
}

function authContext(): AuthContext {
  return {
    keyId: API_KEY_ID,
    name: 'media-search-filter-test',
    namespaces: ['media'],
    permissions: ['read'],
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
