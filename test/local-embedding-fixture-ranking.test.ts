import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLocalEmbeddingFixtureRanking, type FixtureRankingItem } from '../src/local-embedding-fixture-ranking.js';

const item = (role: 'document' | 'query', vector: number[]): FixtureRankingItem => ({ role, vector });

test('raw chunk ordering may flip while parent max ordering remains unchanged', () => {
  const reference = [
    item('document', [1, 0]), item('document', [.7, 0]), item('query', [1, 0]),
    item('document', [.8, 0]), item('query', [1, 0]),
  ];
  const actual = [[.85, 0], [.95, 0], [1, 0], [.9, 0], [1, 0]];
  const report = evaluateLocalEmbeddingFixtureRanking(reference, actual);
  assert.equal(report.parents, 2);
  assert.equal(report.parentInversions, 0);
  assert.ok(report.rawChunkInversions > 0);
});

test('a real parent maximum ordering flip fails the parent gate', () => {
  const reference = [
    item('document', [1, 0]), item('query', [1, 0]),
    item('document', [.8, 0]), item('query', [1, 0]),
  ];
  const actual = [[.7, 0], [1, 0], [.9, 0], [1, 0]];
  const report = evaluateLocalEmbeddingFixtureRanking(reference, actual);
  assert.ok(report.parentPairsChecked > 0);
  assert.ok(report.parentInversions > 0);
  assert.ok(report.parentFailurePairs.every(pair => pair.referenceGap > .005 && pair.actualGap < 0));
});

test('ambiguous empty and trailing document groups are rejected', () => {
  assert.throws(() => evaluateLocalEmbeddingFixtureRanking([item('query', [1])], [[1]]), /empty_parent/);
  assert.throws(() => evaluateLocalEmbeddingFixtureRanking([item('document', [1])], [[1]]), /trailing_documents/);
  assert.throws(() => evaluateLocalEmbeddingFixtureRanking([
    item('document', [1]), item('query', [1]), item('query', [1]),
  ], [[1], [1], [1]]), /empty_parent/);
});
