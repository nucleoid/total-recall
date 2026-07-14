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

export interface EmbeddingEnvironment {
  EMBEDDING_PROVIDER?: string;
  GEMINI_API_KEY?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSIONS?: string;
}

export interface EmbeddingProfile extends EmbeddingDescriptor {
  apiKey: string;
}

export function validateEmbeddingProfile(env: EmbeddingEnvironment): EmbeddingProfile {
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

const ACTIVE_EMBEDDING_PROFILE = validateEmbeddingProfile(process.env);

export function validateEmbeddingVector(values: unknown, context: string): number[] {
  if (!Array.isArray(values)) throw new Error(`${context} embedding response did not contain a vector array`);
  if (values.length !== ACTIVE_EMBEDDING_DESCRIPTOR.dimensions) {
    throw new Error(`${context} embedding length ${values.length} does not match ${ACTIVE_EMBEDDING_DESCRIPTOR.dimensions}`);
  }
  return values.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${context} embedding value at index ${index} must be finite`);
    }
    return value;
  });
}

export function validateEmbeddingBatch(values: unknown, expectedCount: number): number[][] {
  if (!Array.isArray(values)) throw new Error('Batch embedding response did not contain an embeddings array');
  if (values.length !== expectedCount) {
    throw new Error(`Batch embedding count ${values.length} does not match requested count ${expectedCount}`);
  }
  return values.map((value, index) => validateEmbeddingVector(value, `batch[${index}]`));
}

export function serializeEmbeddingVector(values: number[]): string {
  return `[${validateEmbeddingVector(values, 'serialize').join(',')}]`;
}

async function requestGemini(
  path: 'embedContent' | 'batchEmbedContents',
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${ACTIVE_EMBEDDING_PROFILE.model}:${path}?key=${ACTIVE_EMBEDDING_PROFILE.apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal },
  );
  if (!response.ok) throw new Error(`Gemini ${path} failed (${response.status}): ${await response.text()}`);
  return response;
}

export async function embed(text: string, signal?: AbortSignal): Promise<number[]> {
  const response = await requestGemini('embedContent', {
    model: `models/${ACTIVE_EMBEDDING_PROFILE.model}`,
    content: { parts: [{ text }] },
    outputDimensionality: ACTIVE_EMBEDDING_PROFILE.dimensions,
  }, signal);
  const data = await response.json() as { embedding?: { values?: unknown } };
  return validateEmbeddingVector(data.embedding?.values, 'Gemini scalar');
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await requestGemini('batchEmbedContents', {
    requests: texts.map(text => ({
      model: `models/${ACTIVE_EMBEDDING_PROFILE.model}`,
      content: { parts: [{ text }] },
      outputDimensionality: ACTIVE_EMBEDDING_PROFILE.dimensions,
    })),
  });
  const data = await response.json() as { embeddings?: Array<{ values?: unknown }> };
  return validateEmbeddingBatch(data.embeddings?.map(item => item.values), texts.length);
}
