import type { MediaEventInput, TrustedMediaEventInput } from '../media.js';
import {
  withCheckedOutClient,
  withScopedClient,
  withScopedTransactionOnClient,
  type DbScope,
  type ScopedClient,
} from '../db.js';
import { retryConnectorOperation, type RetryOptions } from './retry.js';
import {
  acquireConnectorSourceLock,
  advanceConnectorState,
  lockConnectorState,
  readConnectorStateRowWithClient,
  readConnectorStateWithClient,
  releaseConnectorSourceLock,
  type ConnectorStateRow,
} from './state.js';
import type {
  ConnectorPage,
  ConnectorPagePersistence,
  ConnectorRunOutcome,
  ConnectorSource,
  ConnectorStoredState,
  SourceSyncOutcome,
} from './types.js';
import {
  mediaEventKey,
  mutateConnectorSyncStateWithClient,
  getConnectorCredentials,
  setConnectorCredentials,
  upsertMediaEventsWithClient,
  type ConnectorSyncState,
  type ConnectorSyncStatePatch,
} from '../media.js';

export interface ConnectorContext {
  /** Optional api_key id to attribute events to (passed through to media_events). */
  apiKeyId?: string;
  /** Optional agent id to attribute events to. */
  agentId?: string;
  /** Explicit service-key database scope for protected connector writes. */
  scope: DbScope;
}

export function trustConnectorMediaEvents(
  events: MediaEventInput[],
  ctx: Pick<ConnectorContext, 'apiKeyId' | 'agentId'>
): TrustedMediaEventInput[] {
  if (!ctx.apiKeyId) {
    throw new Error('Connector attribution requires apiKeyId');
  }
  const apiKeyId = ctx.apiKeyId;

  return events.map((event) => ({
    ...event,
    source_id: event.source_id ?? 'default',
    event_key: event.event_key ?? mediaEventKey(event),
    client_id: apiKeyId,
    agent_id: ctx.agentId ?? null,
  }));
}

export interface SyncResult {
  service: string;
  events_ingested: number;
  events_skipped: number;
  warnings?: string[];
  errors: string[];
  duration_ms: number;
  cursor?: string;
}

export interface ConnectorFetchResult {
  events: MediaEventInput[];
  cursor?: string;
  errors?: string[];
  /**
   * Whether BaseConnector should advance connector_sync_state.last_event_at
   * from the returned events. Defaults to true for existing connectors.
   */
  advanceLastEventAt?: boolean;
  syncState?: (current: ConnectorSyncState) => ConnectorSyncStatePatch;
}

function validEventDate(event: MediaEventInput): Date {
  const ts = event.played_at instanceof Date ? event.played_at : new Date(event.played_at);
  if (!Number.isFinite(ts.getTime())) {
    const id = event.service_id ? ` ${event.service_id}` : '';
    throw new Error(`Invalid played_at for ${event.service}${id}: ${String(event.played_at)}`);
  }
  return ts;
}

export function validateMediaEventDates(events: MediaEventInput[]): void {
  events.forEach(validEventDate);
}

export function filterValidMediaEventDates(events: MediaEventInput[]): {
  events: MediaEventInput[];
  skipped: number;
  errors: string[];
} {
  const valid: MediaEventInput[] = [];
  const errors: string[] = [];

  for (const event of events) {
    try {
      validEventDate(event);
      valid.push(event);
    } catch (err: any) {
      errors.push(err?.message ?? String(err));
    }
  }

  return {
    events: valid,
    skipped: events.length - valid.length,
    errors,
  };
}

export function selectNewestCursorDate(events: MediaEventInput[]): Date | null {
  return events.reduce<Date | null>((acc, e) => {
    const ts = validEventDate(e);
    if (e.metadata?.played_cursor_eligible === false) return acc;
    return !acc || ts > acc ? ts : acc;
  }, null);
}

export function resolveLastEventAt(
  events: MediaEventInput[],
  since: Date | null,
  advanceLastEventAt = true
): Date | null {
  if (!advanceLastEventAt) {
    validateMediaEventDates(events);
    return since;
  }

  return selectNewestCursorDate(events) ?? since;
}

/**
 * Base class for media connectors. Each concrete connector implements
 * `fetchSince()` which returns canonical MediaEventInput[] for any events
 * newer than the supplied cursor / timestamp. The base class handles
 * upsert, attribution, sync-state, and timing.
 */
