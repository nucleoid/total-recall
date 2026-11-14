export interface FixtureRankingItem {
  role: 'document' | 'query';
  vector: number[];
}

export interface RankingInversion {
  query: number;
  first: number;
  second: number;
  referenceGap: number;
  actualGap: number;
}

export interface FixtureRankingReport {
  parents: number;
  documentChunks: number;
  queries: number;
  rankingTieTolerance: number;
  parentPairsChecked: number;
  parentInversions: number;
  parentFailurePairs: RankingInversion[];
  rawChunkPairsChecked: number;
  rawChunkInversions: number;
  rawChunkFailurePairs: RankingInversion[];
}

interface Parent { id: number; documents: number[]; query: number }
interface Score { id: number; reference: number; actual: number }

/**
 * Compares a validator runtime with a fixed reference at the same unit used by
 * search: consecutive document chunks form one parent and the following query
 * terminates that fixture. A parent's score is its maximum chunk cosine.
 */
export function evaluateLocalEmbeddingFixtureRanking(
  reference: readonly FixtureRankingItem[],
  actualVectors: readonly (readonly number[])[],
  rankingTieTolerance = 0.005,
): FixtureRankingReport {
  if (!Number.isFinite(rankingTieTolerance) || rankingTieTolerance < 0) throw new Error('fixture_ranking.tie_tolerance');
  if (!reference.length || reference.length !== actualVectors.length) throw new Error('fixture_ranking.shape');
  const dimensions = reference[0]?.vector.length;
  if (!dimensions) throw new Error('fixture_ranking.shape');
  for (let index = 0; index < reference.length; index++) {
    const item = reference[index], actual = actualVectors[index];
    if (!item || !['document', 'query'].includes(item.role) || item.vector.length !== dimensions
      || actual?.length !== dimensions || item.vector.some(value => !Number.isFinite(value))
      || actual.some(value => !Number.isFinite(value))) throw new Error('fixture_ranking.shape');
  }

  const parents: Parent[] = [];
  let documents: number[] = [];
  for (let index = 0; index < reference.length; index++) {
    if (reference[index].role === 'document') documents.push(index);
    else {
      if (!documents.length) throw new Error('fixture_ranking.empty_parent');
      parents.push({ id: parents.length, documents, query: index });
      documents = [];
    }
  }
  if (documents.length) throw new Error('fixture_ranking.trailing_documents');

  const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const chunkIds = reference.map((item, index) => ({ item, index })).filter(({ item }) => item.role === 'document').map(({ index }) => index);
  const compare = (query: Parent, candidates: readonly { id: number; members: readonly number[] }[]) => {
    const ranked: Score[] = candidates.map(candidate => ({
      id: candidate.id,
      reference: Math.max(...candidate.members.map(index => dot(reference[query.query].vector, reference[index].vector))),
      actual: Math.max(...candidate.members.map(index => dot(actualVectors[query.query], actualVectors[index]))),
    })).sort((a, b) => b.reference - a.reference || a.id - b.id);
    let pairs = 0, inversions = 0;
    const failures: RankingInversion[] = [];
    for (let first = 0; first < Math.min(10, ranked.length); first++) for (let second = first + 1; second < ranked.length; second++) {
      const referenceGap = ranked[first].reference - ranked[second].reference;
      if (referenceGap <= rankingTieTolerance) continue;
      pairs++;
      const actualGap = ranked[first].actual - ranked[second].actual;
      if (actualGap < 0) {
        inversions++;
        if (failures.length < 100) failures.push({ query: query.query, first: ranked[first].id, second: ranked[second].id, referenceGap, actualGap });
      }
    }
    return { pairs, inversions, failures };
  };

  let parentPairsChecked = 0, parentInversions = 0, rawChunkPairsChecked = 0, rawChunkInversions = 0;
  const parentFailurePairs: RankingInversion[] = [], rawChunkFailurePairs: RankingInversion[] = [];
  const parentCandidates = parents.map(parent => ({ id: parent.id, members: parent.documents }));
  const chunkCandidates = chunkIds.map(index => ({ id: index, members: [index] }));
  for (const query of parents) {
    const parentResult = compare(query, parentCandidates), chunkResult = compare(query, chunkCandidates);
    parentPairsChecked += parentResult.pairs; rawChunkPairsChecked += chunkResult.pairs;
    parentInversions += parentResult.inversions; rawChunkInversions += chunkResult.inversions;
    parentFailurePairs.push(...parentResult.failures.slice(0, 100 - parentFailurePairs.length));
    rawChunkFailurePairs.push(...chunkResult.failures.slice(0, 100 - rawChunkFailurePairs.length));
  }
  return {
    parents: parents.length, documentChunks: chunkIds.length, queries: parents.length, rankingTieTolerance,
    parentPairsChecked, parentInversions, parentFailurePairs,
    rawChunkPairsChecked, rawChunkInversions, rawChunkFailurePairs,
  };
}
