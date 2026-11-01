import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  mediaStatsQuerySchema,
  memoriesQuerySchema,
} from '../src/http-schemas.js';
import { toApiDateTime } from '../dashboard/api.js';
import { INGESTION_FAILURE_CATEGORIES, INGESTION_JOB_STATUSES } from '../src/ingestion.js';

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

test('dashboard stylesheet preserves the hidden state against authored display rules', async () => {
  const styles = await readFile(new URL('../dashboard/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});

test('dashboard ingestion queue panel is admin-gated, mirrors the server state vocabulary, and uses same-origin typed helpers', async () => {
  const [api, app, types] = await Promise.all([
    readFile(new URL('../dashboard/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../dashboard/app.ts', import.meta.url), 'utf8'),
    readFile(new URL('../dashboard/types.ts', import.meta.url), 'utf8'),
  ]);
  // Typed helpers are the only way the panel talks to the queue endpoints.
  assert.match(api, /export function getIngestionStats\(/);
  assert.match(api, /'\/api\/ingestion\/stats'/);
  assert.match(api, /paused \? '\/api\/ingestion\/pause' : '\/api\/ingestion\/resume'/);
  assert.match(api, /`\/api\/ingestion\/jobs\/\$\{encodeURIComponent\(memoryId\)\}\/requeue`/);
  assert.doesNotMatch(app, /'\/api\/ingestion\//);
  assert.match(types, /export interface IngestionStats \{/);
  assert.match(types, /export interface IngestionRequeueResult \{/);

  // The panel renders only inside the admin branch of the overview, and every
  // mutation is additionally gated on write permission.
  const overview = app.slice(app.indexOf('async function renderOverview('), app.indexOf('function table('));
  assert.match(overview, /if \(capabilities\?\.capabilities\.admin\) \{[\s\S]*ingestionQueuePanel\(\)[\s\S]*\} else \{/);
  assert.match(app, /function canOperateIngestion\(\): boolean \{\s*return Boolean\(capabilities\?\.capabilities\.admin && capabilities\.capabilities\.write\);/);
  const panel = app.slice(app.indexOf('const INGESTION_STATUSES'), app.indexOf('const INGESTION_LABELS'));
  assert.ok(panel.includes('function ingestionQueuePanel('), 'the panel code sits between its vocabulary constants and the badge labels');
  assert.match(panel, /if \(canOperateIngestion\(\)\) \{[\s\S]*setIngestionPaused\(!stats\.worker\.paused\)[\s\S]*requeueIngestionJob\(input\.value\.trim\(\)\)/);
  assert.match(panel, /Pause, resume, and requeue require an admin key with write permission\./);
  assert.match(app, /\(ingestionState === 'embedding_failed' \|\| ingestionState === 'cancelled'\) && canOperateIngestion\(\)/);

  // The dashboard vocabulary is the server's, so a new status or category cannot silently vanish from the panel.
  for (const status of INGESTION_JOB_STATUSES) assert.match(panel, new RegExp(`'${status}'`), status);
  for (const category of INGESTION_FAILURE_CATEGORIES) assert.match(panel, new RegExp(`'${category}'`), category);

  // Content-free: the panel reads queue aggregates, worker health and the gate, never memory fields.
  for (const field of ['stats.enabled', 'stats.queued', 'stats.oldest_pending_age_seconds', 'stats.next_retry_at', 'stats.worker.paused', 'stats.worker.last_seen_at', 'stats.depth[', 'stats.failure_categories[']) {
    assert.ok(panel.includes(field), field);
  }
  assert.doesNotMatch(panel, /\.content\b|\.tags\b|\.metadata\b/);
  assert.doesNotMatch(panel, /innerHTML|insertAdjacentHTML|outerHTML/);
});

test('dashboard exposes readable agent provenance, stable GUIDs, and bounded navigation', async () => {
  const [app, types, memories, indexScript, server] = await Promise.all([
    readFile(new URL('../dashboard/app.ts', import.meta.url), 'utf8'),
    readFile(new URL('../dashboard/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/memories.ts', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/create-memory-browse-index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(types, /agent_name:\s*string/);
  assert.match(app, /memory\.provenance\?\.agent_name/);
  assert.match(app, /\['id', 'name', 'type', 'model', 'runtime'/);
  assert.match(app, /function pager\(/);
  assert.match(app, /function sequencePager\(/);
  assert.doesNotMatch(app, /input\.addEventListener\('input'.*run/);
  assert.match(memories, /CROSS JOIN LATERAL/);
  assert.match(memories, /set_config\('statement_timeout', '12000', true\)/);
  assert.doesNotMatch(memories, /to_jsonb\(m\)->>'consolidated_into_id' IS NULL/);
  assert.match(indexScript, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  assert.match(indexScript, /WHERE deleted_at IS NULL AND superseded_at IS NULL AND consolidated_into_id IS NULL/);
  assert.match(server, /existsSync\(resolve\(releaseDashboardDirectory, 'index\.html'\)\)/);
  assert.match(server, /\? releaseDashboardDirectory\s*:\s*builtDashboardDirectory/);
});
