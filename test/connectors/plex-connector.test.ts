import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchHistoryForServers,
  fetchHistoryForServer,
  historyAccountId,
  mergePlexCursorMetadata,
  normalizePlexAccountId,
  parsePlexCursorMetadata,
  type PlexHistoryFetchDeps,
} from '../../src/connectors/plex/connector.js';
import type { PlexCreds } from '../../src/connectors/plex/auth.js';
import { getAccount, listServers, type PlexResource } from '../../src/connectors/plex/discovery.js';

function server(overrides: Partial<PlexResource> = {}): PlexResource {
  return {
    name: 'Owned Server',
    clientIdentifier: 'owned-client',
    owned: true,
    provides: 'server',
    publicAddressMatches: true,
    connections: [
      {
        protocol: 'https',
        address: 'owned.example',
        port: 443,
        uri: 'https://owned.example',
        local: false,
        relay: false,
      },
    ],
    ...overrides,
  };
}

const creds: PlexCreds = {
  client_identifier: 'client-id',
  auth_token: 'account-token',
};

test('owned server history uses local owner accountID=1 and filters out plex.tv account rows', async () => {
  const calls: { url: URL; token: string }[] = [];
  const deps: PlexHistoryFetchDeps = {
    pickReachableUri: async () => ({ uri: 'https://owned.example', token: 'account-token' }),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        url,
        token: String((init?.headers as Record<string, string>)['X-Plex-Token']),
      });
      return new Response(JSON.stringify({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'owned-row',
              type: 'movie',
              title: 'Owned Row',
              viewedAt: 1_700_000_000,
              accountID: 1,
            },
            {
              ratingKey: 'global-row',
              type: 'movie',
              title: 'Global Row',
              viewedAt: 1_700_000_001,
              accountID: 98765,
            },
          ],
        },
      }), { status: 200 });
    },
  };

  assert.equal(historyAccountId(server(), { id: 98765 }), 1);

  const events = await fetchHistoryForServer({
    server: server(),
    creds,
    account: { id: 98765 },
    since: null,
    deps,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/status/sessions/history');
  assert.equal(calls[0].url.searchParams.get('accountID'), '1');
  assert.equal(calls[0].token, 'account-token');
  assert.deepEqual(events.events.map((event) => event.service_id), ['owned-client:owned-row']);
});

test('shared server history uses plex.tv accountID, resource token, fallback, and string row IDs', async () => {
  const shared = server({
    name: 'Shared Server',
    clientIdentifier: 'shared-client',
    owned: false,
    accessToken: 'shared-resource-token',
    connections: [
      {
        protocol: 'https',
        address: 'shared.example',
        port: 443,
        uri: 'https://shared.example',
        local: false,
        relay: true,
      },
    ],
  });
  const calls: { url: URL; token: string }[] = [];
  const deps: PlexHistoryFetchDeps = {
    pickReachableUri: async () => ({ uri: 'https://shared.example', token: 'shared-resource-token' }),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        url,
        token: String((init?.headers as Record<string, string>)['X-Plex-Token']),
      });
      if (url.pathname === '/status/sessions/history') {
        return new Response('shared endpoint requires fallback', { status: 401 });
      }
      return new Response(JSON.stringify({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'shared-row',
              type: 'movie',
              title: 'Shared Row',
              viewedAt: 1_700_000_002,
              accountID: '98765',
            },
            {
              ratingKey: 'other-user-row',
              type: 'movie',
              title: 'Other User Row',
              viewedAt: 1_700_000_003,
              accountID: 1,
            },
          ],
        },
      }), { status: 200 });
    },
  };

  assert.equal(historyAccountId(shared, { id: 98765 }), 98765);

  const events = await fetchHistoryForServer({
    server: shared,
    creds,
    account: { id: 98765 },
    since: null,
    deps,
  });

  assert.deepEqual(calls.map((call) => call.url.pathname), [
    '/status/sessions/history',
    '/status/sessions/history/all',
  ]);
  assert.deepEqual(calls.map((call) => call.url.searchParams.get('accountID')), ['98765', '98765']);
  assert.deepEqual(calls.map((call) => call.token), ['shared-resource-token', 'shared-resource-token']);
  assert.deepEqual(events.events.map((event) => event.service_id), ['shared-client:shared-row']);
});

