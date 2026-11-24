import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql=readFileSync(new URL('../migrations/061_entity_extraction_coverage.sql',import.meta.url),'utf8');

test('entity coverage migration leaves legacy rows unmarked and gates new receipts',()=>{
  assert.match(sql,/ADD COLUMN extraction_contract text/);
  assert.match(sql,/ADD COLUMN extraction_result text/);
  assert.doesNotMatch(sql,/UPDATE\s+public\.entity_enrichment_queue\s+SET\s+extraction_contract/i);
  assert.match(sql,/complete_entity_enrichment_job[\s\S]*app_entity_extract_scope_allowed/);
  assert.match(sql,/extraction_contract='entity-extraction:v1'/);
  assert.match(sql,/REVOKE UPDATE ON public\.entity_enrichment_queue/);
  assert.match(sql,/extraction_contract = NULL, extraction_result = NULL/);
});
