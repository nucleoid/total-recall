import { randomUUID } from 'node:crypto';
import { getConnectorCredentials, setConnectorCredentials } from '../../media.js';

const PLEX_TV = 'https://plex.tv';
const PIN_POLL_INTERVAL_MS = 2000;
const PIN_POLL_TIMEOUT_MS = 25 * 60 * 1000;     // PINs expire after 30 min

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

interface PinResponse {
  id: number;
  code: string;
  authToken: string | null;
  expiresAt: string;
}

async function createPin(clientIdentifier: string): Promise<PinResponse> {
  const res = await fetch(`${PLEX_TV}/api/v2/pins?strong=true`, {
    method: 'POST',
    headers: clientHeaders(clientIdentifier),
  });
  if (!res.ok) {
    throw new Error(`Plex pin create failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<PinResponse>;
}

async function pollPin(pinId: number, clientIdentifier: string): Promise<string> {
  const deadline = Date.now() + PIN_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${PLEX_TV}/api/v2/pins/${pinId}`, {
      headers: clientHeaders(clientIdentifier),
    });
    if (res.ok) {
      const body = await res.json() as PinResponse;
      if (body.authToken) return body.authToken;
    }
    await new Promise((r) => setTimeout(r, PIN_POLL_INTERVAL_MS));
  }
  throw new Error('Plex PIN expired without being claimed.');
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
  const link = `https://plex.tv/link?code=${pin.code}`;
  prompt(link, pin.code);

  const authToken = await pollPin(pin.id, clientIdentifier);
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
