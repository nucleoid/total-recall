import dotenv from 'dotenv';
import {
  ACTIVE_EMBEDDING_DESCRIPTOR,
  CANONICAL_EMBEDDING_DESCRIPTOR,
  embeddingDescriptorParams,
  type EmbeddingDescriptor,
} from './embedding-descriptor.js';

export { ACTIVE_EMBEDDING_DESCRIPTOR, CANONICAL_EMBEDDING_DESCRIPTOR, embeddingDescriptorParams };
export type { EmbeddingDescriptor };

dotenv.config();

const PHYSICAL_VECTOR_DIMENSIONS = 768;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface EmbeddingEnvironment {
  EMBEDDING_CURRENT_PROFILE?: string;
  EMBEDDING_PROFILES_JSON?: string;
  EMBEDDING_TIMEOUT_MS?: string;
  EMBEDDING_PROVIDER?: string;
  GEMINI_API_KEY?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSIONS?: string;
  [name: string]: string | undefined;
}

export interface EmbeddingProfile {
  name: string;
  provider: 'gemini' | 'ollama';
  model: string;
  dimensions: 768;
  apiKey?: string;
  baseUrl?: string;
}

export interface EmbeddingResult {
  vector: number[];
  provider: string;
  model: string;
  dimensions: number;
}

type RawProfile = {
  provider?: unknown;
  model?: unknown;
  dimensions?: unknown;
  apiKeyEnv?: unknown;
  baseUrlEnv?: unknown;
};

/** Kept for callers migrating from the pre-profile environment contract. */
export function validateEmbeddingProfile(env: EmbeddingEnvironment): Omit<EmbeddingProfile, 'name'> & { apiKey: string } {
  if (env.EMBEDDING_PROVIDER !== CANONICAL_EMBEDDING_DESCRIPTOR.provider) {
    throw new Error('Embedding requires explicit EMBEDDING_PROVIDER=gemini; implicit provider fallback is disabled');
  }
  if (!env.GEMINI_API_KEY?.trim()) throw new Error('Embedding requires a nonblank GEMINI_API_KEY');
  if (env.EMBEDDING_MODEL !== CANONICAL_EMBEDDING_DESCRIPTOR.model) {
    throw new Error(`Embedding requires EMBEDDING_MODEL=${CANONICAL_EMBEDDING_DESCRIPTOR.model}`);
  }
  if (!/^\d+$/.test(env.EMBEDDING_DIMENSIONS ?? '')) {
    throw new Error(`Embedding requires EMBEDDING_DIMENSIONS=${CANONICAL_EMBEDDING_DESCRIPTOR.dimensions}`);
  }
  const dimensions = Number(env.EMBEDDING_DIMENSIONS);
  if (!Number.isSafeInteger(dimensions) || dimensions !== CANONICAL_EMBEDDING_DESCRIPTOR.dimensions) {
    throw new Error(`Embedding requires EMBEDDING_DIMENSIONS=${CANONICAL_EMBEDDING_DESCRIPTOR.dimensions}; dimension changes need a separate migration`);
  }
  return { ...CANONICAL_EMBEDDING_DESCRIPTOR, apiKey: env.GEMINI_API_KEY };
}

/**
 * Parse named vector spaces without inferring a provider from credential presence.
 * JSON contains environment-variable references, never credentials themselves.
 */
