import { plexHeaders, saveCreds, type PlexCreds } from './auth.js';

const PLEX_TV = 'https://plex.tv';
const CONNECT_TIMEOUT_MS = 4000;

interface PlexUserResponse {
  id: number;
  uuid: string;
  username: string;
  email?: string;
}

interface PlexConnection {
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

/**
 * Returns Plex.tv account info. Caches the uuid + numeric id on the stored
 * creds so subsequent syncs don't re-fetch.
 */
export async function getAccount(creds: PlexCreds): Promise<{
  id: number; uuid: string; username: string;
}> {
  if (creds.account_id && creds.account_uuid) {
    return { id: parseInt(creds.account_id, 10), uuid: creds.account_uuid, username: '' };
  }
  const res = await fetch(`${PLEX_TV}/api/v2/user`, { headers: plexHeaders(creds) });
  if (!res.ok) {
    throw new Error(`Plex /api/v2/user failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as PlexUserResponse;
  const next: PlexCreds = { ...creds, account_id: String(body.id), account_uuid: body.uuid };
  await saveCreds(next);
  Object.assign(creds, next);
  return { id: body.id, uuid: body.uuid, username: body.username };
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
  const all = await res.json() as PlexResource[];
  return all.filter((r) => r.provides?.split(',').includes('server') && r.connections?.length > 0);
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
