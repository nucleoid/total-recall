import type { EmbeddingClient, EmbeddingResult } from './embedding-client.js';
import { formatLocalEmbeddingInput, normalizeEmbeddingInputText, projectQwenVector, QWEN_CHUNK_CONTRACT } from './local-embedding-contract.js';
import { LocalEmbeddingError } from './local-embedding-client.js';

export interface OpenRouterEmbeddingClientOptions {
  apiKey: string;
  countFormattedTokens: (formatted: string, signal?: AbortSignal) => Promise<number>;
  beforeInference: () => Promise<void>;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const parsed = /^\d+$/u.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 300_000) : undefined;
}

const MAX_OPENROUTER_RESPONSE_BYTES = 2 * 1024 * 1024;

async function readJsonBounded(response: Response): Promise<unknown> {
  const rawLength = response.headers.get('content-length');
  if (rawLength && /^\d+$/u.test(rawLength) && Number(rawLength) > MAX_OPENROUTER_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new LocalEmbeddingError('embedding.openrouter_response_limit', 'systemic');
  }
  if (!response.body) throw new LocalEmbeddingError('embedding.openrouter_response_json', 'systemic');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_OPENROUTER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new LocalEmbeddingError('embedding.openrouter_response_limit', 'systemic');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch (error) {
    if (error instanceof LocalEmbeddingError) throw error;
    throw new LocalEmbeddingError('embedding.openrouter_response_json', 'systemic');
  }
}
/**
 * OpenRouter is used only for bulk inference. Tokenization remains pinned to the
 * matching local artifact so chunk boundaries and accounting cannot drift.
 */
export class OpenRouterEmbeddingClient implements EmbeddingClient {
  private readonly apiKey: string;
  private readonly countTokens: OpenRouterEmbeddingClientOptions['countFormattedTokens'];
  private readonly guard: () => Promise<void>;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: OpenRouterEmbeddingClientOptions) {
    if (!options.apiKey.trim() || /[\r\n]/u.test(options.apiKey)) throw new Error('embedding.credential');
    const base = new URL(options.baseUrl ?? 'https://openrouter.ai/api/v1/');
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || base.hostname !== 'openrouter.ai' || base.port || base.pathname !== '/api/v1/') throw new Error('embedding.openrouter_endpoint');
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 300_000) {
      throw new Error('embedding.timeout_limit');
    }
    this.apiKey = options.apiKey;
    this.countTokens = options.countFormattedTokens;
    this.guard = options.beforeInference;
    this.endpoint = new URL('embeddings', base).toString();
    this.fetcher = options.fetch ?? fetch;
  }

  countFormattedTokens(formatted: string, signal?: AbortSignal): Promise<number> {
    return this.countTokens(normalizeEmbeddingInputText(formatted), signal);
  }

  async embed(texts: string[], role: 'document' | 'query', signal?: AbortSignal): Promise<EmbeddingResult> {
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > QWEN_CHUNK_CONTRACT.requestMaxInputs) {
      throw new LocalEmbeddingError('embedding.batch_input_limit', 'input');
    }
    const formatted = texts.map(text => formatLocalEmbeddingInput(text, role));
    const tokens: number[] = [];
    for (const input of formatted) tokens.push(await this.countTokens(input, signal));
    const maxInput = role === 'document' ? QWEN_CHUNK_CONTRACT.chunkTokens : QWEN_CHUNK_CONTRACT.queryMaxTokens;
    if (tokens.some(count => count > maxInput)
      || tokens.reduce((sum, count) => sum + count, 0) > QWEN_CHUNK_CONTRACT.requestMaxTokens) {
      throw new LocalEmbeddingError('embedding.request_token_limit', 'input');
    }
    await this.guard();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://recall.stakewatch.dev',
          'X-Title': 'Total Recall re-embedding',
        },
        body: JSON.stringify({
          model: QWEN_CHUNK_CONTRACT.hostedModel,
          input: formatted,
          encoding_format: 'float',
          provider: { order: [QWEN_CHUNK_CONTRACT.hostedProvider], allow_fallbacks: false },
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
      });
    } catch {
      throw new LocalEmbeddingError(signal?.aborted ? 'embedding.cancelled' : 'embedding.transport', 'retryable');
    }
    if (!response.ok) {
      const classification = [408, 409, 429, 500, 502, 503, 504].includes(response.status) ? 'retryable'
        : [400, 413, 422].includes(response.status) ? 'input' : 'systemic';
      const delay = retryAfterMs(response);
      await response.body?.cancel();
      throw new LocalEmbeddingError(`embedding.openrouter_http_${response.status}`, classification, delay);
    }
    const parsed = await readJsonBounded(response);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LocalEmbeddingError('embedding.openrouter_response_shape', 'systemic');
    }
    const identity = parsed as Record<string, unknown>;
    if (typeof identity.model !== 'string' || identity.model.toLowerCase() !== QWEN_CHUNK_CONTRACT.hostedModel
      || identity.provider !== QWEN_CHUNK_CONTRACT.hostedProvider) {
      throw new LocalEmbeddingError('embedding.openrouter_response_identity', 'systemic');
    }
    const data = identity.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new LocalEmbeddingError('embedding.openrouter_response_count', 'systemic');
    }
    const vectors: number[][] = [];
    for (let index = 0; index < data.length; index++) {
      const item = data[index];
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || (item as Record<string, unknown>).index !== index) {
        throw new LocalEmbeddingError('embedding.openrouter_response_order', 'systemic');
      }
      try { vectors.push(projectQwenVector((item as Record<string, unknown>).embedding)); }
      catch { throw new LocalEmbeddingError('embedding.openrouter_response_vector', 'systemic'); }
    }
    const usage = (parsed as Record<string, unknown>).usage;
    const promptTokens = usage && typeof usage === 'object' && !Array.isArray(usage)
      ? (usage as Record<string, unknown>).prompt_tokens : undefined;
    if (!Number.isSafeInteger(promptTokens) || promptTokens !== tokens.reduce((sum, count) => sum + count, 0)) {
      throw new LocalEmbeddingError('embedding.openrouter_token_accounting', 'systemic');
    }
    return { vectors, tokens };
  }
}
