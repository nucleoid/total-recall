import type { DbScope, ScopedClient } from '../db.js';

export type EventTimePrecision = 'instant' | 'minute' | 'day' | 'aggregate';

/** A stable, non-secret account/profile/calendar identity. */
export interface ConnectorSource {
  sourceId: string;
  namespace: string;
  displayName?: string;
}

export interface ConnectorStoredState {
  cursor: string | null;
  lastEventAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface ConnectorPage<Event> {
  events: Event[];
  /** Cursor after this page. Required when done is false. */
  cursor: string | null;
  done: boolean;
  warnings?: string[];
  /** Newest accepted provider event time, never observation time. */
  lastEventAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export interface SourceSyncOutcome {
  source_id: string;
  status: 'succeeded' | 'failed' | 'dry_run';
  events_ingested: number;
  events_skipped: number;
  pages: number;
  cursor: string | null;
  warnings: string[];
  errors: string[];
}

export interface ConnectorRunOutcome {
  connector: string;
  status: 'succeeded' | 'partial_failure' | 'failed' | 'dry_run';
  sources: SourceSyncOutcome[];
  events_ingested: number;
  events_skipped: number;
  duration_ms: number;
}

export interface ConnectorPagePersistence<Event> {
  (
    client: ScopedClient,
    source: ConnectorSource,
    events: Event[],
    scope: DbScope,
  ): Promise<{ inserted: number; skipped: number }>;
}
