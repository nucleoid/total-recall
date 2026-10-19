import { QWEN_CONTRACT_ID } from './local-embedding-contract.js';

/** Historical Gemini identity retained for the explicitly budgeted rollback plane. */
export const CANONICAL_EMBEDDING_DESCRIPTOR = Object.freeze({
  provider: 'gemini' as const,
  model: 'gemini-embedding-2-preview' as const,
  dimensions: 768 as const,
});

export interface EmbeddingDescriptor { provider: 'gemini' | 'llama.cpp'; model: string; dimensions: 768 }

export function resolveActiveEmbeddingDescriptor(env: NodeJS.ProcessEnv = process.env): EmbeddingDescriptor {
  const target = env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  if (!target) return CANONICAL_EMBEDDING_DESCRIPTOR;
  if (target !== QWEN_CONTRACT_ID) throw new Error('embedding.unknown_serving_contract');
  return env.SHADOW_EMBEDDING_ROLLBACK_WRITES === 'true' ? CANONICAL_EMBEDDING_DESCRIPTOR
    : Object.freeze({ provider: 'llama.cpp' as const, model: QWEN_CONTRACT_ID, dimensions: 768 as const });
}

/** Getter-backed identity observes environment loaded by application bootstrap. */
export const ACTIVE_EMBEDDING_DESCRIPTOR: EmbeddingDescriptor = Object.freeze(Object.defineProperties({}, {
  provider: { enumerable: true, get: () => resolveActiveEmbeddingDescriptor().provider },
  model: { enumerable: true, get: () => resolveActiveEmbeddingDescriptor().model },
  dimensions: { enumerable: true, get: () => 768 as const },
})) as EmbeddingDescriptor;

export function embeddingDescriptorParams(): [string, string, number] {
  const active = resolveActiveEmbeddingDescriptor();
  return [active.provider, active.model, active.dimensions];
}
