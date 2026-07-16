import {
  BaseConnector,
  filterValidMediaEventDates,
  trustConnectorMediaEvents,
  type ConnectorContext,
  type SyncResult,
} from '../base.js';
import {
  mutateConnectorSyncStateWithClient,
  upsertMediaEventsWithClient,
  type ConnectorSyncState,
  type MediaEventInput,
} from '../../media.js';
import { withScopedClient } from '../../db.js';
import { lockConnectorState } from '../state.js';
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
const PLEX_CURSOR_VERSION = 1;

export interface PlexCursorMetadata {
  cursor_version: 1;
  server_cursors: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseCursorDate(value: unknown, now = Date.now()): Date | null {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  if (date.getTime() > now) return null;
  return date;
}

export function parsePlexCursorMetadata(
  metadata: Record<string, unknown> | null | undefined,
  warn: (message: string) => void = () => undefined
): Record<string, Date> {
  const plex = metadata?.plex;
  if (plex === undefined) return {};
  if (!isRecord(plex)) {
    warn('[plex] ignoring malformed cursor metadata: metadata.plex is not an object');
    return {};
  }
  if (plex.cursor_version !== PLEX_CURSOR_VERSION) {
    warn(`[plex] ignoring unsupported cursor metadata version: ${String(plex.cursor_version)}`);
    return {};
  }
  if (!isRecord(plex.server_cursors)) {
    warn('[plex] ignoring malformed cursor metadata: server_cursors is not an object');
    return {};
  }

  const parsed: Record<string, Date> = {};
  for (const [serverId, value] of Object.entries(plex.server_cursors)) {
    if (serverId.trim() === '') {
      warn('[plex] ignoring cursor metadata entry with empty server id');
      continue;
    }
    const date = parseCursorDate(value);
    if (!date) {
      warn(`[plex] ignoring malformed cursor metadata entry for server "${serverId}"`);
      continue;
    }
    parsed[serverId] = date;
  }
  return parsed;
}

export function mergePlexCursorMetadata(
  metadata: Record<string, unknown> | null | undefined,
  candidates: Record<string, string>
): Record<string, unknown> {
  const existing = parsePlexCursorMetadata(metadata);
  for (const [serverId, iso] of Object.entries(candidates)) {
    const candidate = parseCursorDate(iso, Number.POSITIVE_INFINITY);
    if (!candidate) continue;
    const previous = existing[serverId];
    if (!previous || candidate > previous) {
      existing[serverId] = candidate;
    }
  }

  const server_cursors = Object.fromEntries(
    Object.entries(existing).map(([serverId, date]) => [serverId, date.toISOString()])
  );

  return {
    ...(metadata ?? {}),
    plex: {
      cursor_version: PLEX_CURSOR_VERSION,
      server_cursors,
    } satisfies PlexCursorMetadata,
  };
}

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

export interface PlexServerHistoryResult {
  events: MediaEventInput[];
  scannedThrough: Date | null;
}

export async function fetchHistoryForServer(args: {
  server: PlexResource;
  creds: Awaited<ReturnType<typeof loadCreds>>;
  account: { id: number };
  since: Date | null;
  deps?: PlexHistoryFetchDeps;
}): Promise<PlexServerHistoryResult> {
  const { server, creds, account, since, deps = {} } = args;
  const warn = deps.warn ?? console.warn;
  const reachable = await (deps.pickReachableUri ?? pickReachableUri)(server, creds);
  if (!reachable) {
    throw new Error(`Plex no reachable connection for server "${server.name}"`);
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
  let scannedThrough: Date | null = null;
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

    let body: {
      MediaContainer?: {
        Metadata?: PlexHistoryItem[];
        totalSize?: unknown;
      };
    };
    try {
      body = await res.json() as typeof body;
    } catch {
      throw new Error(`Plex history fetch failed on server "${server.name}": invalid JSON`);
    }
    const container = body.MediaContainer;
    if (!isRecord(container)) {
      throw new Error(`Plex history fetch failed on server "${server.name}": invalid MediaContainer`);
    }
    if (container.Metadata !== undefined && !Array.isArray(container.Metadata)) {
      throw new Error(`Plex history fetch failed on server "${server.name}": invalid Metadata page`);
    }
    const items = (container.Metadata ?? []) as PlexHistoryItem[];
    seenHistoryRows += items.length;
    for (const item of items) {
      if (
        typeof item.viewedAt !== 'number' ||
        !Number.isSafeInteger(item.viewedAt) ||
        item.viewedAt <= 0
      ) {
        throw new Error(`Plex history fetch failed on server "${server.name}": invalid viewedAt`);
      }
      const viewedAt = new Date(item.viewedAt * 1000);
      if (!Number.isFinite(viewedAt.getTime())) {
        throw new Error(`Plex history fetch failed on server "${server.name}": invalid viewedAt`);
      }
      if (viewedAt.getTime() > Date.now()) {
        throw new Error(`Plex history fetch failed on server "${server.name}": future viewedAt`);
      }
      if (!scannedThrough || viewedAt > scannedThrough) {
        scannedThrough = viewedAt;
      }

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

    let totalSize: number | null = null;
    if (container.totalSize !== undefined) {
      if (
        typeof container.totalSize !== 'number' ||
        !Number.isSafeInteger(container.totalSize) ||
        container.totalSize < 0
      ) {
        throw new Error(`Plex history fetch failed on server "${server.name}": invalid totalSize`);
      }
      totalSize = container.totalSize;
    }
    start += items.length;
    pages++;

    if (items.length === 0 && totalSize !== null && start < totalSize) {
      throw new Error(`Plex history pagination did not advance on server "${server.name}"`);
    }

    const done = items.length === 0 ||
      (totalSize !== null ? start >= totalSize : items.length < pageSize);
    if (done) {
      break;
    }
    if (pages >= maxPages) {
      throw new Error(`Plex history pagination hit ${maxPages} page cap on server "${server.name}"`);
    }
  }

  if (!server.owned && seenHistoryRows > 0 && matchedAccountRows === 0) {
    warn(
      `[plex] shared server "${server.name}" returned history rows but none matched expected accountID ${expectedAccountId}`
    );
  }

  return { events, scannedThrough };
}

export async function fetchHistoryForServers(args: {
  servers: PlexResource[];
  creds: Awaited<ReturnType<typeof loadCreds>>;
  account: { id: number };
  since: Date | null;
  sinceByServer?: Record<string, Date | null | undefined>;
  throwOnServerErrors?: boolean;
  deps?: PlexHistoryFetchDeps;
}): Promise<{
  events: MediaEventInput[];
  errors: string[];
  cursorCandidates: Record<string, string>;
  successfulServers: string[];
}> {
  const events: MediaEventInput[] = [];
  const errors: string[] = [];
  const cursorCandidates: Record<string, string> = {};
  const successfulServers: string[] = [];

  for (const server of args.servers) {
    try {
      const serverHistory = await fetchHistoryForServer({
        ...args,
        server,
        since: args.sinceByServer?.[server.clientIdentifier] ?? args.since,
      });
      successfulServers.push(server.clientIdentifier);
      events.push(...serverHistory.events);
      if (serverHistory.scannedThrough) {
        cursorCandidates[server.clientIdentifier] = serverHistory.scannedThrough.toISOString();
      }
    } catch (err: any) {
      errors.push(err?.message ?? String(err));
    }
  }

  if (args.throwOnServerErrors && errors.length > 0) {
    throw new Error(`Plex history fetch failed for ${errors.length} server(s): ${errors.join('; ')}`);
  }

  return { events, errors, cursorCandidates, successfulServers };
}

export class PlexConnector extends BaseConnector {
  readonly service = 'plex';

  protected async fetchSince(since: Date | null, _ctx: ConnectorContext): Promise<{
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

  async sync(ctx: ConnectorContext): Promise<SyncResult> {
    const start = Date.now();
    const errors: string[] = [];
    const warnings: string[] = [];
    let ingested = 0;
    let skipped = 0;

    try {
      await withScopedClient(ctx.scope, async (client) => {
        const state = await lockConnectorState(client, ctx.scope, this.service, 'default', 'media');
        const sinceByServer = parsePlexCursorMetadata(state.metadata, (message) => warnings.push(message));
        const creds = await loadCreds();
        const account = await getAccount(creds);
        const servers = await listServers(creds);
        if (servers.length === 0) throw new Error('No accessible Plex servers found for this account.');

        const fetchResult = await fetchHistoryForServers({
          servers,
          creds,
          account,
          since: null,
          sinceByServer,
          throwOnServerErrors: false,
        });
        errors.push(...fetchResult.errors);
        if (fetchResult.successfulServers.length === 0 && fetchResult.errors.length > 0) {
          throw new Error('No Plex source completed successfully');
        }

        const valid = filterValidMediaEventDates(fetchResult.events);
        errors.push(...valid.errors);
        skipped += valid.skipped;
        const enriched = trustConnectorMediaEvents(valid.events, ctx);
        const result = await upsertMediaEventsWithClient(client, enriched, ctx.scope);
        ingested = result.inserted;
        skipped += result.skipped;

        await mutateConnectorSyncStateWithClient(client, this.service, (current: ConnectorSyncState) => ({
          last_sync_at: new Date(),
          metadata: mergePlexCursorMetadata(current.metadata, fetchResult.cursorCandidates),
        }));
      });
    } catch (err: any) {
      errors.push(err?.message ?? String(err));
    }

    return {
      service: this.service,
      events_ingested: ingested,
      events_skipped: skipped,
      warnings,
      errors,
      duration_ms: Date.now() - start,
    };
  }
}
