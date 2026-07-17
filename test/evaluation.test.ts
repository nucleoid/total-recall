import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateMetrics,
  baselineMismatches,
  caseMetric,
  parseEvaluationDataset,
  stableHash,
  type EvaluationReport,
} from '../src/evaluation.js';

test('binary metrics calculate recall@k, reciprocal rank, hit rate, misses, and diagnostic exclusion', () => {
  const hit = caseMetric(new Set(['a', 'c']), ['x', 'a', 'b', 'c'], 3);
  assert.deepEqual(hit, {
    recall: 0.5, reciprocal_rank: 0.5, hit: true, first_relevant_rank: 2,
    relevant_count: 2, retrieved_relevant_count: 1,
  });
  const miss = caseMetric(new Set(['z']), ['x'], 5);
  const diagnostic = caseMetric(new Set(), ['x'], 5, true);
  assert.deepEqual(aggregateMetrics([hit, miss, diagnostic]), {
    recall_at_k: 0.25, mrr: 0.25, hit_rate_at_k: 0.5, evaluated_cases: 2, diagnostic_cases: 1,
  });
});

test('dataset validation rejects duplicate cases, duplicate judgments, grades, and ambiguous empty judgments', () => {
  const base = { schema_version: 1, name: 'x', namespaces: ['shared'], cases: [
    { id: 'one', query: 'q', relevant: [{ source_key: 'key' }] },
  ] };
  assert.equal(parseEvaluationDataset(base).defaults.k, 10);
  assert.throws(() => parseEvaluationDataset({ ...base, cases: [...base.cases, base.cases[0]] }), /Duplicate evaluation case/);
  assert.throws(() => parseEvaluationDataset({ ...base, cases: [{ ...base.cases[0], relevant: [{ source_key: 'key' }, { source_key: 'key' }] }] }), /repeats judgment/);
  assert.throws(() => parseEvaluationDataset({ ...base, cases: [{ id: 'one', query: 'q', relevant: [] }] }), /requires relevant/);
  assert.throws(() => parseEvaluationDataset({ ...base, cases: [{ id: 'one', query: 'q', relevant: [{ source_key: 'key', grade: 2 }] }] }), /unrecognized_key/);
  const uuidCase = { ...base, cases: [{ id: 'one', query: 'q', relevant: [{ id: '123e4567-e89b-42d3-a456-426614174000' }] }] };
  assert.throws(() => parseEvaluationDataset(uuidCase), /identity_mode is not local_uuid/);
  assert.equal(parseEvaluationDataset({ ...uuidCase, identity_mode: 'local_uuid' }).identity_mode, 'local_uuid');
});

test('stable hashes ignore object key insertion order', () => {
  assert.equal(stableHash({ b: 2, a: { d: 4, c: 3 } }), stableHash({ a: { c: 3, d: 4 }, b: 2 }));
});

test('baseline comparison reports every incompatible dimension', () => {
  const report = {
    report_schema_version: 1, dataset: { hash: 'a', name: 'x', schema_version: 1 },
    embedding: { provider: 'gemini', model: 'm', dimensions: 768, profile: 'p' },
    execution: { as_of: 'a', ef_search: 200, ranking_hash: 'r', config_hash: 'c' },
  } as EvaluationReport;
  const changed = structuredClone(report);
  changed.dataset.hash = 'b'; changed.embedding.model = 'other'; changed.execution.as_of = 'b'; changed.execution.ef_search = 300;
  assert.deepEqual(baselineMismatches(report, changed), ['dataset hash', 'as_of', 'ef_search', 'embedding model']);
});
