import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID, formatLocalEmbeddingInput, sha256, validateEmbeddingText } from './local-embedding-contract.js';

/** Must count exact formatted input including model-added tokens. Never estimate from characters. */
export type MeasuredTokenizer = (text: string) => Promise<number>;

export interface EmbeddingChunk {
  ordinal: number;
  coreStart: number;
  coreEnd: number;
  sha256: string;
  tokens: number;
  text: string;
}

export interface ParentChunkPlan {
  contractId: string;
  sourceSha256: string;
  sourceBytes: number;
  chunks: EmbeddingChunk[];
}

// Python str.isspace semantics used by frozen v3, excluding CR/LF for blank-line interiors.
const INNER_SPACE = '[\\t\\v\\f \\u001c-\\u001f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const ALL_SPACE = /^[\t\n\v\f\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;

export async function planEmbeddingChunks(text: string, tokenize: MeasuredTokenizer): Promise<ParentChunkPlan> {
  validateEmbeddingText(text);
  const cap = QWEN_CHUNK_CONTRACT.chunkTokens;
  const spans: Array<{ start: number; end: number; tokens: number }> = [];
  const count = async (input: string): Promise<number> => {
    const formatted = formatLocalEmbeddingInput(input, 'document');
    // Oversized normalized requests signal a split, never a persisted token count.
    if (Buffer.byteLength(formatted, 'utf8') > 1_048_576) return cap + 1;
    const n = await tokenize(formatted);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('embedding.invalid_token_count');
    return n;
  };
  async function split(start: number, end: number): Promise<void> {
    const piece = text.slice(start, end);
    const tokens = await count(piece);
    if (tokens <= cap) { spans.push({ start, end, tokens }); return; }
    const codepoints = Array.from(piece);
    if (codepoints.length <= 1) throw new Error('embedding.codepoint_over_token_limit');
    const middle = start + codepoints.slice(0, Math.floor(codepoints.length / 2)).join('').length;
    await split(start, middle);
    await split(middle, end);
  }
  const paragraphs: Array<{ start: number; end: number }> = [];
  const blankLine = new RegExp(`(?:\\r\\n|\\r|\\n)(?:${INNER_SPACE}*(?:\\r\\n|\\r|\\n))+`, 'gu');
  let cursor = 0;
  for (const match of text.matchAll(blankLine)) {
    const end = match.index! + match[0].length;
    paragraphs.push({ start: cursor, end }); cursor = end;
  }
  if (cursor < text.length || !paragraphs.length) paragraphs.push({ start: cursor, end: text.length });
  const last = paragraphs[paragraphs.length - 1];
  const lastText = text.slice(last.start, last.end);
  const isolate = paragraphs.length > 1 && !ALL_SPACE.test(lastText)
    && await count(lastText) <= QWEN_CHUNK_CONTRACT.finalParagraphIsolationTokens;
  let packed: { start: number; end: number; tokens: number } | undefined;
  const flush = () => { if (packed) spans.push(packed); packed = undefined; };
  for (let i = 0; i < paragraphs.length; i++) {
    const { start, end } = paragraphs[i];
    const tokens = await count(text.slice(start, end));
    if (tokens > cap) { flush(); await split(start, end); continue; }
    if (isolate && i === paragraphs.length - 1) { flush(); spans.push({ start, end, tokens }); continue; }
    if (!packed) { packed = { start, end, tokens }; continue; }
    const combined = await count(text.slice(packed.start, end));
    if (combined <= cap) packed = { start: packed.start, end, tokens: combined };
    else { flush(); packed = { start, end, tokens }; }
  }
  flush();
  const chunks: EmbeddingChunk[] = [];
  let byteCursor = 0;
  let charCursor = 0;
  for (const span of spans) {
    const piece = text.slice(span.start, span.end);
    const verifiedTokens = await count(piece);
    if (verifiedTokens !== span.tokens || verifiedTokens > cap) throw new Error('embedding.unstable_tokenizer');
    if (span.start !== charCursor) throw new Error('embedding.chunk_gap');
    const bytes = Buffer.byteLength(piece, 'utf8');
    chunks.push({ ordinal: chunks.length, coreStart: byteCursor, coreEnd: byteCursor + bytes,
      sha256: sha256(piece), tokens: verifiedTokens, text: piece });
    byteCursor += bytes; charCursor = span.end;
  }
  const plan = { contractId: QWEN_CONTRACT_ID, sourceSha256: sha256(text), sourceBytes: byteCursor, chunks };
  validateParentChunkPlan(text, plan);
  return plan;
}

/** Independent validation before persistence/transport; caller must still verify source revision. */
export function validateParentChunkPlan(text: string, plan: ParentChunkPlan): void {
  validateEmbeddingText(text);
  const source = Buffer.from(text, 'utf8');
  if (plan.contractId !== QWEN_CONTRACT_ID || plan.sourceSha256 !== sha256(source)
      || plan.sourceBytes !== source.length || !plan.chunks.length) throw new Error('embedding.plan_identity');
  let cursor = 0;
  for (let i = 0; i < plan.chunks.length; i++) {
    const chunk = plan.chunks[i];
    validateEmbeddingText(chunk.text);
    const bytes = Buffer.from(chunk.text, 'utf8');
    if (chunk.ordinal !== i || chunk.coreStart !== cursor || !Number.isSafeInteger(chunk.coreEnd)
      || chunk.coreEnd !== cursor + bytes.length || chunk.coreEnd > source.length
      || !source.subarray(cursor, chunk.coreEnd).equals(bytes) || chunk.sha256 !== sha256(bytes)
      || !Number.isSafeInteger(chunk.tokens) || chunk.tokens < 0 || chunk.tokens > QWEN_CHUNK_CONTRACT.chunkTokens
      || (bytes.length === 0 && !(source.length === 0 && plan.chunks.length === 1))) {
      throw new Error('embedding.invalid_chunk_manifest');
    }
    cursor = chunk.coreEnd;
  }
  if (cursor !== source.length) throw new Error('embedding.incomplete_chunk_manifest');
}
