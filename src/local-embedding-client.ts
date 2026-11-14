import { formatLocalEmbeddingInput, normalizeEmbeddingInputText, projectQwenVector, QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from './local-embedding-contract.js';
import { createPinnedTlsFetch, type PinnedTlsTransport } from './local-embedding-transport.js';

export type EmbeddingFailureClass = 'input' | 'retryable' | 'systemic';
export class LocalEmbeddingError extends Error {
  constructor(public readonly code: string, public readonly classification: EmbeddingFailureClass,
    public readonly retryAfterMs?: number) { super(code); }
}

export interface VerifiedLocalRuntime {
  contractId: string;
  artifactSha256: string;
  runtimeContract: string;
  /** Immutable acceptance receipt from actual-runtime fixture and installation checks. */
  acceptanceReceiptSha256: string;
  tls?: PinnedTlsTransport;
}

export interface LocalEmbeddingClientOptions {
  baseUrl: string;
  bearerToken: string;
  runtime: VerifiedLocalRuntime;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** GPU workers must supply the fail-closed thermal/authority check here. */
  beforeInference: () => Promise<void>;
}

/** Consume and recognize only the gateway's current bounded contention response. */
export async function isExactGatewayBusy(response: Response): Promise<boolean> {
  if (response.status !== 429 || !response.body) { await response.body?.cancel(); return false; }
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
  try {
    while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>128){await reader.cancel();return false;}chunks.push(next.value);}
    const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
    const value=JSON.parse(raw) as unknown;
    return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1
      && (value as Record<string,unknown>).error==='busy';
  } catch { try{await reader.cancel();}catch{} return false; }
}

/** Pinned llama.cpp contract. Ollama is not silently substituted for a tokenizer-compatible runtime. */
export class LocalEmbeddingClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  private readonly token: string;
  private readonly guard: () => Promise<void>;

  constructor(options: LocalEmbeddingClientOptions) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) throw new Error('embedding.endpoint');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'http:' && !loopback) throw new Error('embedding.transport_requires_tls');
    if (!options.bearerToken.trim() || /[\r\n]/u.test(options.bearerToken)) throw new Error('embedding.credential');
    const runtime = options.runtime;
    if (runtime.contractId !== QWEN_CONTRACT_ID || runtime.artifactSha256 !== QWEN_CHUNK_CONTRACT.artifactSha256
      || runtime.runtimeContract !== QWEN_CHUNK_CONTRACT.runtimeContract
      || !/^[a-f0-9]{64}$/u.test(runtime.acceptanceReceiptSha256)) throw new Error('embedding.runtime_identity');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) throw new Error('embedding.timeout_limit');
    this.baseUrl = url.origin;
    if(url.protocol==='https:'&&!runtime.tls)throw new Error('embedding.tls_identity');
    if(url.protocol==='http:'&&runtime.tls)throw new Error('embedding.tls_unexpected');
    this.fetcher = options.fetch ?? (runtime.tls?createPinnedTlsFetch(runtime.tls):fetch);
    this.token = options.bearerToken;
    this.guard = options.beforeInference;
  }

  private async post(path: '/tokenize' | '/v1/embeddings', body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(this.baseUrl + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
      });
    } catch {
      // Never propagate provider exceptions/bodies: they may contain text or credential-bearing URLs.
      throw new LocalEmbeddingError(signal?.aborted ? 'embedding.cancelled' : 'embedding.transport', 'retryable');
    }
    if (!response.ok) {
      const checkedBusy=response.status===429;
      if (checkedBusy&&await isExactGatewayBusy(response)) throw new LocalEmbeddingError('embedding.gateway_busy', 'retryable', 1000);
      const classification = response.status === 429 || response.status === 503 || response.status === 504 ? 'retryable'
        : response.status === 400 || response.status === 413 || response.status === 422 ? 'input' : 'systemic';
      const raw = response.headers.get('retry-after');
      let delay: number | undefined;
      if (raw) {
        const parsed = /^\d+$/u.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
        if (Number.isFinite(parsed) && parsed >= 0) delay = Math.min(parsed, 300_000);
      }
      if(!checkedBusy)await response.body?.cancel();
      throw new LocalEmbeddingError(`embedding.http_${response.status}`, classification, delay);
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch { throw new LocalEmbeddingError('embedding.response_json', 'systemic'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LocalEmbeddingError('embedding.response_shape', 'systemic');
    return parsed as Record<string, unknown>;
  }

  async countFormattedTokens(formatted: string, signal?: AbortSignal): Promise<number> {
    const data = await this.post('/tokenize', { content: normalizeEmbeddingInputText(formatted), add_special: true }, signal);
    if (!Array.isArray(data.tokens) || data.tokens.some(x => !Number.isSafeInteger(x) || x < 0)) {
      throw new LocalEmbeddingError('embedding.tokenizer_shape', 'systemic');
    }
    return data.tokens.length;
  }

  async embed(texts: string[], role: 'document' | 'query', signal?: AbortSignal): Promise<{ vectors: number[][]; tokens: number[] }> {
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > QWEN_CHUNK_CONTRACT.requestMaxInputs) {
      throw new LocalEmbeddingError('embedding.batch_input_limit', 'input');
    }
    const formatted = texts.map(text => formatLocalEmbeddingInput(text, role));
    const tokens: number[] = [];
    for (const input of formatted) tokens.push(await this.countFormattedTokens(input, signal));
    const maxInput = role === 'document' ? QWEN_CHUNK_CONTRACT.chunkTokens : QWEN_CHUNK_CONTRACT.queryMaxTokens;
    const total = tokens.reduce((sum, n) => sum + n, 0);
    if (tokens.some(n => n > maxInput) || total > QWEN_CHUNK_CONTRACT.requestMaxTokens) {
      throw new LocalEmbeddingError('embedding.request_token_limit', 'input');
    }
    await this.guard();
    // Exact preflight rejects oversized inputs. Explicit truncate:false is also carried on the wire.
    const data = await this.post('/v1/embeddings', { input: formatted, truncate: false }, signal);
    if (!Array.isArray(data.data) || data.data.length !== texts.length) throw new LocalEmbeddingError('embedding.response_count', 'systemic');
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      const item = data.data[i];
      if (!item || typeof item !== 'object' || item.index !== i) throw new LocalEmbeddingError('embedding.response_order', 'systemic');
      try { vectors.push(projectQwenVector(item.embedding)); }
      catch { throw new LocalEmbeddingError('embedding.response_vector', 'systemic'); }
    }
    const usage = data.usage;
    if (!usage || typeof usage !== 'object' || !('prompt_tokens' in usage) || usage.prompt_tokens !== total) {
      throw new LocalEmbeddingError('embedding.token_accounting', 'systemic');
    }
    return { vectors, tokens };
  }
}
