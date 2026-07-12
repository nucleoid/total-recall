import dotenv from 'dotenv';
dotenv.config();

export const CANONICAL_EMBEDDING_DESCRIPTOR = Object.freeze({
  provider: 'gemini' as const,
  model: 'gemini-embedding-2-preview' as const,
  dimensions: 768 as const,
});

export interface EmbeddingEnvironment {
  EMBEDDING_PROVIDER?: string;
  GEMINI_API_KEY?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSIONS?: string;
}

export interface EmbeddingProfile {
  provider: typeof CANONICAL_EMBEDDING_DESCRIPTOR.provider;
  model: typeof CANONICAL_EMBEDDING_DESCRIPTOR.model;
  dimensions: typeof CANONICAL_EMBEDDING_DESCRIPTOR.dimensions;
  apiKey: string;
}

export function validateEmbeddingProfile(env: EmbeddingEnvironment): EmbeddingProfile {
  if (env.EMBEDDING_PROVIDER !== CANONICAL_EMBEDDING_DESCRIPTOR.provider) {
    throw new Error('Embedding requires explicit EMBEDDING_PROVIDER=gemini; implicit Ollama fallback is disabled');
  }
  if (!env.GEMINI_API_KEY?.trim()) throw new Error('Embedding requires a nonblank GEMINI_API_KEY');
  if (env.EMBEDDING_MODEL !== CANONICAL_EMBEDDING_DESCRIPTOR.model) {
    throw new Error(`Embedding requires EMBEDDING_MODEL=${CANONICAL_EMBEDDING_DESCRIPTOR.model}`);
  }
  if (env.EMBEDDING_DIMENSIONS !== String(CANONICAL_EMBEDDING_DESCRIPTOR.dimensions)) {
    throw new Error(`Embedding requires EMBEDDING_DIMENSIONS=${CANONICAL_EMBEDDING_DESCRIPTOR.dimensions}`);
  }
  return { ...CANONICAL_EMBEDDING_DESCRIPTOR, apiKey: env.GEMINI_API_KEY };
}

// Existing live readers/writers retain their import-time profile until #9 and #61 make
// a coordinated provider cutover safe. Canonical preseed/repair entry points are gated.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-004';
const EMBEDDING_DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS || '768', 10);
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'nomic-embed-text';
const useGemini = !!GEMINI_API_KEY;

if (useGemini) {
  console.error(`[embedding] Using Gemini API (${EMBEDDING_MODEL}, ${EMBEDDING_DIMENSIONS}d)`);
} else {
  console.error(`[embedding] No GEMINI_API_KEY found, falling back to Ollama (${OLLAMA_MODEL})`);
}

async function embedGemini(text: string): Promise<number[]> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    }),
  });
  if (!res.ok) throw new Error(`Gemini embed failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { embedding?: { values?: number[] } };
  if (!data.embedding?.values) throw new Error('No embedding returned from Gemini');
  return data.embedding.values;
}

async function embedOllama(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, input: texts.length === 1 ? texts[0] : texts }),
  });
  if (!res.ok) throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { embeddings?: number[][] };
  if (!Array.isArray(data.embeddings) || data.embeddings.length === 0) {
    throw new Error('No embedding returned from Ollama');
  }
  return data.embeddings;
}

export async function embed(text: string): Promise<number[]> {
  return useGemini ? embedGemini(text) : (await embedOllama([text]))[0];
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!useGemini) return embedOllama(texts);
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: texts.map(text => ({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    })) }),
  });
  if (!res.ok) throw new Error(`Gemini batch embed failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { embeddings?: Array<{ values?: number[] }> };
  if (!Array.isArray(data.embeddings)) throw new Error('No embeddings returned from Gemini');
  return data.embeddings.map(item => item.values ?? []);
}
