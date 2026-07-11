import { BaseConnector } from '../base.js';
import type { MediaEventInput } from '../../media.js';
import { loadCreds, plexHeaders } from './auth.js';
import { getAccount, listServers, pickReachableUri, type PlexResource } from './discovery.js';
import { toMediaEvent, type PlexHistoryItem } from './transform.js';

export interface PlexHistoryFetchDeps {
  pickReachableUri?: typeof pickReachableUri;
  fetch?: typeof fetch;
  warn?: (message: string) => void;
  historyPageSize?: number;
  maxHistoryPages?: number;
}

const DEFAULT_HISTORY_PAGE_SIZE = 100;
const DEFAULT_MAX_HISTORY_PAGES = 1000;

export function historyAccountId(
  server: Pick<PlexResource, 'owned'>,
  account: { id: number }
): number {
  return server.owned === true ? 1 : account.id;
}

export function normalizePlexAccountId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function fetchHistoryForServer(args: {
  server: PlexResource;
  creds: Awaited<ReturnType<typeof loadCreds>>;
  account: { id: number };
  since: Date | null;
  deps?: PlexHistoryFetchDeps;
}): Promise<MediaEventInput[]> {
  const { server, creds, account, since, deps = {} } = args;
  const warn = deps.warn ?? console.warn;
  const reachable = await (deps.pickReachableUri ?? pickReachableUri)(server, creds);
  if (!reachable) {
    warn(`[plex] no reachable connection for server "${server.name}", skipping`);
    return [];
  }

  const expectedAccountId = historyAccountId(server, account);
  const { uri: baseUri, token: serverToken } = reachable;
  const headers = { ...plexHeaders(creds), 'X-Plex-Token': serverToken };

  // /status/sessions/history/all is server-admin only and 401s on
  // friend-shared servers. The unsuffixed endpoint returns the
  // calling user's own history and works for both owned and shared.
  const tryEndpoints = [
    `${baseUri}/status/sessions/history`,
    `${baseUri}/status/sessions/history/all`,
  ];

  const sinceEpoch = since ? Math.floor(since.getTime() / 1000) : null;
  const fetchImpl = deps.fetch ?? fetch;
  const pageSize = deps.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
  const maxPages = deps.maxHistoryPages ?? DEFAULT_MAX_HISTORY_PAGES;
  const events: MediaEventInput[] = [];
  let start = 0;
  let pages = 0;
  let seenHistoryRows = 0;
  let matchedAccountRows = 0;

  while (true) {
    let res: Response | null = null;

    for (const endpoint of tryEndpoints) {
      const url = new URL(endpoint);
      url.searchParams.set('accountID', String(expectedAccountId));
      url.searchParams.set('sort', 'viewedAt:asc');
      url.searchParams.set('X-Plex-Container-Start', String(start));
      url.searchParams.set('X-Plex-Container-Size', String(pageSize));
      if (sinceEpoch !== null) {
        url.searchParams.set('viewedAt>=', String(sinceEpoch));
      }
      const r = await fetchImpl(url, { headers });
      if (r.ok) { res = r; break; }
      if (r.status !== 401 && r.status !== 404) {
        throw new Error(
          `Plex history fetch failed on server "${server.name}" (${url.pathname}): ${r.status}`
        );
      }
    }

    if (!res) {
      throw new Error(`Plex no history endpoint accepted on server "${server.name}"`);
    }

    const body = await res.json() as {
      MediaContainer?: {
        Metadata?: PlexHistoryItem[];
        totalSize?: unknown;
      };
    };
    const container = body.MediaContainer;
    const items = container?.Metadata ?? [];
    seenHistoryRows += items.length;
    for (const item of items) {
      const itemAccountId = normalizePlexAccountId(item.accountID);
      if (itemAccountId === null) {
        warn(`[plex] skipping history item with malformed accountID on server "${server.name}"`);
        continue;
      }
      if (itemAccountId !== expectedAccountId) continue;
      matchedAccountRows++;
      const event = toMediaEvent(item, {
        name: server.name,
        clientIdentifier: server.clientIdentifier,
      });
      if (event) events.push(event);
    }

    const totalSize = typeof container?.totalSize === 'number' && Number.isSafeInteger(container.totalSize)
      ? container.totalSize
      : null;
    start += items.length;
    pages++;

    const done = items.length === 0 ||
      (totalSize !== null ? start >= totalSize : items.length < pageSize);
    if (done) {
      break;
    }
    if (pages >= maxPages) {
      warn(`[plex] history pagination hit ${maxPages} page cap on server "${server.name}"`);
      break;
    }
  }

  if (!server.owned && seenHistoryRows > 0 && matchedAccountRows === 0) {
    warn(
      `[plex] shared server "${server.name}" returned history rows but none matched expected accountID ${expectedAccountId}`
    );
  }

  return events;
}

export async function fetchHistoryForServers(args: {
  servers: PlexResource[];
  creds: Awaited<ReturnType<typeof loadCreds>>;
  account: { id: number };
  since: Date | null;
  throwOnServerErrors?: boolean;
  deps?: PlexHistoryFetchDeps;
}): Promise<{ events: MediaEventInput[]; errors: string[] }> {
  const events: MediaEventInput[] = [];
  const errors: string[] = [];

  for (const server of args.servers) {
    try {
      events.push(...await fetchHistoryForServer({ ...args, server }));
    } catch (err: any) {
      errors.push(err?.message ?? String(err));
    }
  }

  if (args.throwOnServerErrors && errors.length > 0) {
    throw new Error(`Plex history fetch failed for ${errors.length} server(s): ${errors.join('; ')}`);
  }

  return { events, errors };
}

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

    const { events, errors } = await fetchHistoryForServers({
      servers,
      creds,
      account,
      since,
      throwOnServerErrors: true,
    });
    for (const error of errors) {
      console.warn(`[plex] ${error}`);
    }

    return { events };
  }
}
