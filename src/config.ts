const HNSW_EF_SEARCH_DEFAULT = 200;
const HNSW_EF_SEARCH_MIN = 1;
const HNSW_EF_SEARCH_MAX = 1000;
const SUPERSEDED_SCORE_FACTOR_DEFAULT = 0.25;

export function parseHnswEfSearch(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') {
    return HNSW_EF_SEARCH_DEFAULT;
  }

  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new Error(
      `HNSW_EF_SEARCH must be a decimal integer from ${HNSW_EF_SEARCH_MIN} to ${HNSW_EF_SEARCH_MAX}; got ${JSON.stringify(raw)}`
    );
  }

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < HNSW_EF_SEARCH_MIN || value > HNSW_EF_SEARCH_MAX) {
    throw new Error(
      `HNSW_EF_SEARCH must be a decimal integer from ${HNSW_EF_SEARCH_MIN} to ${HNSW_EF_SEARCH_MAX}; got ${JSON.stringify(raw)}`
    );
  }

  return value;
}

export function hnswEfSearchFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return parseHnswEfSearch(env.HNSW_EF_SEARCH);
}

export function parseSupersededScoreFactor(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return SUPERSEDED_SCORE_FACTOR_DEFAULT;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`SUPERSEDED_SCORE_FACTOR must be greater than 0 and at most 1; got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function supersededScoreFactorFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return parseSupersededScoreFactor(env.SUPERSEDED_SCORE_FACTOR);
}

/** Superseded-row ranking changes are an explicit rollout step, never implicit. */
export function supersededSearchDemotionEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUPERSEDED_SEARCH_DEMOTION_ENABLED === 'true';
}
