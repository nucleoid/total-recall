export const MAINTENANCE_EMBEDDING_MODEL = 'gemini-embedding-2-preview';
export const MAINTENANCE_EMBEDDING_DIMENSIONS = 768;

export interface MaintenanceEmbeddingEnvironment {
  EMBEDDING_PROVIDER?: string;
  GEMINI_API_KEY?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSIONS?: string;
}

export interface MaintenanceEmbeddingProfile {
  provider: 'gemini';
  apiKey: string;
  model: typeof MAINTENANCE_EMBEDDING_MODEL;
  dimensions: typeof MAINTENANCE_EMBEDDING_DIMENSIONS;
}

/**
 * Maintenance must reproduce the canonical stored-vector profile. Unlike the
 * live embedding bootstrap, this validates the already-loaded environment and
 * never loads or overrides dotenv itself.
 */
export function validateMaintenanceEmbeddingProfile(
  env: MaintenanceEmbeddingEnvironment,
): MaintenanceEmbeddingProfile {
  if (env.EMBEDDING_PROVIDER !== 'gemini') {
    throw new Error('Maintenance re-embedding requires explicit EMBEDDING_PROVIDER=gemini');
  }
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey?.trim()) {
    throw new Error('Maintenance re-embedding requires Gemini via a nonblank GEMINI_API_KEY; Ollama fallback is not allowed');
  }
  if (env.EMBEDDING_MODEL !== MAINTENANCE_EMBEDDING_MODEL) {
    throw new Error(`Maintenance re-embedding requires EMBEDDING_MODEL=${MAINTENANCE_EMBEDDING_MODEL}`);
  }
  if (env.EMBEDDING_DIMENSIONS !== String(MAINTENANCE_EMBEDDING_DIMENSIONS)) {
    throw new Error(`Maintenance re-embedding requires EMBEDDING_DIMENSIONS=${MAINTENANCE_EMBEDDING_DIMENSIONS}`);
  }
  return {
    provider: 'gemini',
    apiKey,
    model: MAINTENANCE_EMBEDDING_MODEL,
    dimensions: MAINTENANCE_EMBEDDING_DIMENSIONS,
  };
}

export function createMaintenanceEmbedder(
  profile: MaintenanceEmbeddingProfile,
  request: typeof fetch = fetch,
): (texts: string[]) => Promise<number[][]> {
  return async texts => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${profile.model}:batchEmbedContents?key=${profile.apiKey}`;
    const response = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map(text => ({
          model: `models/${profile.model}`,
          content: { parts: [{ text }] },
          outputDimensionality: profile.dimensions,
        })),
      }),
    });
    if (!response.ok) throw new Error(`Gemini maintenance embedding request failed (${response.status})`);
    const data = await response.json() as { embeddings?: Array<{ values?: number[] }> };
    if (!Array.isArray(data.embeddings)) throw new Error('Gemini maintenance embedding response was malformed');
    return data.embeddings.map(embedding => embedding.values ?? []);
  };
}
