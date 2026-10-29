export interface CompatibilityThresholds {
  minimumSameInputCosine: number;
  minimumMeanSameInputCosine: number;
  minimumTopOneAgreement: number;
}

export const OPENROUTER_LOCAL_THRESHOLDS: CompatibilityThresholds = Object.freeze({
  minimumSameInputCosine: 0.97,
  minimumMeanSameInputCosine: 0.985,
  minimumTopOneAgreement: 0.8,
});

export function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) throw new Error('embedding.compatibility_dimensions');
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index], b = right[index];
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('embedding.compatibility_nonfinite');
    dot += a * b; leftNorm += a * a; rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) throw new Error('embedding.compatibility_norm');
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function topDocument(query: number[], documents: number[][]): number {
  if (!documents.length) throw new Error('embedding.compatibility_documents');
  let best = 0, score = -Infinity;
  for (let index = 0; index < documents.length; index++) {
    const current = cosine(query, documents[index]);
    if (current > score) { score = current; best = index; }
  }
  return best;
}

export function compatibilityMetrics(
  hostedDocuments: number[][],
  localDocuments: number[][],
  hostedQueries: number[][],
  localQueries: number[][],
) {
  if (hostedDocuments.length !== localDocuments.length || hostedQueries.length !== localQueries.length
    || !hostedDocuments.length || !hostedQueries.length) throw new Error('embedding.compatibility_cardinality');
  const sameInputCosines = [
    ...hostedDocuments.map((vector, index) => cosine(vector, localDocuments[index])),
    ...hostedQueries.map((vector, index) => cosine(vector, localQueries[index])),
  ];
  let topOneMatches = 0;
  for (let index = 0; index < hostedQueries.length; index++) {
    if (topDocument(hostedQueries[index], hostedDocuments) === topDocument(localQueries[index], localDocuments)) {
      topOneMatches++;
    }
  }
  return {
    minimumSameInputCosine: Math.min(...sameInputCosines),
    meanSameInputCosine: sameInputCosines.reduce((sum, value) => sum + value, 0) / sameInputCosines.length,
    topOneAgreement: topOneMatches / hostedQueries.length,
    comparisons: sameInputCosines.length,
    queries: hostedQueries.length,
  };
}

export function compatibilityAccepted(
  metrics: ReturnType<typeof compatibilityMetrics>,
  thresholds = OPENROUTER_LOCAL_THRESHOLDS,
): boolean {
  return metrics.minimumSameInputCosine >= thresholds.minimumSameInputCosine
    && metrics.meanSameInputCosine >= thresholds.minimumMeanSameInputCosine
    && metrics.topOneAgreement >= thresholds.minimumTopOneAgreement;
}
