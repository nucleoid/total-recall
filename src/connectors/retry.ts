export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  shouldRetry?: (error: unknown) => boolean;
  retryAfterMs?: (error: unknown) => number | null;
}

export class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter: string | null = null,
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

export function retryAfterMilliseconds(value: string | null | undefined, now = Date.now()): number | null {
  if (value == null || value.trim() === '') return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    return Math.max(0, Number(value) * 1000);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function isTransientConnectorError(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return error.status === 429 || error.status === 408 || error.status >= 500;
  }
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' || error.name === 'TimeoutError';
}

export async function retryConnectorOperation<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 15_000;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;
  const shouldRetry = options.shouldRetry ?? isTransientConnectorError;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('maxAttempts must be an integer from 1 to 10');
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(options.signal);
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !shouldRetry(error)) throw error;
      const explicit = options.retryAfterMs?.(error) ??
        (error instanceof HttpStatusError ? retryAfterMilliseconds(error.retryAfter) : null);
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.min(maxDelayMs, explicit ?? Math.floor(exponential * (0.5 + random())));
      await sleep(delay, options.signal);
    }
  }
  throw lastError;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Connector operation aborted'));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Connector operation aborted');
  }
}
