const TAB_KEY = 'total-recall.dashboard.api-key';
let apiKey = '';
let rememberForTab = false;

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 25_000;

export function toApiDateTime(value: string): string {
  return new Date(value).toISOString();
}

export function restoreKey(): string {
  apiKey = sessionStorage.getItem(TAB_KEY) ?? '';
  rememberForTab = apiKey.length > 0;
  return apiKey;
}

export function setKey(key: string, remember: boolean): void {
  apiKey = key.trim();
  rememberForTab = remember;
  if (remember && apiKey) sessionStorage.setItem(TAB_KEY, apiKey);
  else sessionStorage.removeItem(TAB_KEY);
}

export function clearKey(): void {
  apiKey = '';
  rememberForTab = false;
  sessionStorage.removeItem(TAB_KEY);
}

export function hasKey(): boolean {
  return apiKey.length > 0;
}

export function isRemembered(): boolean {
  return rememberForTab;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!path.startsWith('/api/')) throw new Error('Dashboard API requests must use same-origin /api/* paths');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${apiKey}`);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort(init.signal?.reason);
  init.signal?.addEventListener('abort', abort, { once: true });
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: 'same-origin', signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !init.signal?.aborted) {
      throw new ApiError(408, 'This request took too long. Try again or narrow the filters.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abort);
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // The status is still safe and useful when an upstream returned non-JSON.
    }
    if (response.status === 524) message = 'The edge timed out waiting for Total Recall. Try again or narrow the filters.';
    if (response.status === 401 || response.status === 403) clearKey();
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}