export interface SourceConnectorDefinition<Event> {
  readonly service: string;
  listSources(ctx: ConnectorContext, signal: AbortSignal): Promise<ConnectorSource[]>;
  fetchPage(
    source: ConnectorSource,
    state: ConnectorStoredState,
    ctx: ConnectorContext,
    signal: AbortSignal,
  ): Promise<ConnectorPage<Event>>;
  persistPage: ConnectorPagePersistence<Event>;
}

export interface SourceConnectorRunOptions {
  dryRun?: boolean;
  maxPagesPerSource?: number;
  signal?: AbortSignal;
  retry?: RetryOptions;
}

/**
 * Source-aware connector orchestration for life connectors. Every non-dry-run
 * page is fetched while a source lock is held, then its events and cursor are
 * committed in the same scoped transaction. Sources fail independently.
 */
export async function runSourceConnector<Event>(
  connector: SourceConnectorDefinition<Event>,
  ctx: ConnectorContext,
  options: SourceConnectorRunOptions = {},
): Promise<ConnectorRunOutcome> {
  const started = Date.now();
  const maxPages = options.maxPagesPerSource ?? 100;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) {
    throw new Error('maxPagesPerSource must be an integer from 1 to 10000');
  }

  const signal = options.signal ?? new AbortController().signal;
  const sources = await connector.listSources(ctx, signal);
  validateSources(sources, ctx.scope);

  const outcomes: SourceSyncOutcome[] = [];
  for (const source of sources) {
    outcomes.push(await runOneSource(connector, source, ctx, { ...options, maxPagesPerSource: maxPages }, signal));
  }

  const failed = outcomes.filter((outcome) => outcome.status === 'failed').length;
  return {
    connector: connector.service,
    status: options.dryRun
      ? (failed ? 'failed' : 'dry_run')
      : failed === 0 ? 'succeeded' : failed === outcomes.length ? 'failed' : 'partial_failure',
    sources: outcomes,
    events_ingested: outcomes.reduce((sum, outcome) => sum + outcome.events_ingested, 0),
    events_skipped: outcomes.reduce((sum, outcome) => sum + outcome.events_skipped, 0),
    duration_ms: Date.now() - started,
  };
}

async function runOneSource<Event>(
  connector: SourceConnectorDefinition<Event>,
  source: ConnectorSource,
  ctx: ConnectorContext,
  options: Required<Pick<SourceConnectorRunOptions, 'maxPagesPerSource'>> & SourceConnectorRunOptions,
  signal: AbortSignal,
): Promise<SourceSyncOutcome> {
  const outcome: SourceSyncOutcome = {
    source_id: source.sourceId,
    status: options.dryRun ? 'dry_run' : 'succeeded',
    events_ingested: 0,
    events_skipped: 0,
    pages: 0,
    cursor: null,
    warnings: [],
    errors: [],
  };
  const seenCursors = new Set<string>();
  let dryState: ConnectorStoredState | null = null;
  let completed = false;

  try {
    if (options.dryRun) {
      dryState = await withScopedClient(ctx.scope, (client) =>
        readConnectorStateWithClient(client, ctx.scope, connector.service, source.sourceId, source.namespace)
      );
    }

    while (outcome.pages < options.maxPagesPerSource) {
      const pageResult = options.dryRun
        ? {
            page: await fetchConnectorPage(connector, source, dryState!, ctx, signal, options.retry, seenCursors),
            inserted: 0,
            skipped: 0,
          }
        : await persistAtomicPage(connector, source, ctx, signal, options.retry, seenCursors);
      const { page, inserted, skipped } = pageResult;
      outcome.pages++;
      outcome.events_ingested += options.dryRun ? page.events.length : inserted;
      outcome.events_skipped += skipped;
      outcome.cursor = page.cursor;
      outcome.warnings.push(...(page.warnings ?? []));

      if (page.done) {
        completed = true;
        break;
      }
      if (!page.cursor || seenCursors.has(page.cursor)) {
        throw new Error(`Connector pagination did not advance for ${connector.service}/${source.sourceId}`);
      }
      seenCursors.add(page.cursor);
      if (options.dryRun) {
        dryState = {
          cursor: page.cursor,
          lastEventAt: page.lastEventAt ?? dryState!.lastEventAt,
          metadata: page.metadata ?? dryState!.metadata,
        };
      }
    }
    if (!completed && outcome.pages >= options.maxPagesPerSource) {
      throw new Error(`Connector pagination hit ${options.maxPagesPerSource} page cap for ${connector.service}/${source.sourceId}`);
    }
  } catch (error) {
    outcome.status = 'failed';
    outcome.errors.push(error instanceof Error ? error.message : String(error));
  }
  return outcome;
}

