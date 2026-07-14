/**
 * Content-free, credential-free identity of the only embedding space currently
 * written by this deployment. Maintenance/selection code may import this file
 * without triggering provider configuration or network access.
 */
export const CANONICAL_EMBEDDING_DESCRIPTOR = Object.freeze({
  provider: 'gemini' as const,
  model: 'gemini-embedding-2-preview' as const,
  dimensions: 768 as const,
});

export const ACTIVE_EMBEDDING_DESCRIPTOR = CANONICAL_EMBEDDING_DESCRIPTOR;
export type EmbeddingDescriptor = typeof CANONICAL_EMBEDDING_DESCRIPTOR;

export function embeddingDescriptorParams(): [string, string, number] {
  return [
    ACTIVE_EMBEDDING_DESCRIPTOR.provider,
    ACTIVE_EMBEDDING_DESCRIPTOR.model,
    ACTIVE_EMBEDDING_DESCRIPTOR.dimensions,
  ];
}
