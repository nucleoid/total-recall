import { plexHeaders, saveCreds, type PlexCreds } from './auth.js';

const PLEX_TV = 'https://plex.tv';
const CONNECT_TIMEOUT_MS = 4000;

interface PlexUserResponse {
  id: unknown;
  uuid: unknown;
  username: unknown;
  email?: string;
}

export interface PlexConnection {
  protocol: 'http' | 'https';
  address: string;
  port: number;
  uri: string;
  local: boolean;
  relay: boolean;
}

export interface PlexResource {
  name: string;
  clientIdentifier: string;
  owned: boolean;
  provides: string;             // "server,player" etc; we want anything that includes "server"
  publicAddressMatches: boolean;
  /** Per-resource access token. Required for shared (non-owned) servers. */
  accessToken?: string;
  connections: PlexConnection[];
}

function parsePositiveSafeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseConnection(value: unknown): PlexConnection | null {
  if (!isRecord(value)) return null;
  if (value.protocol !== 'http' && value.protocol !== 'https') return null;
  if (typeof value.address !== 'string' || value.address.trim() === '') return null;
  const port = parsePositiveSafeInteger(value.port);
  if (port === null) return null;
  if (typeof value.uri !== 'string' || value.uri.trim() === '') return null;
  if (value.local !== undefined && typeof value.local !== 'boolean') return null;
  if (value.relay !== undefined && typeof value.relay !== 'boolean') return null;

  return {
    protocol: value.protocol,
    address: value.address,
    port,
    uri: value.uri,
    local: value.local ?? false,
    relay: value.relay ?? false,
  };
}

function parseResource(value: unknown): PlexResource | null {
  if (!isRecord(value)) return null;
  if (typeof value.provides !== 'string' || !value.provides.split(',').includes('server')) {
    return null;
  }
  if (typeof value.clientIdentifier !== 'string' || value.clientIdentifier.trim() === '') {
    return null;
  }
  if (typeof value.name !== 'string' || value.name.trim() === '') {
    return null;
  }
  if (typeof value.owned !== 'boolean') {
    return null;
  }
  if (!Array.isArray(value.connections)) {
    return null;
  }
  const connections = value.connections
    .map(parseConnection)
    .filter((conn): conn is PlexConnection => conn !== null);
  if (connections.length === 0) {
    return null;
  }
  if (value.accessToken !== undefined && typeof value.accessToken !== 'string') {
    return null;
  }

  return {
    name: value.name,
    clientIdentifier: value.clientIdentifier,
    owned: value.owned,
    provides: value.provides,
    publicAddressMatches: typeof value.publicAddressMatches === 'boolean'
      ? value.publicAddressMatches
      : false,
    accessToken: value.accessToken,
    connections,
  };
}

/**
 * Returns Plex.tv account info. Caches the uuid + numeric id on the stored
 * creds so subsequent syncs don't re-fetch.
 */
export async function getAccount(creds: PlexCreds): Promise<{
  id: number; uuid: string; username: string;
}> {
  if (creds.account_id && creds.account_uuid) {
    const cachedId = parsePositiveSafeInteger(creds.account_id);
    if (cachedId === null) {
      throw new Error(`invalid cached Plex account_id: ${creds.account_id}`);
    }
    return { id: cachedId, uuid: creds.account_uuid, username: '' };
  }
  const res = await fetch(`${PLEX_TV}/api/v2/user`, { headers: plexHeaders(creds) });
  if (!res.ok) {
    throw new Error(`Plex /api/v2/user failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as PlexUserResponse;
  const id = parsePositiveSafeInteger(body.id);
  if (id === null) {
    throw new Error('Plex /api/v2/user returned invalid account id');
  }
  if (typeof body.uuid !== 'string' || body.uuid.trim() === '') {
    throw new Error('Plex /api/v2/user returned invalid account uuid');
  }
  const username = typeof body.username === 'string' ? body.username : '';
  const next: PlexCreds = { ...creds, account_id: String(id), account_uuid: body.uuid };
  await saveCreds(next);
  Object.assign(creds, next);
  return { id, uuid: body.uuid, username };
}

/**
 * Returns every server-typed resource the user has access to (owned or
 * shared), filtered to those with at least one connection.
 */
export async function listServers(creds: PlexCreds): Promise<PlexResource[]> {
  const res = await fetch(`${PLEX_TV}/api/v2/resources?includeHttps=1&includeRelay=1`, {
    headers: plexHeaders(creds),
  });
  if (!res.ok) {
    throw new Error(`Plex /api/v2/resources failed: ${res.status} ${await res.text()}`);
  }
  const all = await res.json() as unknown;
  if (!Array.isArray(all)) {
    throw new Error('Plex /api/v2/resources returned invalid resource list');
  }
  const resources: PlexResource[] = [];
  for (const raw of all) {
    const parsed = parseResource(raw);
    if (parsed) {
      resources.push(parsed);
    } else {
      const label = isRecord(raw) && typeof raw.name === 'string' ? raw.name : '(unknown)';
      console.warn(`[plex] skipping malformed resource "${label}"`);
    }
  }
  return resources;
}

async function tryConnection(uri: string, headers: Record<string, string>): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CONNECT_TIMEOUT_MS);
  try {
    const res = await fetch(uri, { headers, signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Picks the first reachable connection for a server. Prefers local LAN
 * connections (lowest latency), then public direct, then relay as a
 * fallback for friend-server scenarios behind NAT.
 *
 * Uses the resource's per-server `accessToken` when present (required for
 * shared/non-owned servers) instead of the plex.tv user token.
 */
export async function pickReachableUri(
  resource: PlexResource,
  creds: PlexCreds
): Promise<{ uri: string; token: string } | null> {
  const token = resource.accessToken || creds.auth_token;
  const headers = { ...plexHeaders(creds), 'X-Plex-Token': token };
  const sorted = [...resource.connections].sort((a, b) => {
    const score = (c: PlexConnection) =>
      (c.local ? 0 : 1) + (c.relay ? 2 : 0) + (c.protocol === 'https' ? 0 : 0.5);
    return score(a) - score(b);
  });
  for (const conn of sorted) {
    if (await tryConnection(`${conn.uri}/identity`, headers)) {
      return { uri: conn.uri, token };
    }
  }
  return null;
}