async function fetchConnectorPage<Event>(
  connector: SourceConnectorDefinition<Event>,
  source: ConnectorSource,
  state: ConnectorStoredState,
  ctx: ConnectorContext,
  signal: AbortSignal,
  retry: RetryOptions | undefined,
  seenCursors?: Set<string>,
): Promise<ConnectorPage<Event>> {
  const page = await retryConnectorOperation(
    () => connector.fetchPage(source, state, ctx, signal),
    { ...retry, signal },
  );
  validatePage(page);
  if (!page.done && page.cursor && (page.cursor === state.cursor || seenCursors?.has(page.cursor))) {
    throw new Error(`Connector pagination did not advance for ${connector.service}/${source.sourceId}`);
  }
  return page;
}

async function persistAtomicPage<Event>(
  connector: SourceConnectorDefinition<Event>,
  source: ConnectorSource,
  ctx: ConnectorContext,
  signal: AbortSignal,
  retry: RetryOptions | undefined,
  seenCursors: Set<string>,
): Promise<{ page: ConnectorPage<Event>; inserted: number; skipped: number }> {
  return withCheckedOutClient(async (client: ScopedClient) => {
    await acquireConnectorSourceLock(client, ctx.scope, connector.service, source.sourceId, source.namespace);
    try {
      const before = await withScopedTransactionOnClient(client, ctx.scope, (scoped) =>
        readConnectorStateRowWithClient(scoped, ctx.scope, connector.service, source.sourceId, source.namespace)
      );
      const state: ConnectorStoredState = {
        cursor: before?.cursor ?? null,
        lastEventAt: before?.last_event_at ?? null,
        metadata: before?.metadata ?? {},
      };
      const page = await fetchConnectorPage(connector, source, state, ctx, signal, retry, seenCursors);
      return await withScopedTransactionOnClient(client, ctx.scope, async (scoped) => {
        const row = await lockConnectorState(
          scoped, ctx.scope, connector.service, source.sourceId, source.namespace,
        );
        if (before && (before.updated_at.getTime() !== row.updated_at.getTime() || before.cursor !== row.cursor)) {
          throw new Error(`Connector state changed during fetch for ${connector.service}/${source.sourceId}`);
        }
        const persisted = await connector.persistPage(scoped, source, page.events, ctx.scope);
        await advanceConnectorState(
          scoped,
          ctx.scope,
          connector.service,
          source.sourceId,
          source.namespace,
          {
            cursor: page.cursor,
            lastEventAt: page.lastEventAt,
            metadata: page.metadata,
          },
        );
        return { page, ...persisted };
      });
    } finally {
      await releaseConnectorSourceLock(client, ctx.scope, connector.service, source.sourceId, source.namespace);
    }
  });
}

function validateSources(sources: ConnectorSource[], scope: DbScope): void {
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source.sourceId.trim() || !source.namespace.trim()) throw new Error('Connector source identity must be nonblank');
    if (!scope.namespaces.includes(source.namespace)) {
      throw new Error(`Connector source requires unauthorized namespace "${source.namespace}"`);
    }
    const key = `${source.namespace}\u0000${source.sourceId}`;
    if (seen.has(key)) throw new Error(`Connector returned duplicate source_id "${source.sourceId}"`);
    seen.add(key);
  }
}

function validatePage<Event>(page: ConnectorPage<Event>): void {
  if (!Array.isArray(page.events)) throw new Error('Connector page events must be an array');
  if (!page.done && (!page.cursor || page.cursor.trim() === '')) {
    throw new Error('A non-final connector page requires a nonblank cursor');
  }
}

export async function withConnectorSessionLock<T>(
  scope: DbScope,
  service: string,
  sourceId: string,
  namespace: string,
  fn: (client: ScopedClient) => Promise<T>,
): Promise<T> {
  return withCheckedOutClient(async (client) => {
    await acquireConnectorSourceLock(client, scope, service, sourceId, namespace);
    try {
      return await fn(client);
    } finally {
      await releaseConnectorSourceLock(client, scope, service, sourceId, namespace);
    }
  });
}

