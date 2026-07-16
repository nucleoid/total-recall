import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  mediaStatsQuerySchema,
  memoriesQuerySchema,
} from '../src/http-schemas.js';
import { toApiDateTime } from '../dashboard/api.js';

const id = '00000000-0000-4000-8000-000000000001';

test('memory browsing query contract validates filters, deterministic sorting, and bounds', () => {
  assert.deepEqual(memoriesQuerySchema.parse({}), {
    limit: 50,
    offset: 0,
    sort: 'created_at',
    direction: 'desc',
    active: 'active',
  });
  assert.deepEqual(memoriesQuerySchema.parse({
    namespace: 'shared', source: 'test', tag: ['one', 'two'], agent_id: id,
    access_level: 'sensitive', active: 'all', created_after: '2026-07-01T00:00:00Z',
    created_before: '2026-07-31T00:00:00Z', sort: 'relevance', direction: 'asc',
    limit: '200', offset: '12',
  }), {
    namespace: 'shared', source: 'test', tags: ['one', 'two'], agent_id: id,
    access_level: 'sensitive', active: 'all', created_after: '2026-07-01T00:00:00Z',
    created_before: '2026-07-31T00:00:00Z', sort: 'relevance', direction: 'asc',
    limit: 200, offset: 12,
  });
  assert.throws(() => memoriesQuerySchema.parse({ limit: '201' }));
  assert.throws(() => memoriesQuerySchema.parse({ sort: 'content' }));
  assert.throws(() => memoriesQuerySchema.parse({ created_after: 'later' }));
});

test('dashboard normalizes every datetime-local value to an offset timestamp', () => {
  for (const value of ['2026-07-16T00:00', '2026-07-16T13:45']) {
    assert.equal(toApiDateTime(value), new Date(value).toISOString());
  }
});

test('media stats contract validates inclusive date range and service', () => {
  assert.deepEqual(mediaStatsQuerySchema.parse({}), {});
  assert.deepEqual(mediaStatsQuerySchema.parse({
    service: 'spotify', played_after: '2026-07-01T00:00:00Z', played_before: '2026-07-31T23:59:59Z', limit: '25',
  }), {
    service: 'spotify', played_after: '2026-07-01T00:00:00Z', played_before: '2026-07-31T23:59:59Z', limit: 25,
  });
  assert.throws(() => mediaStatsQuerySchema.parse({ played_after: '2026-08-01T00:00:00Z', played_before: '2026-07-01T00:00:00Z' }));
});

test('dashboard client keeps bearer keys out of durable and injectable surfaces', async () => {
  const [api, app, html] = await Promise.all([
    readFile(new URL('../dashboard/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../dashboard/app.ts', import.meta.url), 'utf8'),
    readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8'),
  ]);
  assert.match(api, /sessionStorage/);
  assert.doesNotMatch(`${api}\n${app}\n${html}`, /localStorage/);
  assert.doesNotMatch(`${api}\n${app}`, /innerHTML\s*=/);
  assert.doesNotMatch(html, /<script(?![^>]+src=)/i);
  assert.doesNotMatch(html, /tr_[A-Za-z0-9_-]+/);
});
