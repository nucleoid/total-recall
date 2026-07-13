import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import pg from 'pg';
import { setPoolForTesting, withScopedClient } from '../src/db.js';
import type { AuthContext } from '../src/types.js';
import type { MediaEvent } from '../src/media.js';

const AUTH: AuthContext = {
  keyId: '11111111-1111-4111-8111-111111111111',
  name: 'media-connector',
  namespaces: ['media'],
  permissions: ['read', 'write'],
  maxAccessLevel: 'normal',
};
const SCOPE = { namespaces: ['media'], keyId: AUTH.keyId };

function event(id = 'event-1'): MediaEvent {
  return {
    id,
    service: 'plex',
    service_id: 'rating-key-1',
    event_type: 'watch',
    title: 'Arrival',
    artist: null,
    album: null,
    show: null,
    season: null,
    episode: null,
    year: 2016,
    genres: ['Science Fiction'],
    duration_ms: 6960000,
    played_ms: 6960000,
    completed: true,
    played_at: new Date('2026-07-01T20:00:00Z'),
    metadata: { provider: 'plex' },
    client_id: AUTH.keyId,
    agent_id: null,
    memory_id: null,
    created_at: new Date('2026-07-01T20:01:00Z'),
  };
}

type MemoryRow = {
  id: string;
  content: string;
  source: string;
  client_id: string;
  namespace: string;
  metadata: Record<string, unknown>;
};
type QueryCall = { pid: number; text: string; params?: unknown[] };
type FailureMode = 'link' | 'zero-row' | 'sql' | undefined;

class FakeDatabase {
  events = [event()];
  memories: MemoryRow[] = [];
  nextMemory = 1;
  private eventLock: Promise<void> = Promise.resolve();

  async lockEvent(): Promise<() => void> {
    const previous = this.eventLock;
    let release!: () => void;
    this.eventLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  }
}

class FakeClient {
  readonly calls: QueryCall[] = [];
  private pendingMemories: MemoryRow[] = [];
  private pendingLinks = new Map<string, string>();
  private releaseEventLock: (() => void) | undefined;

  constructor(
    readonly pid: number,
    private readonly db: FakeDatabase,
    private readonly failureMode: FailureMode,
  ) {}

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    this.calls.push({ pid: this.pid, text, params });
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql === 'BEGIN' || sql.startsWith("SELECT set_config('app.")) return result([]);
    if (sql === 'ROLLBACK') {
      this.pendingMemories = [];
      this.pendingLinks.clear();
      this.releaseEventLock?.();
      this.releaseEventLock = undefined;
      return result([]);
    }
    if (sql === 'COMMIT') {
      this.db.memories.push(...this.pendingMemories);
      for (const [eventId, memoryId] of this.pendingLinks) {
        const row = this.db.events.find((candidate) => candidate.id === eventId);
        if (row) row.memory_id = memoryId;
      }
      this.pendingMemories = [];
      this.pendingLinks.clear();
      this.releaseEventLock?.();
      this.releaseEventLock = undefined;
      return result([]);
    }
    if (/^SELECT \* FROM media_events/i.test(sql)) {
      return result(this.db.events.filter((row) => row.client_id === params[0] && row.memory_id === null) as T[]);
    }
    if (/^INSERT INTO memories/i.test(sql)) {
      const row = {
        id: `memory-${this.db.nextMemory++}`,
        content: String(params[0]),
        source: String(params[2]),
        client_id: String(params[7]),
        namespace: String(params[3]),
        metadata: JSON.parse(String(params[5])) as Record<string, unknown>,
      };
      this.pendingMemories.push(row);
      return result([{ id: row.id } as T]);
    }
    if (/^UPDATE media_events SET memory_id/i.test(sql)) {
      if (this.failureMode === 'link') throw new Error('link failed after insert');
      if (this.failureMode === 'sql') throw new Error('database update failed');
      if (this.failureMode === 'zero-row') return result([], 0);
      this.releaseEventLock = await this.db.lockEvent();
      const row = this.db.events.find((candidate) => candidate.id === params[1] && candidate.memory_id === null);
      if (!row) {
        this.releaseEventLock();
        this.releaseEventLock = undefined;
        return result([], 0);
      }
      this.pendingLinks.set(row.id, String(params[0]));
      return result([], 1);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }

  release(): void {}
}

class FakePool {
  readonly db = new FakeDatabase();
  readonly clients: FakeClient[] = [];

  constructor(private readonly failureMode: FailureMode = undefined) {}

  async connect(): Promise<FakeClient> {
    const client = new FakeClient(this.clients.length + 100, this.db, this.failureMode);
    this.clients.push(client);
    return client;
  }
}

function result<T extends pg.QueryResultRow>(rows: T[], rowCount = rows.length): pg.QueryResult<T> {
  return { command: 'MOCK', rowCount, oid: 0, fields: [], rows };
}

