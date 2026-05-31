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
      const baseUri = await pickReachableUri(server, creds);
      if (!baseUri) {
        console.warn(`[plex] no reachable connection for server "${server.name}", skipping`);
        continue;
      }

      const url = new URL(`${baseUri}/status/sessions/history/all`);
      url.searchParams.set('accountID', String(account.id));
      url.searchParams.set('sort', 'viewedAt:asc');
      if (sinceEpoch !== null) {
        url.searchParams.set('viewedAt>=', String(sinceEpoch));
      }

      const res = await fetch(url, { headers: plexHeaders(creds) });
      if (!res.ok) {
        console.warn(`[plex] history fetch failed on "${server.name}": ${res.status} ${await res.text().catch(() => '')}`);
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
