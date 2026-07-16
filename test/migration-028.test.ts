import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('entity graph migration is tenant-safe, durable, additive, and provider-free', () => {
  const sql = readFileSync(new URL('../migrations/028_entity_graph.sql', import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN entity_source_revision INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /NEW\.entity_source_revision := OLD\.entity_source_revision \+ 1/);
  assert.match(sql, /UNIQUE \(namespace, type, normalized_name\)/);
  assert.match(sql, /FOREIGN KEY \(namespace, memory_id\)/);
  assert.match(sql, /FOREIGN KEY \(namespace, entity_id\)/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED|entity_enrichment_queue/);
  assert.match(sql, /AFTER INSERT OR UPDATE OF content, namespace, access_level/);
  assert.match(sql, /namespace = ANY\(public\.app_allowed_namespaces\(\)\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/g);
  assert.doesNotMatch(sql, /https?:\/\//i);
  assert.doesNotMatch(sql, /UPDATE public\.memories\s+SET/i);
  assert.doesNotMatch(sql, /GRANT\s+DELETE\s+ON public\.entities/i);
});
