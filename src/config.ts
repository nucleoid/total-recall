const HNSW_EF_SEARCH_DEFAULT = 200;
const HNSW_EF_SEARCH_MIN = 1;
const HNSW_EF_SEARCH_MAX = 1000;

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
