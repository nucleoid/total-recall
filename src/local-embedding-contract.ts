import { createHash } from 'node:crypto';

export const QWEN_QUERY_PREFIX = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:';

/** Semantic fields only: endpoints, credentials and mutable model tags are not identity. */
export const QWEN_CHUNK_CONTRACT = Object.freeze({
  version: 'total-recall/qwen3-0.6b-q8/paragraph256-utf8/v1',
  artifactSha256: '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439',
  upstreamRevision: '370f27d7550e0def9b39c1f16d3fbaa13aa67728',
  quantization: 'Q8_0',
  tokenizer: 'artifact-tokenizer/add_special=true',
  pooling: 'last-token',
  nativeDimensions: 1024,
  storedDimensions: 768,
  projection: 'first-768-then-l2',
  documentPrefix: '',
  queryPrefix: QWEN_QUERY_PREFIX,
  queryPrefixSha256: '9fab7feb99edb69f560d85cf1bb849dd556c37f383d0336574f78f1303e90740',
  allocatedContextTokens: 4096,
  truncation: 'reject',
  chunkTokens: 256,
  finalParagraphIsolationTokens: 64,
  chunkAlgorithm: 'blank-line-pack/recursive-codepoint-bisection/python-unicode-whitespace',
  offsets: 'utf8-bytes/codepoint-boundaries',
  overlap: 0,
  empty: 'one-empty-chunk',
  requestMaxInputs: 4,
  requestMaxTokens: 2000,
  queryMaxTokens: 2000,
  // Additional runtimes require recorded compatibility acceptance before use.
  runtimeContract: 'llama.cpp/b11669/last-pool/tokenize-special/native1024',
});

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export const QWEN_CONTRACT_ID = sha256(JSON.stringify(QWEN_CHUNK_CONTRACT));

export function validateEmbeddingText(text: string): void {
  if (typeof text !== 'string') throw new Error('embedding.input_type');
  if (text.includes('\u0000')) throw new Error('embedding.postgres_nul');
  // Buffer silently replaces lone surrogates; rejecting them prevents lossy fingerprints.
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('embedding.invalid_unicode');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error('embedding.invalid_unicode');
  }
  if (Buffer.byteLength(text, 'utf8') > 1_048_576) throw new Error('embedding.parent_byte_limit');
}

export function formatLocalEmbeddingInput(text: string, role: 'query' | 'document'): string {
  validateEmbeddingText(text);
  if (role !== 'query' && role !== 'document') throw new Error('embedding.invalid_role');
  return role === 'query' ? QWEN_QUERY_PREFIX + text : text;
}

/** Accept native vectors only; an already-cropped vector cannot masquerade as native. */
export function projectQwenVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== QWEN_CHUNK_CONTRACT.nativeDimensions) {
    throw new Error('embedding.native_dimensions');
  }
  if (value.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error('embedding.nonfinite_vector');
  const nativeNorm = Math.hypot(...value as number[]);
  if (!Number.isFinite(nativeNorm) || nativeNorm === 0) throw new Error('embedding.native_norm');
  const result = (value as number[]).slice(0, QWEN_CHUNK_CONTRACT.storedDimensions);
  const norm = Math.hypot(...result);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('embedding.projected_norm');
  return result.map(x => x / norm);
}

export function validateLocalStoredVector(value: unknown): asserts value is number[] {
  if (!Array.isArray(value) || value.length !== 768 || value.some(x => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new Error('embedding.stored_vector');
  }
  if (Math.abs(Math.hypot(...value as number[]) - 1) > 1e-5) throw new Error('embedding.stored_norm');
}
