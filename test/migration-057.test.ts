import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL('../migrations/057_scoped_entity_extraction_worker.sql', import.meta.url), 'utf8');

test('entity worker migration isolates source and graph mutation', () => {
  assert.match(sql, /app_current_key_has_permission\('entity_extract'\)/);
  assert.match(sql, /key\.revoked_at IS NULL/);
  assert.match(sql, /p_namespace = ANY\(key\.namespaces\)/);
  assert.match(sql, /entity_extraction_source_lock[\s\S]*WITH CHECK \(false\)/);
  assert.match(sql, /namespace_insert ON public\.memories[\s\S]*NOT public\.app_current_key_has_permission\('entity_extract'\)/);
  assert.match(sql, /entity_worker_links_insert[\s\S]*q\.source_access_level = m\.access_level/);
  assert.match(sql, /entity_worker_queue_insert[\s\S]*md5\(m\.content\) = entity_enrichment_queue\.source_content_hash/);
  assert.match(sql, /entities_namespace_read[\s\S]*app_entity_visible\(id, namespace\)/);
  assert.match(sql, /memory_entities_namespace_read[\s\S]*app_current_key_read_scope_allowed\(m\.namespace, m\.access_level\)/);
  assert.match(sql, /entity_enrichment_queue_namespace_read[\s\S]*app_current_key_read_scope_allowed\(namespace, source_access_level\)/);
  assert.match(sql, /UPDATE public\.entities SET display_name = normalized_name/);
  assert.match(sql, /app_entity_memory_has_links[\s\S]*app_entity_extract_scope_allowed/);
  assert.match(sql, /VALUES\(p_namespace, p_type, p_normalized_name, p_normalized_name\)/);
  assert.doesNotMatch(sql, /CREATE POLICY entity_worker_(?:read|insert) ON public\.entities/);
  assert.doesNotMatch(sql, /GRANT\s+(?:INSERT|UPDATE|DELETE)\s+ON/i);
});
