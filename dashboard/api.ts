const TAB_KEY = 'total-recall.dashboard.api-key';
let apiKey = '';
let rememberForTab = false;

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

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
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // The status is still safe and useful when an upstream returned non-JSON.
    }
    if (response.status === 401 || response.status === 403) clearKey();
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}
