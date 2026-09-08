#!/usr/bin/env node
/**
 * YouTube Music sync entry point.
 *
 * Designed to run via cron. Example (every hour):
 *   0 * * * * cd /home/fuego/projects/total-recall && /usr/bin/node dist/scripts/ytmusic-sync.js
 */
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { YtmusicConnector } from '../src/connectors/ytmusic/connector.js';
import { resolveConnectorAttribution } from '../src/connectors/attribution.js';
import { rollupPendingEvents } from '../src/rollup.js';
import { shutdown } from '../src/db.js';
import type { SyncResult } from '../src/connectors/base.js';

dotenv.config();

type Attribution = Awaited<ReturnType<typeof resolveConnectorAttribution>>;

export interface YtmusicSyncScriptDeps {
  now?: () => Date;
  log?: (message: string) => void;
  error?: (message: string, details?: unknown) => void;
  resolveAttribution?: typeof resolveConnectorAttribution;
  createConnector?: () => {
    sync(ctx: { apiKeyId?: string; agentId?: string; scope: Attribution['scope'] }): Promise<SyncResult>;
  };
  rollupPending?: typeof rollupPendingEvents;
  shutdownDb?: typeof shutdown;
}

export async function runYtmusicSync(deps: YtmusicSyncScriptDeps = {}): Promise<number> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console.log;
  const error = deps.error ?? ((message, details) => {
    if (details === undefined) console.error(message);
    else console.error(message, details);
  });
  const resolveAttribution = deps.resolveAttribution ?? resolveConnectorAttribution;
  const createConnector = deps.createConnector ?? (() => new YtmusicConnector());
  const rollupPending = deps.rollupPending ?? rollupPendingEvents;
  const shutdownDb = deps.shutdownDb ?? shutdown;
  let exitCode = 0;

  try {
    const started = now().toISOString();
    log(`[${started}] ytmusic-sync: starting`);

    const { apiKeyId, agentId, scope, auth } = await resolveAttribution('ytmusic');
    const connector = createConnector();
    const sync = await connector.sync({ apiKeyId, agentId, scope });

    log(
      `[ytmusic-sync] ${sync.events_ingested} ingested, ${sync.events_skipped} skipped, ${sync.duration_ms}ms`
    );
    if (sync.errors.length) {
      error('[ytmusic-sync] errors:', sync.errors);
      exitCode = 1;
    }

    if (sync.events_ingested > 0) {
      const rollup = await rollupPending(auth, scope, 200);
      log(`[ytmusic-sync] rollup: ${rollup.rolled} memories, ${rollup.failed} failed`);
      if (rollup.failed > 0 || rollup.errors.length) {
        error('[ytmusic-sync] rollup errors:', rollup.errors);
        exitCode = 1;
      }
    }

  } catch (err: any) {
    error('[ytmusic-sync] failed:', err?.message ?? String(err));
    exitCode = 1;
  } finally {
    try {
      await shutdownDb();
    } catch (err: any) {
      error('[ytmusic-sync] shutdown failed:', err?.message ?? String(err));
      exitCode = 1;
    }
  }

  log(`[ytmusic-sync] completed exit_code=${exitCode}`);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runYtmusicSync()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('[ytmusic-sync] fatal:', err?.message ?? String(err));
      process.exitCode = 1;
    });
}
