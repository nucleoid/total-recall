import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { getDomain } from 'tldts';

import { upsertActivityEventsWithClient, type TrustedActivityEventInput } from '../../activity.js';
import type { ConnectorContext, SourceConnectorDefinition } from '../base.js';
import type {
  ConnectorPage,
  ConnectorPagePersistence,
  ConnectorSource,
  ConnectorStoredState,
} from '../types.js';

export type BrowserFamily = 'chromium' | 'firefox';

export interface BrowserConnectorOptions {
  browser: BrowserFamily;
  profilePath: string;
  databasePath?: string;
  sourceKey?: string;
  fullPath?: boolean;
  pageSize?: number;
  since?: Date;
  python?: string;
  runHelper?: BrowserHelperRunner;
  now?: () => Date;
}

export interface BrowserVisitRow {
  id: number;
  /** Decimal SQLite microsecond value; Chromium exceeds JS safe integers. */
  cursor_time: string;
  visited_at: string;
  url: string;
  title: string;
}

export type BrowserHelperRunner = (
  args: string[],
  signal: AbortSignal,
) => Promise<{ visits: BrowserVisitRow[] }>;

interface BrowserCursor {
  version: 1;
  time: string;
  id: number;
}

export class BrowserHistoryConnector implements SourceConnectorDefinition<TrustedActivityEventInput> {
  readonly service = 'browser';
  readonly persistPage: ConnectorPagePersistence<TrustedActivityEventInput>;
  private readonly source: ConnectorSource;
  private readonly databasePath: string;
  private readonly pageSize: number;
  private readonly runHelper: BrowserHelperRunner;
  private readonly now: () => Date;

  constructor(private readonly options: BrowserConnectorOptions) {
    if (!options.profilePath.trim()) throw new Error('An explicit browser profile path is required');
    this.pageSize = options.pageSize ?? 250;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 500) {
      throw new Error('Browser page size must be an integer from 1 to 500');
    }
    const sourceKey = options.sourceKey ?? process.env.CONNECTOR_SOURCE_ID_KEY;
    if (!sourceKey || Buffer.byteLength(sourceKey) < 32) {
      throw new Error('CONNECTOR_SOURCE_ID_KEY must contain at least 32 bytes');
    }
    const profile = resolve(options.profilePath);
    this.databasePath = options.databasePath ?? resolve(
      profile,
      options.browser === 'firefox' ? 'places.sqlite' : 'History',
    );
    this.source = {
      sourceId: browserSourceId(options.browser, profile, sourceKey),
      namespace: 'activity',
      displayName: `${options.browser} profile`,
    };
    this.runHelper = options.runHelper ?? createPythonRunner(options.python ?? process.env.BROWSER_HISTORY_PYTHON ?? 'python3');
    this.now = options.now ?? (() => new Date());
    this.persistPage = (client, _source, events, scope) =>
      upsertActivityEventsWithClient(client, events, scope);
  }

  async listSources(_ctx: ConnectorContext, _signal: AbortSignal): Promise<ConnectorSource[]> {
    return [this.source];
  }

  async fetchPage(
    source: ConnectorSource,
    state: ConnectorStoredState,
    ctx: ConnectorContext,
    signal: AbortSignal,
  ): Promise<ConnectorPage<TrustedActivityEventInput>> {
    if (!ctx.apiKeyId || ctx.apiKeyId !== ctx.scope.keyId) {
      throw new Error('Browser connector requires trusted API-key attribution');
    }
    if (source.sourceId !== this.source.sourceId) throw new Error('Unexpected browser source');
    const cursor = parseBrowserCursor(state.cursor) ?? initialCursor(this.options.browser, this.options.since);
    const result = await this.runHelper([
      '--browser', this.options.browser,
      '--database', this.databasePath,
      '--after-time', cursor.time,
      '--after-id', String(cursor.id),
      '--limit', String(this.pageSize),
    ], signal);
    validateRows(result.visits);

    const observedAt = this.now();
    const events: TrustedActivityEventInput[] = [];
    for (const visit of result.visits) {
      const sanitized = sanitizeBrowserUrl(visit.url, this.options.fullPath === true);
      if (!sanitized) continue;
      const title = sanitizeTitle(visit.title) || sanitized.displayHost;
      events.push({
        connector: this.service,
        source_id: source.sourceId,
        event_key: `visit:${visit.id}`,
        event_type: 'page_visit',
        title,
        occurred_at: visit.visited_at,
        observed_at: observedAt,
        time_precision: 'instant',
        namespace: source.namespace,
        client_id: ctx.apiKeyId,
        agent_id: ctx.agentId ?? null,
        metadata: {
          url: sanitized.url,
          browser: this.options.browser,
          url_storage: this.options.fullPath ? 'path' : 'registrable_origin',
        },
      });
    }

    const last = result.visits.at(-1);
    const nextCursor = last ? serializeBrowserCursor({ version: 1, time: last.cursor_time, id: last.id }) : state.cursor;
    const newest = events.reduce<Date | null>((value, event) => {
      const date = new Date(event.occurred_at);
      return !value || date > value ? date : value;
    }, null);
    return {
      events,
      cursor: nextCursor,
      done: result.visits.length < this.pageSize,
      lastEventAt: newest ?? state.lastEventAt,
    };
  }
}