async function withEmbeddingMock<T>(fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ embedding: { values: Array(768).fill(0.1) } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('invalid MEDIA_TIME_ZONE fails before fetching events or opening a transaction', async () => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  const previous = process.env.MEDIA_TIME_ZONE;
  process.env.MEDIA_TIME_ZONE = 'Mars/Olympus_Mons';
  try {
    const { rollupPendingEvents } = await import('../src/rollup.js');
    await assert.rejects(rollupPendingEvents(AUTH, SCOPE), /Invalid MEDIA_TIME_ZONE/);
    assert.equal(pool.clients.length, 0);
    assert.equal(pool.db.memories.length, 0);
  } finally {
    if (previous === undefined) delete process.env.MEDIA_TIME_ZONE;
    else process.env.MEDIA_TIME_ZONE = previous;
  }
});

test('missing MEDIA_TIME_ZONE preserves UTC output regardless of host TZ', async () => {
  const pool = new FakePool();
  pool.db.events[0].played_at = new Date('2026-01-02T02:00:00Z');
  setPoolForTesting(pool as unknown as pg.Pool);
  const previousZone = process.env.MEDIA_TIME_ZONE;
  const previousHostZone = process.env.TZ;
  delete process.env.MEDIA_TIME_ZONE;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const { rollupPendingEvents } = await import('../src/rollup.js');
    await withEmbeddingMock(() => rollupPendingEvents(AUTH, SCOPE));
    assert.match(pool.db.memories[0].content, /on 2026-01-02 via plex/);
    assert.equal(pool.db.memories[0].metadata.played_at, '2026-01-02T02:00:00.000Z');
  } finally {
    if (previousZone === undefined) delete process.env.MEDIA_TIME_ZONE;
    else process.env.MEDIA_TIME_ZONE = previousZone;
    if (previousHostZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousHostZone;
  }
});

test('failure between memory insert and event link rolls back both writes', async () => {
  const pool = new FakePool('link');
  setPoolForTesting(pool as unknown as pg.Pool);
  process.env.EMBEDDING_PROVIDER = 'gemini';
  process.env.EMBEDDING_MODEL = 'gemini-embedding-2-preview';
  process.env.EMBEDDING_DIMENSIONS = '768';
  process.env.GEMINI_API_KEY = 'test-only-key';
  const { rollupPendingEvents } = await import('../src/rollup.js');

  const outcome = await withEmbeddingMock(() => rollupPendingEvents(AUTH, SCOPE));

  assert.deepEqual(outcome, {
    rolled: 0,
    failed: 1,
    errors: ['event event-1: link failed after insert'],
  });
  assert.equal(pool.db.memories.length, 0);
  assert.equal(pool.db.events[0].memory_id, null);
});

test('successful rollup commits one exact memory and link on one media-scoped client', async () => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  const { rollupPendingEvents } = await import('../src/rollup.js');

  const outcome = await withEmbeddingMock(() => rollupPendingEvents(AUTH, SCOPE));

  assert.deepEqual(outcome, { rolled: 1, failed: 0, errors: [] });
  assert.equal(pool.db.memories.length, 1);
  assert.equal(pool.db.events[0].memory_id, pool.db.memories[0].id);
  assert.deepEqual(pool.db.memories[0], {
    id: 'memory-1',
    content: 'Watched "Arrival" (2016) on 2026-07-01 via plex. Completed. Genres: Science Fiction.',
    source: 'media:plex',
    client_id: AUTH.keyId,
    namespace: 'media',
    metadata: {
      service: 'plex', service_id: 'rating-key-1', event_type: 'watch',
      played_at: '2026-07-01T20:00:00.000Z', title: 'Arrival', year: 2016,
      duration_ms: 6960000, played_ms: 6960000, completed: true, provider: 'plex',
    },
  });

  const writer = pool.clients.find((client) => client.calls.some((call) => /INSERT INTO memories/i.test(call.text)));
  assert.ok(writer);
  assert.match(writer.calls.find((call) => /UPDATE media_events/i.test(call.text))!.text, /memory_id IS NULL[\s\S]+RETURNING id/i);
  assert.deepEqual(new Set(writer.calls.map((call) => call.pid)), new Set([writer.pid]));
  const namespaceCall = writer.calls.find((call) =>
    call.text.includes("set_config('app.allowed_namespaces'") && (call.params?.length ?? 0) > 0
  );
  assert.equal(namespaceCall?.params?.[0], JSON.stringify(['media']));
});

test('zero-row concurrent claim or deletion is a rolled-back no-op, while SQL errors fail', async () => {
  for (const [mode, expected] of [
    ['zero-row', { rolled: 0, failed: 0, errors: [] }],
    ['sql', { rolled: 0, failed: 1, errors: ['event event-1: database update failed'] }],
  ] as const) {
    const pool = new FakePool(mode);
    setPoolForTesting(pool as unknown as pg.Pool);
    const { rollupPendingEvents } = await import('../src/rollup.js');
    const outcome = await withEmbeddingMock(() => rollupPendingEvents(AUTH, SCOPE));
    assert.deepEqual(outcome, expected);
    assert.equal(pool.db.memories.length, 0);
    assert.equal(pool.db.events[0].memory_id, null);
  }
});

