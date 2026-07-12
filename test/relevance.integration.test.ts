import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('stable relevance base migration defines the bounded STABLE formula without repairing rows', () => {
  const sql = readFileSync(join(root, 'migrations/018_stable_relevance_base.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS relevance_base_score DOUBLE PRECISION/);
  assert.doesNotMatch(sql, /UPDATE\s+public\.memories/i);
  assert.match(sql, /GREATEST\(0(?:\.0)?,\s*EXTRACT/i);
  assert.match(sql, /LEAST\(GREATEST\(COALESCE\(p_access_count, 0\) \* 0\.1, 0(?:\.0)?\), 1\.0\)/i);
  assert.match(sql, /DROP FUNCTION public\.calculate_relevance\(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, INTEGER\)/i);
  assert.match(sql, /p_relevance_base_score double precision/i);
  assert.match(sql, /LANGUAGE plpgsql\s+STABLE/i);
});

test('hybrid search scores stable base exactly once per materialized candidate', () => {
  const source = readFileSync(join(root, 'src/search.ts'), 'utf8');
  assert.match(source, /relevance_base_score/);
  assert.match(source, /scored AS MATERIALIZED/i);
  const calls = source.match(/calculate_relevance\(/g) ?? [];
  assert.equal(calls.length, 1);
  assert.match(source, /LEAST\(s\.relevance, 2\.0\)/);
});

test('operator documentation preserves explicit approval for historical repairs', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['repair:relevance-scores'], 'tsx scripts/repair-relevance-scores.ts');
  assert.match(readme, /relevance_base_score/);
  assert.match(readme, /verified restorable backup/i);
  assert.match(readme, /exact (row )?IDs/i);
  assert.match(readme, /old code.*unsafe/i);
});
