import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../migrations/015_memory_event_time.sql', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const repairScript = readFileSync(new URL('../scripts/repair-media-event-at.ts', import.meta.url), 'utf8');

test('migration 015 only adds the nullable event_at column', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS event_at\s+TIMESTAMPTZ/i);
  assert.doesNotMatch(migration, /\bUPDATE\s+memories\b/i);
  assert.doesNotMatch(migration, /pg_input_is_valid\(metadata->>'played_at',\s*'timestamptz'\)/i);
  assert.doesNotMatch(migration, /CREATE\s+INDEX/i);
  assert.doesNotMatch(migration, /CONCURRENTLY/i);
  assert.doesNotMatch(migration, /SET created_at\s*=/i);
  assert.doesNotMatch(migration, /SET content\s*=/i);
  assert.doesNotMatch(migration, /SET embedding\s*=/i);
});

test('event_at rollout exposes separate operational commands', () => {
  assert.equal(
    packageJson.scripts['repair:media-event-at'],
    'tsx scripts/repair-media-event-at.ts'
  );
  assert.equal(
    packageJson.scripts['index:media-event-at'],
    'tsx scripts/create-media-event-at-index.ts'
  );
});

test('event_at index command repairs invalid concurrent index leftovers', () => {
  assert.match(repairScript, /pg_index/i);
  assert.match(repairScript, /indisvalid/i);
  assert.match(repairScript, /DROP INDEX CONCURRENTLY IF EXISTS public\.memories_media_event_at_idx/i);
  assert.match(repairScript, /CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_media_event_at_idx/i);
});

test('event_at rollout docs name PostgreSQL floor and bounded-search backfill window', () => {
  assert.match(readme, /PostgreSQL 16/i);
  assert.match(readme, /played_after.*played_before[\s\S]+remainingRows` is `0`/i);
});
