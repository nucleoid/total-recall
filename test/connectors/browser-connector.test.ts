import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserHistoryConnector,
  browserSourceId,
  sanitizeBrowserUrl,
} from '../../src/connectors/browser/connector.js';

const SOURCE_KEY = 'a'.repeat(32);

test('browser source IDs are stable, keyed, and do not expose profile paths', () => {
  const first = browserSourceId('chromium', '/profiles/Personal', SOURCE_KEY);
  const replay = browserSourceId('chromium', '/profiles/Personal', SOURCE_KEY);
  const other = browserSourceId('chromium', '/profiles/Work', SOURCE_KEY);
  assert.equal(first, replay);
  assert.notEqual(first, other);
  assert.match(first, /^chromium:v1:[a-f0-9]{64}$/);
  assert.equal(first.includes('Personal'), false);
});

test('browser URL sanitization defaults to registrable origin and strips sensitive components', () => {
  assert.deepEqual(
    sanitizeBrowserUrl('https://user:pass@news.private.example.co.uk/path?q=secret#fragment'),
    { url: 'https://example.co.uk', displayHost: 'example.co.uk' },
  );
  assert.deepEqual(
    sanitizeBrowserUrl('https://news.private.example.co.uk/path?q=secret#fragment', true),
    { url: 'https://news.private.example.co.uk/path', displayHost: 'example.co.uk' },
  );
});

test('browser URL sanitization excludes local, private, file, and extension targets', () => {
  for (const url of [
    'http://localhost/admin',
    'http://192.168.1.2/',
    'http://intranet/page',
    'http://router.local/',
    'file:///home/user/secret.txt',
    'chrome-extension://abcdef/page.html',
  ]) {
    assert.equal(sanitizeBrowserUrl(url), null, url);
  }
});

test('browser transform preserves visit time, sanitizes fields, and advances over excluded rows', async () => {
  const connector = new BrowserHistoryConnector({
    browser: 'firefox',
    profilePath: '/profiles/Personal',
    sourceKey: SOURCE_KEY,
    now: () => new Date('2026-07-16T12:00:00.000Z'),
    pageSize: 3,
    runHelper: async () => ({
      visits: [
        { id: 1, cursor_time: '1700000000000000', visited_at: '2023-11-14T22:13:20.000Z', url: 'file:///secret', title: 'Secret' },
        { id: 2, cursor_time: '1700000001000000', visited_at: '2023-11-14T22:13:21.000Z', url: 'https://www.example.com/a?token=x', title: '  Example\u0000 Title  ' },
      ],
    }),
  });
  const context = { apiKeyId: 'key-1', agentId: 'agent-1', scope: { keyId: 'key-1', namespaces: ['activity'] } };
  const [source] = await connector.listSources(context, new AbortController().signal);
  const page = await connector.fetchPage(
    source,
    { cursor: null, lastEventAt: null, metadata: {} },
    context,
    new AbortController().signal,
  );

  assert.equal(page.done, true);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].event_key, 'visit:2');
  assert.equal(page.events[0].occurred_at, '2023-11-14T22:13:21.000Z');
  assert.equal(page.events[0].title, 'Example Title');
  assert.deepEqual(page.events[0].metadata, {
    url: 'https://example.com', browser: 'firefox', url_storage: 'registrable_origin',
  });
  assert.deepEqual(JSON.parse(page.cursor!), { version: 1, time: '1700000001000000', id: 2 });
});
