import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityAccepted, compatibilityMetrics, cosine, OPENROUTER_LOCAL_THRESHOLDS } from '../src/embedding-compatibility.js';

test('compatibility metrics compare same-input vectors and cross-runtime retrieval rankings', () => {
  const hostedDocuments = [[1, 0], [0, 1]];
  const localDocuments = [[0.999, 0.01], [0.01, 0.999]];
  const hostedQueries = [[1, 0], [0, 1]];
  const localQueries = [[0.999, 0.01], [0.01, 0.999]];
  const metrics = compatibilityMetrics(hostedDocuments, localDocuments, hostedQueries, localQueries);
  assert.ok(metrics.minimumSameInputCosine > 0.99);
  assert.equal(metrics.topOneAgreement, 1);
  assert.equal(compatibilityAccepted(metrics), true);
});

test('compatibility gate rejects vector drift and ranking disagreement', () => {
  const metrics = compatibilityMetrics([[1, 0], [0, 1]], [[0, 1], [1, 0]], [[1, 0]], [[1, 0]]);
  assert.equal(metrics.topOneAgreement, 0);
  assert.equal(compatibilityAccepted(metrics), false);
  assert.deepEqual(OPENROUTER_LOCAL_THRESHOLDS, {
    minimumSameInputCosine: 0.97,
    minimumMeanSameInputCosine: 0.985,
    minimumTopOneAgreement: 0.8,
  });
  assert.throws(() => cosine([1], [1, 2]), /dimensions/);
  assert.throws(() => cosine([0, 0], [1, 0]), /norm/);
});