export function parseEmbeddingProfiles(env: EmbeddingEnvironment): {
  current: EmbeddingProfile;
  profiles: readonly EmbeddingProfile[];
} {
  const currentName = env.EMBEDDING_CURRENT_PROFILE?.trim();
  const rawJson = env.EMBEDDING_PROFILES_JSON?.trim();
  if (!currentName || !rawJson) {
    throw new Error('EMBEDDING_CURRENT_PROFILE and EMBEDDING_PROFILES_JSON must be configured together');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error('EMBEDDING_PROFILES_JSON must be valid JSON', { cause: error });
  }
  if (!isRecord(parsed) || Object.keys(parsed).length === 0) {
    throw new Error('EMBEDDING_PROFILES_JSON must be a nonempty object keyed by profile name');
  }

  const profiles: EmbeddingProfile[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (!name.trim() || !isRecord(value)) throw new Error(`Embedding profile ${JSON.stringify(name)} must be an object`);
    const raw = value as RawProfile;
    const allowed = new Set(['provider', 'model', 'dimensions', 'apiKeyEnv', 'baseUrlEnv']);
    const unknown = Object.keys(value).filter(key => !allowed.has(key));
    if (unknown.length) throw new Error(`Embedding profile ${name} has unsupported fields: ${unknown.join(', ')}`);
    if (raw.provider !== 'gemini' && raw.provider !== 'ollama') {
      throw new Error(`Embedding profile ${name} has unsupported provider; expected gemini or ollama`);
    }
    if (typeof raw.model !== 'string' || !raw.model.trim()) throw new Error(`Embedding profile ${name} requires a nonblank model`);
    if (raw.dimensions !== PHYSICAL_VECTOR_DIMENSIONS) {
      throw new Error(`Embedding profile ${name} must use ${PHYSICAL_VECTOR_DIMENSIONS} dimensions; dimension changes need a separate migration`);
    }

    if (raw.provider === 'gemini') {
      const keyName = environmentReference(raw.apiKeyEnv, `${name}.apiKeyEnv`);
      const apiKey = env[keyName];
      if (!apiKey?.trim()) throw new Error(`Embedding profile ${name} requires nonblank credential environment variable ${keyName}`);
      profiles.push({ name, provider: 'gemini', model: raw.model, dimensions: 768, apiKey });
    } else {
      const urlName = environmentReference(raw.baseUrlEnv, `${name}.baseUrlEnv`);
      const baseUrl = env[urlName];
      if (!baseUrl?.trim()) throw new Error(`Embedding profile ${name} requires nonblank URL environment variable ${urlName}`);
      let url: URL;
      try { url = new URL(baseUrl); } catch { throw new Error(`Embedding profile ${name} URL environment variable ${urlName} is invalid`); }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Embedding profile ${name} URL must use http or https`);
      profiles.push({ name, provider: 'ollama', model: raw.model, dimensions: 768, baseUrl: url.toString().replace(/\/$/, '') });
    }
  }

  const current = profiles.find(profile => profile.name === currentName);
  if (!current) throw new Error(`EMBEDDING_CURRENT_PROFILE ${JSON.stringify(currentName)} is not defined`);
  if (current.provider !== CANONICAL_EMBEDDING_DESCRIPTOR.provider ||
      current.model !== CANONICAL_EMBEDDING_DESCRIPTOR.model ||
      current.dimensions !== CANONICAL_EMBEDDING_DESCRIPTOR.dimensions) {
    throw new Error(`Current embedding profile must be gemini/${CANONICAL_EMBEDDING_DESCRIPTOR.model}/${CANONICAL_EMBEDDING_DESCRIPTOR.dimensions}`);
  }
  return { current, profiles: Object.freeze(profiles) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function environmentReference(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(value)) {
    throw new Error(`Embedding profile ${field} must name an environment variable`);
  }
  return value;
}

/** Upgrade bridge for migration-023 deployments; pure named parsing remains strict. */
export function resolveEmbeddingProfiles(env: EmbeddingEnvironment): ReturnType<typeof parseEmbeddingProfiles> {
  if (!env.EMBEDDING_CURRENT_PROFILE?.trim() && !env.EMBEDDING_PROFILES_JSON?.trim()) {
    const legacy = validateEmbeddingProfile(env);
    const current: EmbeddingProfile = { name: 'current', ...legacy };
    return { current, profiles: Object.freeze([current]) };
  }
  return parseEmbeddingProfiles(env);
}

const CONFIGURED = resolveEmbeddingProfiles(process.env);
export const ACTIVE_EMBEDDING_PROFILE = Object.freeze(CONFIGURED.current);
export const EMBEDDING_PROFILES = CONFIGURED.profiles;

export function embeddingIdentity(profile: { provider: string; model: string; dimensions: number }): string {
  return `${profile.provider}\u0000${profile.model}\u0000${profile.dimensions}`;
}

export function findEmbeddingProfile(identity: { provider: string; model: string; dimensions: number }): EmbeddingProfile | undefined {
  return EMBEDDING_PROFILES.find(profile => embeddingIdentity(profile) === embeddingIdentity(identity));
}

export function validateEmbeddingVector(values: unknown, context: string, dimensions = PHYSICAL_VECTOR_DIMENSIONS): number[] {
  if (!Array.isArray(values)) throw new Error(`${context} embedding response did not contain a vector array`);
  if (values.length !== dimensions) throw new Error(`${context} embedding length ${values.length} does not match ${dimensions}`);
  return values.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${context} embedding value at index ${index} must be finite`);
    return value;
  });
}

