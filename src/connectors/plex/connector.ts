import { BaseConnector } from '../base.js';
import type { MediaEventInput } from '../../media.js';
import { loadCreds, plexHeaders } from './auth.js';
import { getAccount, listServers, pickReachableUri } from './discovery.js';
import { toMediaEvent, type PlexHistoryItem } from './transform.js';

export class PlexConnector extends BaseConnector {
  readonly service = 'plex';

  protected async fetchSince(since: Date | null): Promise<{
    events: MediaEventInput[];
    cursor?: string;
  }> {
    const creds = await loadCreds();
    const account = await getAccount(creds);
    const servers = await listServers(creds);

    if (servers.length === 0) {
      throw new Error('No accessible Plex servers found for this account.');
    }

    const sinceEpoch = since ? Math.floor(since.getTime() / 1000) : null;
    const events: MediaEventInput[] = [];

    for (const server of servers) {
      const reachable = await pickReachableUri(server, creds);
      if (!reachable) {
        console.warn(`[plex] no reachable connection for server "${server.name}", skipping`);
        continue;
      }
      const { uri: baseUri, token: serverToken } = reachable;
      const headers = { ...plexHeaders(creds), 'X-Plex-Token': serverToken };

      // /status/sessions/history/all is server-admin only and 401s on
      // friend-shared servers. The unsuffixed endpoint returns the
      // calling user's own history and works for both owned and shared.
      const tryEndpoints = [
        `${baseUri}/status/sessions/history`,
        `${baseUri}/status/sessions/history/all`,
      ];

      let res: Response | null = null;
      for (const endpoint of tryEndpoints) {
        const url = new URL(endpoint);
        url.searchParams.set('accountID', String(account.id));
        url.searchParams.set('sort', 'viewedAt:asc');
        if (sinceEpoch !== null) {
          url.searchParams.set('viewedAt>=', String(sinceEpoch));
        }
        const r = await fetch(url, { headers });
        if (r.ok) { res = r; break; }
        if (r.status !== 401 && r.status !== 404) {
          console.warn(`[plex] history fetch failed on "${server.name}" (${url.pathname}): ${r.status} ${await r.text().catch(() => '')}`);
          break;
        }
      }
      if (!res) {
        console.warn(`[plex] no history endpoint accepted on "${server.name}"`);
        continue;
      }

      const body = await res.json() as { MediaContainer?: { Metadata?: PlexHistoryItem[] } };
      const items = body.MediaContainer?.Metadata ?? [];
      for (const item of items) {
        if (item.accountID !== account.id) continue;            // belt + braces
        const event = toMediaEvent(item, {
          name: server.name,
          clientIdentifier: server.clientIdentifier,
        });
        if (event) events.push(event);
      }
    }

    return { events };
  }
}