test('mixed owned/shared pagination keeps accountID and token isolated on every page', async () => {
  const owned = server({ name: 'Owned Paged', clientIdentifier: 'owned-paged', owned: true });
  const shared = server({
    name: 'Shared Paged',
    clientIdentifier: 'shared-paged',
    owned: false,
    accessToken: 'shared-page-token',
  });
  const calls: { server: string; start: string | null; accountID: string | null; token: string }[] = [];
  const deps: PlexHistoryFetchDeps = {
    pickReachableUri: async (resource) => ({
      uri: resource.clientIdentifier === 'owned-paged'
        ? 'https://owned-paged.example'
        : 'https://shared-paged.example',
      token: resource.clientIdentifier === 'owned-paged' ? 'account-token' : 'shared-page-token',
    }),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const host = url.hostname.startsWith('owned') ? 'owned' : 'shared';
      const start = Number(url.searchParams.get('X-Plex-Container-Start') ?? '0');
      calls.push({
        server: host,
        start: url.searchParams.get('X-Plex-Container-Start'),
        accountID: url.searchParams.get('accountID'),
        token: String((init?.headers as Record<string, string>)['X-Plex-Token']),
      });
      const rows = host === 'owned'
        ? [
            { ratingKey: 'owned-page-1', type: 'movie', title: 'Owned Page 1', viewedAt: 1_700_000_010, accountID: 1 },
            { ratingKey: 'owned-page-2', type: 'movie', title: 'Owned Page 2', viewedAt: 1_700_000_011, accountID: 1 },
            { ratingKey: 'owned-page-3', type: 'movie', title: 'Owned Page 3', viewedAt: 1_700_000_012, accountID: 1 },
          ]
        : [
            { ratingKey: 'shared-page-1', type: 'movie', title: 'Shared Page 1', viewedAt: 1_700_000_013, accountID: 98765 },
          ];
      return new Response(JSON.stringify({
        MediaContainer: {
          totalSize: rows.length,
          Metadata: rows.slice(start, start + 2),
        },
      }), { status: 200 });
    },
    historyPageSize: 2,
  } as PlexHistoryFetchDeps;

  const ownedEvents = await fetchHistoryForServer({
    server: owned,
    creds,
    account: { id: 98765 },
    since: null,
    deps,
  });
  const sharedEvents = await fetchHistoryForServer({
    server: shared,
    creds,
    account: { id: 98765 },
    since: null,
    deps,
  });

  assert.deepEqual(ownedEvents.events.map((event) => event.service_id), [
    'owned-paged:owned-page-1',
    'owned-paged:owned-page-2',
    'owned-paged:owned-page-3',
  ]);
  assert.deepEqual(sharedEvents.events.map((event) => event.service_id), ['shared-paged:shared-page-1']);
  assert.deepEqual(calls, [
    { server: 'owned', start: '0', accountID: '1', token: 'account-token' },
    { server: 'owned', start: '2', accountID: '1', token: 'account-token' },
    { server: 'shared', start: '0', accountID: '98765', token: 'shared-page-token' },
  ]);
});

