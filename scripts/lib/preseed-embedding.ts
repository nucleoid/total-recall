import {
  CANONICAL_EMBEDDING_DESCRIPTOR,
  type EmbeddingDescriptor,
} from '../../src/embedding.js';

export interface PreparedEmbeddingBatch {
  descriptor: EmbeddingDescriptor;
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
 * #41's fail-closed call sites remain in place. Reaching this implementation means
 * #9's canonical descriptor and atomic identity writers are linked into the command.
 */
export function requireEmbeddingIdentityWriter(): EmbeddingDescriptor {
  return CANONICAL_EMBEDDING_DESCRIPTOR;
}
