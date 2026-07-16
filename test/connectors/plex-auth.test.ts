import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { pinFlow, pollPin, type PinResponse } from '../../src/connectors/plex/auth.js';
import { setPoolForTesting } from '../../src/db.js';

const pin = (overrides: Partial<PinResponse> = {}): PinResponse => ({
  id: 42,
  code: 'ABCD',
  authToken: null,
  expiresAt: '2026-07-12T12:15:00.000Z',
  ...overrides,
});

test('polling terminates at the server expiresAt deadline rather than a fixed timeout', async () => {
  let nowMs = Date.parse('2026-07-12T12:00:00.000Z');
  const deadline = Date.parse(pin().expiresAt);
  const fetchTimes: number[] = [];
  const sleeps: number[] = [];

  await assert.rejects(
    pollPin(pin(), 'client-id', {
      now: () => nowMs,
      fetch: async () => {
        fetchTimes.push(nowMs);
        return new Response(JSON.stringify({ authToken: null }), { status: 200 });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    }),
    /Plex PIN expired without being claimed/,
  );

  assert.ok(fetchTimes.length > 1);
  assert.ok(fetchTimes.every((time) => time < deadline));
  assert.equal(nowMs, deadline);
  assert.equal(sleeps.reduce((sum, ms) => sum + ms, 0), 15 * 60 * 1000);
});

test('404 is terminal with no sleep and pinFlow does not persist credentials', { concurrency: false }, async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  let insertCount = 0;
  const credentialQuery = async (sql: string) => {
    if (sql.includes('set_config') || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('SELECT data FROM connector_credentials')) return { rows: [] };
    if (sql.includes('INSERT INTO connector_credentials')) {
      insertCount += 1;
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const fakePool = {
    on: () => undefined,
    query: async (sql: string) => {
      if (sql.includes('SELECT id, namespaces, permissions FROM api_keys')) {
        return { rows: [{ id: 'key-1', namespaces: ['media'], permissions: ['write'] }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    connect: async () => ({ query: credentialQuery, release: () => undefined }),
  };

  setPoolForTesting(fakePool as never);
  globalThis.fetch = (async (_input, init) => {
    fetchCount += 1;
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(pin({ expiresAt: new Date(Date.now() + 10_000).toISOString() })), { status: 201 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    setPoolForTesting(null);
  });

  await assert.rejects(pinFlow(() => undefined), /expired|deleted/i);
  assert.equal(fetchCount, 2, 'one create request and one poll request');
  assert.equal(insertCount, 0);

  let sleeps = 0;
  let nowMs = Date.parse('2026-07-12T12:00:00.000Z');
  await assert.rejects(
    pollPin(pin(), 'client-id', {
      now: () => nowMs,
      fetch: async () => new Response('', { status: 404 }),
      sleep: async (ms) => {
        sleeps += 1;
        nowMs += ms;
      },
    }),
    /expired|deleted/i,
  );
  assert.equal(sleeps, 0);
});

test('pinFlow persists the exact token after an unclaimed response', { concurrency: false }, async (t) => {
  const originalFetch = globalThis.fetch;
  let pollCount = 0;
  let stored: Record<string, unknown> | null = null;
  const credentialQuery = async (sql: string, params?: unknown[]) => {
    if (sql.includes('set_config') || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('SELECT data FROM connector_credentials')) return { rows: [] };
    if (sql.includes('INSERT INTO connector_credentials')) {
      stored = JSON.parse(String(params?.[4])) as Record<string, unknown>;
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  setPoolForTesting({
    on: () => undefined,
    query: async (sql: string) => {
      if (sql.includes('SELECT id, namespaces, permissions FROM api_keys')) {
        return { rows: [{ id: 'key-1', namespaces: ['media'], permissions: ['write'] }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    connect: async () => ({ query: credentialQuery, release: () => undefined }),
  } as never);
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(pin({ expiresAt: new Date(Date.now() + 10_000).toISOString() })), { status: 201 });
    }
    pollCount += 1;
    return new Response(JSON.stringify({ authToken: pollCount === 1 ? null : ' exact-token ' }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    setPoolForTesting(null);
  });

  const creds = await pinFlow(() => undefined);
  assert.equal(pollCount, 2);
  assert.equal(creds.auth_token, ' exact-token ');
  assert.equal(stored?.auth_token, ' exact-token ');
});

test('terminal 4xx fails immediately without leaking a response body', async () => {
  let fetches = 0;
  let sleeps = 0;
  let nowMs = Date.parse('2026-07-12T12:00:00.000Z');
  const secretBody = 'secret-auth-token';

  await assert.rejects(
    pollPin(pin(), 'client-id', {
      now: () => nowMs,
      fetch: async () => {
        fetches += 1;
        return new Response(secretBody, { status: 401 });
      },
      sleep: async (ms) => {
        sleeps += 1;
        nowMs += ms;
      },
    }),
    (error: unknown) => {
      assert.match(String(error), /401/);
      assert.doesNotMatch(String(error), /secret-auth-token/);
      return true;
    },
  );
  assert.equal(fetches, 1);
  assert.equal(sleeps, 0);
});

test('network errors, 5xx, and 429 retry with bounded Retry-After delays', async () => {
  let nowMs = Date.parse('2026-07-12T12:00:00.000Z');
  const sleeps: number[] = [];
  const outcomes: Array<Error | Response> = [
    new Error('network down'),
    new Response('', { status: 503 }),
    new Response('', { status: 429, headers: { 'Retry-After': '1' } }),
    new Response('', { status: 429, headers: { 'Retry-After': new Date(nowMs + 2_000).toUTCString() } }),
    new Response('', { status: 429, headers: { 'Retry-After': 'invalid' } }),
    new Response('', { status: 429, headers: { 'Retry-After': '' } }),
    new Response('', { status: 429, headers: { 'Retry-After': '0' } }),
    new Response(JSON.stringify({ authToken: 'token' }), { status: 200 }),
  ];

  const token = await pollPin(pin(), 'client-id', {
    now: () => nowMs,
    fetch: async () => {
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome as Response;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  });

  assert.equal(token, 'token');
  assert.deepEqual(sleeps, [2000, 2000, 1000, 2000, 2000, 2000, 2000]);

  nowMs = Date.parse('2026-07-12T12:14:57.000Z');
  const boundedSleeps: number[] = [];
  await assert.rejects(pollPin(pin(), 'client-id', {
    now: () => nowMs,
    fetch: async () => new Response('', { status: 429, headers: { 'Retry-After': '600' } }),
    sleep: async (ms) => {
      boundedSleeps.push(ms);
      nowMs += ms;
    },
  }), /expired/);
  assert.deepEqual(boundedSleeps, [3000]);
});

test('malformed or elapsed server expiry performs no fetch', async () => {
  for (const expiresAt of ['', 'not-a-date', '2026-07-12T11:59:59.000Z']) {
    let fetches = 0;
    await assert.rejects(pollPin(pin({ expiresAt }), 'client-id', {
      now: () => Date.parse('2026-07-12T12:00:00.000Z'),
      fetch: async () => {
        fetches += 1;
        return new Response('{}');
      },
      sleep: async () => undefined,
    }), /expired/i);
    assert.equal(fetches, 0, `expiresAt=${JSON.stringify(expiresAt)}`);
  }
});

test('an in-flight response may return a token after expiry but cannot trigger another request', async () => {
  const deadline = Date.parse(pin().expiresAt);
  let nowMs = deadline - 1;
  let fetches = 0;
  let sleeps = 0;

  const token = await pollPin(pin(), 'client-id', {
    now: () => nowMs,
    fetch: async () => {
      fetches += 1;
      nowMs = deadline + 1;
      return new Response(JSON.stringify({ authToken: 'late-token' }), { status: 200 });
    },
    sleep: async () => { sleeps += 1; },
  });
  assert.equal(token, 'late-token');
  assert.equal(fetches, 1);
  assert.equal(sleeps, 0);

  nowMs = deadline - 1;
  fetches = 0;
  await assert.rejects(pollPin(pin(), 'client-id', {
    now: () => nowMs,
    fetch: async () => {
      fetches += 1;
      nowMs = deadline + 1;
      return new Response(JSON.stringify({ authToken: null }), { status: 200 });
    },
    sleep: async () => { sleeps += 1; },
  }), /expired/i);
  assert.equal(fetches, 1);
  assert.equal(sleeps, 0);
});

test('invalid JSON in a successful poll response fails visibly', async () => {
  let sleeps = 0;
  await assert.rejects(pollPin(pin(), 'client-id', {
    now: () => Date.parse('2026-07-12T12:00:00.000Z'),
    fetch: async () => new Response('{invalid', { status: 200 }),
    sleep: async () => { sleeps += 1; },
  }), SyntaxError);
  assert.equal(sleeps, 0);
});

test('Plex auth guidance uses the bare link and server-controlled expiry wording', async () => {
  const [script, docs] = await Promise.all([
    readFile(new URL('../../scripts/plex-auth.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/connectors/plex.md', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(script, /25 minutes/i);
  assert.match(script, /Waiting for authorization/);
  assert.match(docs, /Link:\s+https:\/\/plex\.tv\/link\s*$/m);
  assert.doesNotMatch(docs, /expires in 25 minutes|longer than 25 min/i);
  assert.match(docs, /expiry.*controlled by Plex|Plex.*controls.*expiry/i);
});