test('normalizes account IDs and rejects malformed account, discovery, and history shapes', async () => {
  assert.equal(normalizePlexAccountId(1), 1);
  assert.equal(normalizePlexAccountId('98765'), 98765);
  assert.equal(normalizePlexAccountId('1x'), null);
  assert.equal(normalizePlexAccountId('01'), null);
  assert.equal(normalizePlexAccountId(1.5), null);
  assert.equal(normalizePlexAccountId(Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(normalizePlexAccountId(null), null);

  await assert.rejects(
    () => getAccount({ ...creds, account_id: '1x', account_uuid: 'cached-uuid' }),
    /invalid cached Plex account_id/
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([
    {
      name: 'Valid Owned',
      clientIdentifier: 'valid-owned',
      owned: true,
      provides: 'server,player',
      publicAddressMatches: true,
      connections: [
        {
          protocol: 'https',
          address: 'valid-owned.example',
          port: 443,
          uri: 'https://valid-owned.example',
          local: false,
          relay: false,
        },
      ],
    },
    {
      name: 'Malformed Owned',
      clientIdentifier: 'bad-owned',
      owned: 'true',
      provides: 'server',
      publicAddressMatches: true,
      connections: [
        {
          protocol: 'https',
          address: 'bad-owned.example',
          port: 443,
          uri: 'https://bad-owned.example',
          local: false,
          relay: false,
        },
      ],
    },
    {
      name: 'Missing Client Identifier',
      clientIdentifier: '',
      owned: false,
      provides: 'server',
      publicAddressMatches: true,
      accessToken: 'shared-token',
      connections: [
        {
          protocol: 'https',
          address: 'missing-client.example',
          port: 443,
          uri: 'https://missing-client.example',
          local: false,
          relay: true,
        },
      ],
    },
    {
      name: 'Valid Shared',
      clientIdentifier: 'valid-shared',
      owned: false,
      provides: 'server',
      publicAddressMatches: false,
      accessToken: 'valid-shared-token',
      connections: [
        {
          protocol: 'https',
          address: 'valid-shared.example',
          port: 443,
          uri: 'https://valid-shared.example',
          local: false,
          relay: true,
        },
      ],
    },
    {
      name: 'Connection Defaults',
      clientIdentifier: 'connection-defaults',
      owned: true,
      provides: 'server',
      publicAddressMatches: false,
      connections: [
        {
          protocol: 'https',
          address: 'connection-defaults.example',
          port: 443,
          uri: 'https://connection-defaults.example',
        },
      ],
    },
  ]), { status: 200 });
  try {
    const discovered = await listServers(creds);
    assert.deepEqual(discovered.map((resource) => resource.clientIdentifier), [
      'valid-owned',
      'valid-shared',
      'connection-defaults',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const events = await fetchHistoryForServer({
    server: server(),
    creds,
    account: { id: 98765 },
    since: null,
    deps: {
      pickReachableUri: async () => ({ uri: 'https://owned.example', token: 'account-token' }),
      fetch: async () => new Response(JSON.stringify({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'valid-row',
              type: 'movie',
              title: 'Valid Row',
              viewedAt: 1_700_000_020,
              accountID: 1,
            },
            {
              ratingKey: 'malformed-row',
              type: 'movie',
              title: 'Malformed Row',
              viewedAt: 1_700_000_021,
              accountID: '1x',
            },
          ],
        },
      }), { status: 200 }),
    },
  });
  assert.deepEqual(events.events.map((event) => event.service_id), ['owned-client:valid-row']);
});

test('cursor metadata is canonical, versioned, monotonic, and preserves unrelated metadata', () => {
  const warnings: string[] = [];
  const parsed = parsePlexCursorMetadata({
    unrelated: { keep: true },
    plex: {
      cursor_version: 1,
      server_cursors: {
        valid: '2026-01-01T00:00:00.000Z',
        'date-only': '2026-01-01',
        future: '9999-01-01T00:00:00.000Z',
      },
    },
  }, (message) => warnings.push(message));

  assert.deepEqual(Object.keys(parsed), ['valid']);
  assert.equal(warnings.length, 2);

  assert.deepEqual(
    mergePlexCursorMetadata({
      unrelated: { keep: true },
      plex: {
        cursor_version: 1,
        server_cursors: {
          same: '2026-02-01T00:00:00.000Z',
          other: '2026-03-01T00:00:00.000Z',
        },
      },
    }, {
      same: '2026-01-01T00:00:00.000Z',
      added: '2026-04-01T00:00:00.000Z',
    }),
    {
      unrelated: { keep: true },
      plex: {
        cursor_version: 1,
        server_cursors: {
          same: '2026-02-01T00:00:00.000Z',
          other: '2026-03-01T00:00:00.000Z',
          added: '2026-04-01T00:00:00.000Z',
        },
      },
    }
  );
});

test('history JSON failures include server context', async () => {
  await assert.rejects(
    () => fetchHistoryForServer({
      server: server({ name: 'Broken JSON Server' }),
      creds,
      account: { id: 98765 },
      since: null,
      deps: {
        pickReachableUri: async () => ({ uri: 'https://owned.example', token: 'account-token' }),
        fetch: async () => new Response('{broken', { status: 200 }),
      },
    }),
    /Broken JSON Server.*invalid JSON/
  );
});

test('history endpoint errors include server context without leaking resource tokens', async () => {
  const shared = server({
    name: 'Shared Error Server',
    clientIdentifier: 'shared-error',
    owned: false,
    accessToken: 'shared-secret-token',
  });

  await assert.rejects(
    () => fetchHistoryForServer({
      server: shared,
      creds,
      account: { id: 98765 },
      since: null,
      deps: {
        pickReachableUri: async () => ({ uri: 'https://shared-error.example', token: 'shared-secret-token' }),
        fetch: async () => new Response('upstream echoed shared-secret-token', { status: 500 }),
      },
    }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Shared Error Server/);
      assert.match(err.message, /500/);
      assert.doesNotMatch(err.message, /shared-secret-token/);
      return true;
    }
  );
});

test('an unreachable server is a contextual failure and does not count as successful', async () => {
  const result = await fetchHistoryForServers({
    servers: [server({ name: 'Offline Server', clientIdentifier: 'offline-server' })],
    creds,
    account: { id: 98765 },
    since: null,
    deps: {
      pickReachableUri: async () => null,
      warn: () => undefined,
    },
  });

  assert.deepEqual(result.events, []);
  assert.deepEqual(result.successfulServers, []);
  assert.deepEqual(result.cursorCandidates, {});
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Offline Server/);
  assert.match(result.errors[0], /no reachable connection/);
});

