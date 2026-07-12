import dotenv from 'dotenv';
dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-004';
const EMBEDDING_DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS || '768', 10);

// Fallback to Ollama if no Gemini key
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'nomic-embed-text';

const useGemini = !!GEMINI_API_KEY;

if (useGemini) {
  console.log(`[embedding] Using Gemini API (${EMBEDDING_MODEL}, ${EMBEDDING_DIMENSIONS}d)`);
} else {
  console.log(`[embedding] No GEMINI_API_KEY found, falling back to Ollama (${OLLAMA_MODEL})`);
}

async function embedGemini(text: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini embed failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { embedding: { values: number[] } };
  if (!data.embedding?.values) {
    throw new Error('No embedding returned from Gemini');
  }
  return data.embedding.values;
}

async function embedOllama(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, input: text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embed failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { embeddings: number[][] };
  if (!data.embeddings?.[0]) {
    throw new Error('No embedding returned from Ollama');
  }
  return data.embeddings[0];
}

export async function embed(text: string): Promise<number[]> {
  return useGemini ? embedGemini(text) : embedOllama(text);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (useGemini) {
    // Gemini batch: use batchEmbedContents
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${GEMINI_API_KEY}`;
    const requests = texts.map(text => ({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    }));

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini batch embed failed (${res.status}): ${body}`);
    }

    const data = await res.json() as { embeddings: Array<{ values: number[] }> };
    return data.embeddings.map(e => e.values);
  } else {
    // Ollama batch
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, input: texts }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama batch embed failed (${res.status}): ${body}`);
    }

    const data = await res.json() as { embeddings: number[][] };
    return data.embeddings;
  }
}