test('embedding rejection opens no write transaction and leaves the event pending', async () => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('provider unavailable', { status: 503 })) as typeof fetch;
  try {
    const { rollupPendingEvents } = await import('../src/rollup.js');
    const outcome = await rollupPendingEvents(AUTH, SCOPE);
    assert.equal(outcome.rolled, 0);
    assert.equal(outcome.failed, 1);
    assert.match(outcome.errors[0], /embedContent failed \(503\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(pool.clients.some((client) => client.calls.some((call) => /INSERT INTO memories/i.test(call.text))), false);
  assert.equal(pool.db.events[0].memory_id, null);
});

test('two overlapping rollups converge on one linked memory without a false failure', async () => {
  const pool = new FakePool();
  setPoolForTesting(pool as unknown as pg.Pool);
  const { rollupPendingEvents } = await import('../src/rollup.js');

  const outcomes = await withEmbeddingMock(() => Promise.all([
    rollupPendingEvents(AUTH, SCOPE),
    rollupPendingEvents(AUTH, SCOPE),
  ]));

  assert.equal(outcomes.reduce((sum, value) => sum + value.rolled, 0), 1);
  assert.equal(outcomes.reduce((sum, value) => sum + value.failed, 0), 0);
  assert.equal(pool.db.memories.length, 1);
  assert.equal(pool.db.events[0].memory_id, pool.db.memories[0].id);
});

test('real PostgreSQL app-role transactions recheck the guarded link and roll back the loser', async () => {
  const image = process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16';
  const containerId = execFileSync('docker', [
    'run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=postgres',
    '-p', '127.0.0.1::5432', image,
  ], { encoding: 'utf8' }).trim();
  let appPool: pg.Pool | undefined;
  let owner: pg.Client | undefined;
  try {
    const port = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
    const ownerUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    await waitForPostgres(ownerUrl);
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    await owner.query(`
      CREATE ROLE rollup_app LOGIN PASSWORD 'rollup_app';
      CREATE TABLE memories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL);
      CREATE TABLE media_events (id uuid PRIMARY KEY, client_id uuid NOT NULL, memory_id uuid REFERENCES memories(id));
      CREATE FUNCTION app_current_key_id() RETURNS text LANGUAGE sql STABLE AS
        $$ SELECT NULLIF(current_setting('app.current_key_id', true), '') $$;
      GRANT INSERT, SELECT ON memories TO rollup_app;
      GRANT SELECT, UPDATE ON media_events TO rollup_app;
      ALTER TABLE media_events ENABLE ROW LEVEL SECURITY;
      CREATE POLICY media_event_read ON media_events FOR SELECT
        USING (client_id = app_current_key_id()::uuid);
      CREATE POLICY media_event_update ON media_events FOR UPDATE
        USING (client_id = app_current_key_id()::uuid)
        WITH CHECK (client_id = app_current_key_id()::uuid);
      INSERT INTO media_events (id, client_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${AUTH.keyId}');
    `);

    appPool = new pg.Pool({
      connectionString: `postgresql://rollup_app:rollup_app@127.0.0.1:${port}/postgres`,
      max: 2,
    });
    setPoolForTesting(appPool);
    const { linkEventToMemoryWithClient } = await import('../src/media.js');
    let releaseWinner!: () => void;
    const winnerMayCommit = new Promise<void>((resolve) => { releaseWinner = resolve; });
    let winnerLinked!: () => void;
    const winnerHasLink = new Promise<void>((resolve) => { winnerLinked = resolve; });
    let loserUpdating!: () => void;
    const loserStartedUpdate = new Promise<void>((resolve) => { loserUpdating = resolve; });

    const winner = withScopedClient(SCOPE, async (client) => {
      const inserted = await client.query<{ id: string }>('INSERT INTO memories (client_id) VALUES ($1) RETURNING id', [AUTH.keyId]);
      assert.equal(await linkEventToMemoryWithClient(client, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', inserted.rows[0].id, AUTH.keyId), true);
      winnerLinked();
      await winnerMayCommit;
      return inserted.rows[0].id;
    });
    await winnerHasLink;

    const loser = withScopedClient(SCOPE, async (client) => {
      const inserted = await client.query<{ id: string }>('INSERT INTO memories (client_id) VALUES ($1) RETURNING id', [AUTH.keyId]);
      loserUpdating();
      const linked = await linkEventToMemoryWithClient(client, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', inserted.rows[0].id, AUTH.keyId);
      if (!linked) throw new Error('concurrent rollup no-op');
    });
    await loserStartedUpdate;
    releaseWinner();
    const winnerMemoryId = await winner;
    await assert.rejects(loser, /concurrent rollup no-op/);

    const state = await owner.query<{ memory_id: string; count: string }>(
      `SELECT e.memory_id, (SELECT count(*) FROM memories)::text AS count
       FROM media_events e WHERE e.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`
    );
    assert.equal(state.rows[0].memory_id, winnerMemoryId);
    assert.equal(state.rows[0].count, '1');
  } finally {
    setPoolForTesting(null);
    await appPool?.end().catch(() => undefined);
    await owner?.end().catch(() => undefined);
    execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
  }
});

async function waitForPostgres(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}