test('server errors are isolated so other servers can still return events', async () => {
  const bad = server({ name: 'Bad Server', clientIdentifier: 'bad-server', owned: true });
  const good = server({
    name: 'Good Shared Server',
    clientIdentifier: 'good-shared',
    owned: false,
    accessToken: 'good-token',
  });

  const result = await fetchHistoryForServers({
    servers: [bad, good],
    creds,
    account: { id: 98765 },
    since: null,
    deps: {
      pickReachableUri: async (resource) => ({
        uri: resource.clientIdentifier === 'bad-server'
          ? 'https://bad.example'
          : 'https://good.example',
        token: resource.clientIdentifier === 'bad-server' ? 'account-token' : 'good-token',
      }),
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.hostname === 'bad.example') {
          return new Response('bad server echoed account-token', { status: 500 });
        }
        return new Response(JSON.stringify({
          MediaContainer: {
            Metadata: [
              {
                ratingKey: 'good-row',
                type: 'movie',
                title: 'Good Row',
                viewedAt: 1_700_000_030,
                accountID: 98765,
              },
            ],
          },
        }), { status: 200 });
      },
    },
  });

  assert.deepEqual(result.events.map((event) => event.service_id), ['good-shared:good-row']);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Bad Server/);
  assert.doesNotMatch(result.errors[0], /account-token/);
});

test('server errors can be escalated so callers do not advance a shared cursor', async () => {
  await assert.rejects(
    () => fetchHistoryForServers({
      servers: [
        server({ name: 'Bad Server', clientIdentifier: 'bad-server', owned: true }),
        server({ name: 'Good Server', clientIdentifier: 'good-server', owned: true }),
      ],
      creds,
      account: { id: 98765 },
      since: null,
      throwOnServerErrors: true,
      deps: {
        pickReachableUri: async (resource) => ({
          uri: resource.clientIdentifier === 'bad-server'
            ? 'https://bad.example'
            : 'https://good.example',
          token: 'account-token',
        }),
        fetch: async (input) => {
          const url = new URL(String(input));
          if (url.hostname === 'bad.example') {
            return new Response('bad server echoed account-token', { status: 500 });
          }
          return new Response(JSON.stringify({
            MediaContainer: {
              Metadata: [
                {
                  ratingKey: 'good-row',
                  type: 'movie',
                  title: 'Good Row',
                  viewedAt: 1_700_000_060,
                  accountID: 1,
                },
              ],
            },
          }), { status: 200 });
        },
      },
    }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Bad Server/);
      assert.doesNotMatch(err.message, /account-token/);
      return true;
    }
  );
});

