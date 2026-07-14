import { Buffer } from 'node:buffer';

export interface GenerationRequest {
  system: string;
  input: string;
  model: string;
  maxOutputBytes: number;
  signal: AbortSignal;
}

/** Provider-neutral boundary. Implementations must not enable tools. */
export interface GenerationProvider {
  readonly name: string;
  generate(request: GenerationRequest): Promise<string>;
}

export interface GenerateBoundedOptions {
  provider: GenerationProvider;
  system: string;
  input: string;
  model: string;
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export class GenerationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationLimitError';
  }
}

export class GenerationTimeoutError extends Error {
  constructor() {
    super('Generation request timed out');
    this.name = 'GenerationTimeoutError';
  }
}

/** Enforce byte and time bounds independently of a provider implementation. */
export async function generateBounded(options: GenerateBoundedOptions): Promise<string> {
  const inputBytes = Buffer.byteLength(options.system, 'utf8') + Buffer.byteLength(options.input, 'utf8');
  if (inputBytes > options.maxInputBytes) {
    throw new GenerationLimitError('Generation input exceeds the configured byte limit');
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error('Generation timeout must be a positive integer');
  }
  if (options.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');

  const controller = new AbortController();
  let timeout: NodeJS.Timeout;
  let onAbort: () => void;
  const boundary = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new GenerationTimeoutError());
    }, options.timeoutMs);
    onAbort = () => {
      controller.abort();
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    const output = await Promise.race([
      options.provider.generate({
        system: options.system,
        input: options.input,
        model: options.model,
        maxOutputBytes: options.maxOutputBytes,
        signal: controller.signal,
      }),
      boundary,
    ]);
    if (typeof output !== 'string') throw new Error('Generation provider returned a non-string output');
    if (Buffer.byteLength(output, 'utf8') > options.maxOutputBytes) {
      throw new GenerationLimitError('Generation output exceeds the configured byte limit');
    }
    return output;
  } finally {
    clearTimeout(timeout!);
    options.signal?.removeEventListener('abort', onAbort!);
  }
}

export interface HttpJsonGenerationProviderOptions {
  name: string;
  endpoint: string;
  apiKey?: string;
}

/**
 * Explicit opt-in adapter for a provider gateway. The gateway contract is
 * POST {model, system, input, max_output_bytes} -> {output: string}. It is not
 * selected from embedding credentials or any provider-specific environment.
 */
export class HttpJsonGenerationProvider implements GenerationProvider {
  readonly name: string;
  private readonly endpoint: string;
  private readonly apiKey?: string;

  constructor(options: HttpJsonGenerationProviderOptions) {
    this.name = options.name;
    this.endpoint = new URL(options.endpoint).toString();
    this.apiKey = options.apiKey;
  }

  async generate(request: GenerationRequest): Promise<string> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      signal: request.signal,
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: request.model,
        system: request.system,
        input: request.input,
        max_output_bytes: request.maxOutputBytes,
        tools: [],
      }),
    });
    if (!response.ok) throw new Error(`Generation provider request failed with status ${response.status}`);

    // Allow a small envelope overhead, while bounding reads before decoding.
    const body = await readResponseBodyBounded(response, request.maxOutputBytes + 1024);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('Generation provider returned invalid JSON');
    }
    if (!isExactOutputEnvelope(parsed)) {
      throw new Error('Generation provider returned an invalid output envelope');
    }
    return parsed.output;
  }
}

async function readResponseBodyBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new GenerationLimitError('Generation response exceeds the configured byte limit');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Generation provider returned invalid UTF-8');
    throw error;
  }
}

function isExactOutputEnvelope(value: unknown): value is { output: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && typeof record.output === 'string';
}
