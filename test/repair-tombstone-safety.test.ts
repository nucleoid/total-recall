import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(name: string): Promise<string> {
  return readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
}

function occurrences(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

test('memory repair candidates and final mutations independently exclude tombstones', async () => {
  const [lastBoosted, eventAt, gemini, watcher, duplicates, rollupDates, rollupTags, spotify, relevance] = await Promise.all([
    source('repair-last-boosted-at.ts'),
    source('repair-media-event-at.ts'),
    source('repair-gemini-source-keys.ts'),
    source('repair-watcher-orphans.ts'),
    source('repair-media-event-duplicates.ts'),
    source('repair-media-rollup-dates.ts'),
    source('repair-media-rollup-tags.ts'),
    source('repair-spotify-progress.ts'),
    source('repair-relevance-scores.ts'),
  ]);

  assert.match(lastBoosted, /WITH candidates[\s\S]*?last_boosted_at IS NULL[\s\S]*?deleted_at IS NULL[\s\S]*?UPDATE public\.memories[\s\S]*?memories\.deleted_at IS NULL/i);
  assert.ok(occurrences(eventAt, /deleted_at IS NULL/gi) >= 5, 'event_at candidate, reports, and final update must all be active-only');
  assert.ok(occurrences(gemini, /deleted_at IS NULL/gi) >= 5, 'Gemini preview, collision reads, updates, and deletes must all be active-only');
  assert.ok(occurrences(watcher, /deleted_at IS NULL/gi) >= 4, 'watcher pagination, lock recheck, and delete must all be active-only');

  assert.match(duplicates, /FROM public\.memories m[\s\S]*?id = ANY\(\$1::uuid\[\]\) AND deleted_at IS NULL/i);
  assert.match(duplicates, /UPDATE public\.media_events[\s\S]*?EXISTS \([\s\S]*?m\.deleted_at IS NULL/i);
  assert.match(duplicates, /DELETE FROM public\.memories[^`]*deleted_at IS NULL RETURNING id/i);

  assert.ok(occurrences(rollupDates, /deleted_at IS NULL/gi) >= 3, 'rollup-date preview, lock, and update must all be active-only');
  assert.ok(occurrences(rollupTags, /deleted_at IS NULL/gi) >= 2, 'rollup-tag preview and update must both be active-only');
  assert.match(spotify, /UPDATE memories[\s\S]*?WHERE id = \$1::uuid AND deleted_at IS NULL/i);
  assert.match(spotify, /SELECT 1 FROM memories WHERE id = \$1::uuid AND deleted_at IS NULL/i);
  assert.match(relevance, /SELECT id, relevance_base_score FROM public\.memories[\s\S]*?deleted_at IS NULL/i);
});

test('maintenance inventory is active-only while document chunk counts retain immutable all-chunk semantics', async () => {
  const [maintenance, documentCounts] = await Promise.all([
    source('lib/maintenance-db.ts'),
    source('repair-document-chunk-counts.ts'),
  ]);

  assert.match(maintenance, /SELECT namespace, count\(\*\)::text AS count[\s\S]*?FROM public\.memories[\s\S]*?WHERE deleted_at IS NULL[\s\S]*?GROUP BY namespace/i);
  assert.match(documentCounts, /including tombstones[\s\S]*?immutable ingestion cardinality/i);
  assert.doesNotMatch(documentCounts, /memory\.deleted_at/i, 'physical document chunk totals intentionally include tombstoned chunks');
});
