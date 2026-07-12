#!/usr/bin/env node
/**
 * Plex sync entry point.
 *
 * Pulls history (filtered to your account) from every Plex server you
 * have access to via your plex.tv login — including friend-shared
 * servers — then rolls up new events into embedded summary memories.
 *
 * Designed to run via cron. Example (every 30 minutes):
 *   0,30 * * * * cd /path/to/total-recall && /path/to/tsx scripts/plex-sync.ts
 */
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { PlexConnector } from '../src/connectors/plex/connector.js';
import { resolveConnectorAttribution } from '../src/connectors/attribution.js';
import { rollupPendingEvents } from '../src/rollup.js';
import { shutdown } from '../src/db.js';
import type { SyncResult } from '../src/connectors/base.js';

dotenv.config();

type Attribution = Awaited<ReturnType<typeof resolveConnectorAttribution>>;

export interface PlexSyncScriptDeps {
  now?: () => Date;
  log?: (message: string) => void;
  warn?: (message: string, details?: unknown) => void;
  error?: (message: string, details?: unknown) => void;
  resolveAttribution?: typeof resolveConnectorAttribution;
  createConnector?: () => { sync(ctx: { apiKeyId?: string; agentId?: string; scope: Attribution['scope'] }): Promise<SyncResult> };
  rollupPending?: typeof rollupPendingEvents;
  shutdownDb?: typeof shutdown;
}

export async function runPlexSync(deps: PlexSyncScriptDeps = {}): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? ((message, details) => {
    if (details === undefined) console.warn(message);
    else console.warn(message, details);
  });
  const error = deps.error ?? ((message, details) => {
    if (details === undefined) console.error(message);
    else console.error(message, details);
  });
  const resolveAttribution = deps.resolveAttribution ?? resolveConnectorAttribution;
  const createConnector = deps.createConnector ?? (() => new PlexConnector());
  const rollupPending = deps.rollupPending ?? rollupPendingEvents;
  const shutdownDb = deps.shutdownDb ?? shutdown;
  let exitCode = 0;
  let status: 'ok' | 'degraded' | 'failed' = 'ok';

  try {
    const started = now().toISOString();
    log(`[${started}] plex-sync: starting`);

    const { apiKeyId, agentId, scope, auth } = await resolveAttribution('plex');
    const connector = createConnector();
    const sync = await connector.sync({ apiKeyId, agentId, scope });

    log(
      `[plex-sync] ${sync.events_ingested} ingested, ${sync.events_skipped} skipped, ${sync.duration_ms}ms`
    );
    if (sync.warnings?.length) {
      warn('[plex-sync] warnings:', sync.warnings);
    }
    if (sync.errors.length) {
      error('[plex-sync] errors:', sync.errors);
      exitCode = 1;
      status = 'degraded';
    }

    if (sync.events_ingested > 0) {
      const rollup = await rollupPending(auth, scope, 200);
      log(`[plex-sync] rollup: ${rollup.rolled} memories, ${rollup.failed} failed`);
      if (rollup.failed > 0 || rollup.errors.length) {
        error('[plex-sync] rollup errors:', rollup.errors);
        exitCode = 1;
        status = 'failed';
      }
    }

    log('[plex-sync] done');
  } catch (err: any) {
    error('[plex-sync] failed:', err?.message ?? String(err));
    exitCode = 1;
    status = 'failed';
  } finally {
    try {
      await shutdownDb();
    } catch (err: any) {
      error('[plex-sync] shutdown failed:', err?.message ?? String(err));
      exitCode = 1;
      status = 'failed';
    }
  }

  log(`[plex-sync] completed status=${status} exit_code=${exitCode}`);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPlexSync()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('[plex-sync] fatal:', err?.message ?? String(err));
      process.exitCode = 1;
    });
}
