import { CANONICAL_EMBEDDING_DESCRIPTOR } from '../../src/embedding-descriptor.js';

export interface EmbeddingTarget {
  name: string;
  provider: string;
  model: string;
  dimensions: number;
}

export function resolveConfiguredTarget(env: NodeJS.ProcessEnv, requested?: string): EmbeddingTarget {
  const current = env.EMBEDDING_CURRENT_PROFILE?.trim();
  const json = env.EMBEDDING_PROFILES_JSON?.trim();
  if (current || json) {
    if (!current || !json) throw new Error('EMBEDDING_CURRENT_PROFILE and EMBEDDING_PROFILES_JSON must be configured together');
    let value: unknown;
    try { value = JSON.parse(json); } catch { throw new Error('EMBEDDING_PROFILES_JSON must be valid JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('EMBEDDING_PROFILES_JSON must be an object');
    const name = requested ?? current;
    const raw = (value as Record<string, unknown>)[name];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Unknown embedding target profile ${JSON.stringify(name)}`);
    const profile = raw as Record<string, unknown>;
    const target = { name, provider: profile.provider, model: profile.model, dimensions: profile.dimensions };
    if (typeof target.provider !== 'string' || typeof target.model !== 'string' || typeof target.dimensions !== 'number') {
      throw new Error(`Embedding target profile ${name} has an invalid descriptor`);
    }
    if (name === current && (target.provider !== CANONICAL_EMBEDDING_DESCRIPTOR.provider ||
        target.model !== CANONICAL_EMBEDDING_DESCRIPTOR.model || target.dimensions !== CANONICAL_EMBEDDING_DESCRIPTOR.dimensions)) {
      throw new Error('Configured current target is not the approved Gemini production descriptor');
    }
    return target as EmbeddingTarget;
  }
  if (requested && requested !== 'current') throw new Error(`Unknown embedding target profile ${JSON.stringify(requested)}`);
  return { name: 'current', ...CANONICAL_EMBEDDING_DESCRIPTOR };
}