export function browserSourceId(browser: BrowserFamily, profilePath: string, key: string): string {
  const digest = createHmac('sha256', key)
    .update(`browser-source:v1\0${browser}\0${resolve(profilePath)}`)
    .digest('hex');
  return `${browser}:v1:${digest}`;
}

export function sanitizeBrowserUrl(
  raw: string,
  includePath = false,
): { url: string; displayHost: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const hostname = parsed.hostname.replace(/\.$/, '').toLowerCase();
  if (isPrivateHostname(hostname)) return null;
  const domain = getDomain(hostname, { allowPrivateDomains: false });
  if (!domain) return null;
  const displayHost = domain.toLowerCase();
  if (!includePath) return { url: `${parsed.protocol}//${displayHost}`, displayHost };
  const pathname = parsed.pathname.startsWith('/') ? parsed.pathname : `/${parsed.pathname}`;
  return { url: `${parsed.protocol}//${hostname}${pathname}`, displayHost };
}

function isPrivateHostname(hostname: string): boolean {
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || !hostname.includes('.')) return true;
  const kind = isIP(hostname);
  if (kind === 4) {
    const parts = hostname.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      parts[0] >= 224;
  }
  if (kind === 6) {
    const normalized = hostname.toLowerCase();
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff');
  }
  return false;
}

function sanitizeTitle(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1024);
}

function parseBrowserCursor(raw: string | null): BrowserCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<BrowserCursor>;
    if (value.version !== 1 || typeof value.time !== 'string' || !/^-?\d+$/.test(value.time) ||
        BigInt(value.time) < -1n || BigInt(value.time).toString() !== value.time ||
        !Number.isSafeInteger(value.id) || value.id! < -1) return null;
    return value as BrowserCursor;
  } catch {
    return null;
  }
}

function serializeBrowserCursor(cursor: BrowserCursor): string {
  return JSON.stringify(cursor);
}

function initialCursor(browser: BrowserFamily, since?: Date): BrowserCursor {
  if (!since) return { version: 1, time: '-1', id: -1 };
  if (!Number.isFinite(since.getTime())) throw new Error('Browser backfill since date is invalid');
  const unixUs = BigInt(since.getTime()) * 1000n;
  return {
    version: 1,
    time: (browser === 'chromium' ? unixUs + 11_644_473_600_000_000n : unixUs).toString(),
    id: -1,
  };
}

function validateRows(rows: BrowserVisitRow[]): void {
  if (!Array.isArray(rows) || rows.length > 500) throw new Error('Browser helper returned an invalid visit batch');
  let prior: BrowserVisitRow | null = null;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.id) || row.id < 0 || typeof row.cursor_time !== 'string' ||
        !/^\d+$/.test(row.cursor_time) || BigInt(row.cursor_time).toString() !== row.cursor_time ||
        typeof row.url !== 'string' || typeof row.title !== 'string' || !Number.isFinite(Date.parse(row.visited_at))) {
      throw new Error('Browser helper returned an invalid visit row');
    }
    if (prior && (BigInt(row.cursor_time) < BigInt(prior.cursor_time) ||
        (row.cursor_time === prior.cursor_time && row.id <= prior.id))) {
      throw new Error('Browser helper returned visits out of cursor order');
    }
    prior = row;
  }
}

function createPythonRunner(python: string): BrowserHelperRunner {
  return (args, signal) => new Promise((resolvePromise, reject) => {
    const helper = resolve(process.cwd(), 'scripts', 'browser_history_helper.py');
    const child = spawn(python, [helper, ...args], { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Browser history helper exited ${code}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as { visits: BrowserVisitRow[] });
      } catch {
        reject(new Error('Browser history helper returned invalid JSON'));
      }
    });
  });
}