export function assertStateUnchanged(
  before: ConnectorStateRow | null,
  current: ConnectorStateRow,
  service: string,
  sourceId: string,
): void {
  if (before && (before.updated_at.getTime() !== current.updated_at.getTime() || before.cursor !== current.cursor)) {
    throw new Error(`Connector state changed during fetch for ${service}/${sourceId}`);
  }
}

export abstract class BaseConnector {
  abstract readonly service: string;

  /**
   * Fetch events from the third-party service. Should return events newer
   * than `since` (a timestamp from the last successful sync). If the
   * service uses an opaque cursor, the connector can ignore `since` and
   * read its cursor from `getSyncState()` directly.
   */
  protected abstract fetchSince(since: Date | null, ctx: ConnectorContext): Promise<ConnectorFetchResult>;

  /** Load credentials for this service. */
  protected async credentials(): Promise<Record<string, unknown> | null> {
    return getConnectorCredentials(this.service);
  }

  /** Persist credentials (e.g. after OAuth refresh). */
  protected async saveCredentials(data: Record<string, unknown>): Promise<void> {
    await setConnectorCredentials(this.service, data);
  }

  /** Standard incremental sync: pulls new events since last_event_at. */
  async sync(ctx: ConnectorContext): Promise<SyncResult> {
    const start = Date.now();
    const errors: string[] = [];
    let ingested = 0;
    let skipped = 0;
    let cursor: string | undefined;

    try {
      await withConnectorSessionLock(ctx.scope, this.service, 'default', 'media', async (client) => {
        const before = await withScopedTransactionOnClient(client, ctx.scope, (scoped) =>
          readConnectorStateRowWithClient(scoped, ctx.scope, this.service, 'default', 'media')
        );
        const since = before?.last_event_at ?? null;
        const {
          events,
          cursor: nextCursor,
          errors: fetchErrors = [],
          advanceLastEventAt = true,
          syncState,
        } = await this.fetchSince(since, ctx);
        cursor = nextCursor;
        errors.push(...fetchErrors);
        const valid = filterValidMediaEventDates(events);
        errors.push(...valid.errors);
        skipped += valid.skipped;
        const enriched = trustConnectorMediaEvents(valid.events, ctx);

        await withScopedTransactionOnClient(client, ctx.scope, async (scoped) => {
          const state = await lockConnectorState(scoped, ctx.scope, this.service, 'default', 'media');
          assertStateUnchanged(before, state, this.service, 'default');
          const result = await upsertMediaEventsWithClient(scoped, enriched, ctx.scope);
          ingested = result.inserted;
          skipped += result.skipped;
          const lastEventAt = resolveLastEventAt(valid.events, since, advanceLastEventAt);
          await mutateConnectorSyncStateWithClient(scoped, this.service, (current) => ({
            last_sync_at: new Date(),
            last_event_at: lastEventAt,
            cursor: nextCursor ?? current.cursor ?? state.cursor ?? null,
            ...(syncState ? syncState(current) : {}),
          }));
        });
      });
    } catch (err: any) {
      errors.push(err?.message ?? String(err));
    }

    return {
      service: this.service,
      events_ingested: ingested,
      events_skipped: skipped,
      errors,
      duration_ms: Date.now() - start,
      cursor,
    };
  }

  /**
   * Run a backfill over a wider window. Default impl just calls fetchSince
   * with the given date; connectors that support paging should override.
   */
  async backfill(ctx: ConnectorContext, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: string[] = [];
    let ingested = 0;
    let skipped = 0;

    try {
      await withConnectorSessionLock(ctx.scope, this.service, 'default', 'media', async (client) => {
        const { events } = await this.fetchSince(since, ctx);
        const valid = filterValidMediaEventDates(events);
        errors.push(...valid.errors);
        skipped += valid.skipped;
        const enriched = trustConnectorMediaEvents(valid.events, ctx);
        await withScopedTransactionOnClient(client, ctx.scope, async (scoped) => {
          const result = await upsertMediaEventsWithClient(scoped, enriched, ctx.scope);
          ingested = result.inserted;
          skipped += result.skipped;
        });
      });
    } catch (err: any) {
      errors.push(err?.message ?? String(err));
    }

    return {
      service: this.service,
      events_ingested: ingested,
      events_skipped: skipped,
      errors,
      duration_ms: Date.now() - start,
    };
  }
}