test('per-server cursors isolate failures and recovery bounds', async () => {
  const bad = server({ name: 'Bad Server', clientIdentifier: 'bad-server', owned: true });
  const good = server({ name: 'Good Server', clientIdentifier: 'good-server', owned: true });
  const calls: { host: string; viewedAt: string | null }[] = [];

  const first = await fetchHistoryForServers({
    servers: [bad, good],
    creds,
    account: { id: 98765 },
    since: new Date('2025-01-01T00:00:00.000Z'),
    sinceByServer: {
      'good-server': new Date('2024-01-01T00:00:00.000Z'),
      'bad-server': new Date('2023-01-01T00:00:00.000Z'),
    },
    deps: {
      pickReachableUri: async (resource) => ({
        uri: resource.clientIdentifier === 'bad-server'
          ? 'https://bad.example'
          : 'https://good.example',
        token: 'account-token',
      }),
      fetch: async (input) => {
        const url = new URL(String(input));
        calls.push({
          host: url.hostname,
          viewedAt: url.searchParams.get('viewedAt>='),
        });
        if (url.hostname === 'bad.example') {
          return new Response('offline', { status: 503 });
        }
        return new Response(JSON.stringify({
          MediaContainer: {
            Metadata: [
              {
                ratingKey: 'good-row',
                type: 'movie',
                title: 'Good Row',
                viewedAt: 1_704_067_200,
                accountID: 1,
              },
            ],
          },
        }), { status: 200 });
      },
    },
  });

  assert.deepEqual(first.events.map((event) => event.service_id), ['good-server:good-row']);
  assert.equal(first.errors.length, 1);
  assert.match(first.errors[0], /Bad Server/);
  assert.deepEqual(first.cursorCandidates, {
    'good-server': '2024-01-01T00:00:00.000Z',
  });
  assert.deepEqual(calls, [
    { host: 'bad.example', viewedAt: '1672531200' },
    { host: 'good.example', viewedAt: '1704067200' },
  ]);

  calls.length = 0;
  const recovered = await fetchHistoryForServers({
    servers: [bad],
    creds,
    account: { id: 98765 },
    since: new Date('2025-01-01T00:00:00.000Z'),
    sinceByServer: {
      'good-server': new Date('2024-01-01T12:00:00.000Z'),
      'bad-server': new Date('2023-01-01T00:00:00.000Z'),
    },
    deps: {
      pickReachableUri: async () => ({ uri: 'https://bad.example', token: 'account-token' }),
      fetch: async (input) => {
        const url = new URL(String(input));
        calls.push({
          host: url.hostname,
          viewedAt: url.searchParams.get('viewedAt>='),
        });
        return new Response(JSON.stringify({
          MediaContainer: {
            Metadata: [
              {
                ratingKey: 'bad-row',
                type: 'movie',
                title: 'Recovered Row',
                viewedAt: 1_672_574_400,
                accountID: 1,
              },
            ],
          },
        }), { status: 200 });
      },
    },
  });

  assert.deepEqual(recovered.events.map((event) => event.service_id), ['bad-server:bad-row']);
  assert.deepEqual(recovered.cursorCandidates, {
    'bad-server': '2023-01-01T12:00:00.000Z',
  });
  assert.deepEqual(calls, [
    { host: 'bad.example', viewedAt: '1672531200' },
  ]);
});

test('a fully scanned account-mismatched server advances to the scanned high-water', async () => {
  const result = await fetchHistoryForServers({
    servers: [server({ name: 'Shared Mismatch', clientIdentifier: 'shared-mismatch', owned: false })],
    creds,
    account: { id: 98765 },
    since: null,
    deps: {
      pickReachableUri: async () => ({ uri: 'https://shared-mismatch.example', token: 'shared-token' }),
      warn: () => undefined,
      fetch: async () => new Response(JSON.stringify({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'other-user-row',
              type: 'movie',
              title: 'Other User Row',
              viewedAt: 1_700_000_080,
              accountID: 1,
            },
          ],
        },
      }), { status: 200 }),
    },
  });

  assert.deepEqual(result.events, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.cursorCandidates, {
    'shared-mismatch': '2023-11-14T22:14:40.000Z',
  });
});

