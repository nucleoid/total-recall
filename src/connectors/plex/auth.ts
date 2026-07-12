import { randomUUID } from 'node:crypto';
import { getConnectorCredentials, setConnectorCredentials } from '../../media.js';

const PLEX_TV = 'https://plex.tv';
const PIN_POLL_INTERVAL_MS = 2000;
const PIN_EXPIRED_ERROR = 'Plex PIN expired without being claimed.';

export interface PlexCreds {
  client_identifier: string;
  auth_token: string;
  account_id?: string;                          // populated lazily on first use
  account_uuid?: string;
}

const PLEX_PRODUCT = 'total-recall';
const PLEX_VERSION = '1.0';
const PLEX_DEVICE = 'total-recall-connector';
const PLEX_PLATFORM = 'nodejs';

function clientHeaders(clientIdentifier: string): Record<string, string> {
  return {
    'X-Plex-Client-Identifier': clientIdentifier,
    'X-Plex-Product': PLEX_PRODUCT,
    'X-Plex-Version': PLEX_VERSION,
    'X-Plex-Device': PLEX_DEVICE,
    'X-Plex-Platform': PLEX_PLATFORM,
    Accept: 'application/json',
  };
}

export function plexHeaders(creds: PlexCreds): Record<string, string> {
  return {
    ...clientHeaders(creds.client_identifier),
    'X-Plex-Token': creds.auth_token,
  };
}

export interface PinResponse {
  id: number;
  code: string;
  authToken: string | null;
  expiresAt: string;
}

export interface PollPinDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetch: typeof fetch;
}

const defaultPollPinDeps: PollPinDeps = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetch: (input, init) => globalThis.fetch(input, init),
};

async function createPin(clientIdentifier: string): Promise<PinResponse> {
  // strong=false returns the short 4-character code that plex.tv/link expects.
  // strong=true returns a long redirect-only code that the manual flow can't use.
  const res = await fetch(`${PLEX_TV}/api/v2/pins?strong=false`, {
    method: 'POST',
    headers: clientHeaders(clientIdentifier),
  });
  if (!res.ok) {
    throw new Error(`Plex pin create failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<PinResponse>;
}

export async function pollPin(
  pin: PinResponse,
  clientIdentifier: string,
  deps: PollPinDeps = defaultPollPinDeps,
): Promise<string> {
  const deadline = Date.parse(pin.expiresAt);
  if (!Number.isFinite(deadline) || deadline <= deps.now()) {
    throw new Error(PIN_EXPIRED_ERROR);
  }

  while (deps.now() < deadline) {
    let res: Response;
    try {
      res = await deps.fetch(`${PLEX_TV}/api/v2/pins/${pin.id}`, {
        headers: clientHeaders(clientIdentifier),
      });
    } catch {
      const remainingMs = deadline - deps.now();
      if (remainingMs <= 0) break;
      await deps.sleep(Math.min(PIN_POLL_INTERVAL_MS, remainingMs));
      continue;
    }

    if (res.ok) {
      const body = await res.json() as PinResponse;
      if (typeof body.authToken === 'string' && body.authToken.length > 0) {
        return body.authToken;
      }
    } else if (res.status === 404) {
      throw new Error('Plex PIN expired or was deleted.');
    } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new Error(`Plex PIN poll failed with status ${res.status}.`);
    }

    const remainingMs = deadline - deps.now();
    if (remainingMs <= 0) break;
    const requestedDelayMs = res.status === 429
      ? retryAfterMs(res.headers.get('Retry-After'), deps.now()) ?? PIN_POLL_INTERVAL_MS
      : PIN_POLL_INTERVAL_MS;
    const effectiveDelayMs = requestedDelayMs > 0 ? requestedDelayMs : PIN_POLL_INTERVAL_MS;
    const boundedDelayMs = Math.min(effectiveDelayMs, remainingMs);
    await deps.sleep(boundedDelayMs);
  }
  throw new Error(PIN_EXPIRED_ERROR);
}

function retryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null) return null;

  const deltaSeconds = Number(value);
  if (Number.isFinite(deltaSeconds) && deltaSeconds >= 0) {
    return deltaSeconds * 1000;
  }

  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}

/**
 * Runs the full PIN flow: generate a client_identifier (or reuse the stored
 * one), create a PIN, hand the user the link+code, poll until they enter
 * it on plex.tv/link, then persist {client_identifier, auth_token}.
 */
export async function pinFlow(prompt: (link: string, code: string) => void): Promise<PlexCreds> {
  const existing = await getConnectorCredentials('plex') as PlexCreds | null;
  const clientIdentifier = existing?.client_identifier ?? randomUUID();

  const pin = await createPin(clientIdentifier);
  // Hand the user the bare /link URL — they enter the 4-character code on
  // that page. Pre-filling via `?code=` only works for `strong=true` PINs.
  const link = 'https://plex.tv/link';
  prompt(link, pin.code);

  const authToken = await pollPin(pin, clientIdentifier);
  const creds: PlexCreds = { client_identifier: clientIdentifier, auth_token: authToken };
  await setConnectorCredentials('plex', creds as unknown as Record<string, unknown>);
  return creds;
}

export async function loadCreds(): Promise<PlexCreds> {
  const stored = await getConnectorCredentials('plex') as PlexCreds | null;
  if (!stored?.auth_token) {
    throw new Error('No Plex credentials. Run scripts/plex-auth.ts first.');
  }
  return stored;
}

export async function saveCreds(creds: PlexCreds): Promise<void> {
  await setConnectorCredentials('plex', creds as unknown as Record<string, unknown>);
}
