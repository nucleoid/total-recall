import {
  CANONICAL_EMBEDDING_DESCRIPTOR,
  type EmbeddingProfile,
} from '../../src/embedding.js';

export interface PreparedEmbeddingBatch {
  descriptor: Omit<EmbeddingProfile, 'apiKey'>;
  embeddings: number[][];
}

export type BatchEmbedder = (texts: string[]) => Promise<number[][]>;

export async function prepareCanonicalEmbeddingBatch(
  persistedContents: string[],
  embedder: BatchEmbedder,
): Promise<PreparedEmbeddingBatch> {
  if (persistedContents.length === 0) {
    return { descriptor: CANONICAL_EMBEDDING_DESCRIPTOR, embeddings: [] };
  }
  const embeddings = await embedder(persistedContents);
  if (embeddings.length !== persistedContents.length) {
    throw new Error(`Embedding response count mismatch: expected ${persistedContents.length}, received ${embeddings.length}`);
  }
  for (const vector of embeddings) {
    if (vector.length !== CANONICAL_EMBEDDING_DESCRIPTOR.dimensions || vector.some(value => !Number.isFinite(value))) {
      throw new Error(`Embedding response must contain finite ${CANONICAL_EMBEDDING_DESCRIPTOR.dimensions}-dimensional vectors`);
    }
  }
  return { descriptor: CANONICAL_EMBEDDING_DESCRIPTOR, embeddings };
}

/**
 * #41 may not guess the storage contract owned by blocked prerequisite #9.
 * Keep import commands unavailable until #9 supplies an atomic vector+identity writer.
 */
export function requireEmbeddingIdentityWriter(): void {
  throw new Error('Preseed is disabled until #9 provides the embedding identity schema and atomic descriptor writer');
}