export function validateEmbeddingBatch(values: unknown, expectedCount: number, dimensions = PHYSICAL_VECTOR_DIMENSIONS): number[][] {
  if (!Array.isArray(values)) throw new Error('Batch embedding response did not contain an embeddings array');
  if (values.length !== expectedCount) throw new Error(`Batch embedding count ${values.length} does not match requested count ${expectedCount}`);
  return values.map((value, index) => validateEmbeddingVector(value, `batch[${index}]`, dimensions));
}

export function serializeEmbeddingVector(values: number[]): string {
  return `[${validateEmbeddingVector(values, 'serialize').join(',')}]`;
}

function timeoutFromEnvironment(): number {
  const raw = process.env.EMBEDDING_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 100 || value > 120_000) throw new Error('EMBEDDING_TIMEOUT_MS must be an integer from 100 to 120000');
  return value;
}

async function withRequestTimeout<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutFromEnvironment());
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return operation(combined);
}

async function requestProfile(profile: EmbeddingProfile, texts: string[], signal?: AbortSignal, forceBatch = false): Promise<number[][]> {
  if (texts.length === 0) return [];
  return withRequestTimeout(signal, async requestSignal => {
    if (profile.provider === 'gemini') {
      const batch = forceBatch || texts.length > 1;
      const path = batch ? 'batchEmbedContents' : 'embedContent';
      const body = batch ? {
        requests: texts.map(text => ({
          model: `models/${profile.model}`,
          content: { parts: [{ text }] },
          outputDimensionality: profile.dimensions,
        })),
      } : {
        model: `models/${profile.model}`,
        content: { parts: [{ text: texts[0] }] },
        outputDimensionality: profile.dimensions,
      };
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${profile.model}:${path}?key=${profile.apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: requestSignal,
      });
      if (!response.ok) throw new Error(`Gemini ${path} failed (${response.status}): ${await response.text()}`);
      const data = await response.json() as { embedding?: { values?: unknown }; embeddings?: Array<{ values?: unknown }> };
      if (!batch) return [validateEmbeddingVector(data.embedding?.values, 'Gemini scalar', profile.dimensions)];
      return validateEmbeddingBatch(data.embeddings?.map(item => item.values), texts.length, profile.dimensions);
    }

    const response = await fetch(`${profile.baseUrl}/api/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: profile.model, input: texts }), signal: requestSignal,
    });
    if (!response.ok) throw new Error(`Ollama embed failed (${response.status}): ${await response.text()}`);
    const data = await response.json() as { embeddings?: unknown };
    return validateEmbeddingBatch(data.embeddings, texts.length, profile.dimensions);
  });
}

export async function embedWithProfile(text: string, profile: EmbeddingProfile = ACTIVE_EMBEDDING_PROFILE, signal?: AbortSignal): Promise<EmbeddingResult> {
  const [vector] = await requestProfile(profile, [text], signal);
  return { vector, provider: profile.provider, model: profile.model, dimensions: profile.dimensions };
}

export async function embedBatchWithProfile(texts: string[], profile: EmbeddingProfile = ACTIVE_EMBEDDING_PROFILE, signal?: AbortSignal): Promise<EmbeddingResult[]> {
  const vectors = await requestProfile(profile, texts, signal, true);
  return vectors.map(vector => ({ vector, provider: profile.provider, model: profile.model, dimensions: profile.dimensions }));
}

/** Backward-compatible vector-only wrappers. New writers should keep EmbeddingResult intact. */
export async function embed(text: string, signal?: AbortSignal): Promise<number[]> {
  return (await embedWithProfile(text, ACTIVE_EMBEDDING_PROFILE, signal)).vector;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  return (await embedBatchWithProfile(texts)).map(result => result.vector);
}