test('future-dated server history fails without events or cursor advancement', async () => {
  const result = await fetchHistoryForServers({
    servers: [server({ name: 'Clock Skew Server', clientIdentifier: 'clock-skew' })],
    creds,
    account: { id: 98765 },
    since: null,
    deps: {
      pickReachableUri: async () => ({ uri: 'https://clock-skew.example', token: 'account-token' }),
      fetch: async () => new Response(JSON.stringify({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'future-row',
              type: 'movie',
              title: 'Future Row',
              viewedAt: 253_370_764_800,
              accountID: 1,
            },
          ],
        },
      }), { status: 200 }),
    },
  });

  assert.deepEqual(result.events, []);
  assert.deepEqual(result.cursorCandidates, {});
  assert.deepEqual(result.successfulServers, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Clock Skew Server.*future viewedAt/);
});

test('shared servers warn when returned rows are all filtered by accountID', async () => {
  const warnings: string[] = [];
  const events = await fetchHistoryForServer({
    server: server({ name: 'Shared Mismatch', clientIdentifier: 'shared-mismatch', owned: false }),
    creds,
    account: { id: 98765 },
    since: null,
    deps: {
      pickReachableUri: async () => ({ uri: 'https://shared-mismatch.example', token: 'shared-token' }),
      warn: (message) => warnings.push(message),
      fetch: async () => new Response(JSON.stringify({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'local-shared-row',
              type: 'movie',
              title: 'Local Shared Row',
              viewedAt: 1_700_000_070,
              accountID: 1,
            },
          ],
        },
      }), { status: 200 }),
    } as PlexHistoryFetchDeps,
  });

  assert.deepEqual(events.events, []);
  assert.ok(warnings.some((warning) =>
    warning.includes('Shared Mismatch') && warning.includes('accountID')
  ));
});

test('pagination continues through short pages when totalSize says more rows remain', async () => {
  const calls: string[] = [];
  const events = await fetchHistoryForServer({
    server: server(),
    creds,
    account: { id: 98765 },
    since: null,
    deps: {
      pickReachableUri: async () => ({ uri: 'https://owned.example', token: 'account-token' }),
      fetch: async (input) => {
        const url = new URL(String(input));
        const start = Number(url.searchParams.get('X-Plex-Container-Start') ?? '0');
        calls.push(String(start));
        const rows = [
          { ratingKey: 'short-1', type: 'movie', title: 'Short 1', viewedAt: 1_700_000_040, accountID: 1 },
          { ratingKey: 'short-2', type: 'movie', title: 'Short 2', viewedAt: 1_700_000_041, accountID: 1 },
          { ratingKey: 'short-3', type: 'movie', title: 'Short 3', viewedAt: 1_700_000_042, accountID: 1 },
        ];
        return new Response(JSON.stringify({
          MediaContainer: {
            totalSize: rows.length,
            Metadata: rows.slice(start, start + 1),
          },
        }), { status: 200 });
      },
      historyPageSize: 2,
    },
  });

  assert.deepEqual(calls, ['0', '1', '2']);
  assert.deepEqual(events.events.map((event) => event.service_id), [
    'owned-client:short-1',
    'owned-client:short-2',
    'owned-client:short-3',
  ]);
});

test('pagination page cap fails the server instead of committing a partial page sequence', async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => fetchHistoryForServer({
      server: server(),
      creds,
      account: { id: 98765 },
      since: null,
      deps: {
        pickReachableUri: async () => ({ uri: 'https://owned.example', token: 'account-token' }),
        fetch: async (input) => {
          const url = new URL(String(input));
          const start = Number(url.searchParams.get('X-Plex-Container-Start') ?? '0');
          calls.push(String(start));
          if (calls.length > 2) {
            throw new Error('pagination cap was not respected');
          }
          return new Response(JSON.stringify({
            MediaContainer: {
              Metadata: [
                { ratingKey: `cap-${start}`, type: 'movie', title: `Cap ${start}`, viewedAt: 1_700_000_050 + start, accountID: 1 },
                { ratingKey: `cap-${start + 1}`, type: 'movie', title: `Cap ${start + 1}`, viewedAt: 1_700_000_051 + start, accountID: 1 },
              ],
            },
          }), { status: 200 });
        },
        historyPageSize: 2,
        maxHistoryPages: 2,
      },
    } as PlexHistoryFetchDeps),
    /pagination hit 2 page cap/
  );

  assert.deepEqual(calls, ['0', '2']);
});
