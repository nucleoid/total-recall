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
import { PlexConnector } from '../src/connectors/plex/connector.js';
import { resolveConnectorAttribution } from '../src/connectors/attribution.js';
import { rollupPendingEvents } from '../src/rollup.js';
import { shutdown } from '../src/db.js';

dotenv.config();

async function main(): Promise<void> {
  const started = new Date().toISOString();
  console.log(`[${started}] plex-sync: starting`);

  const { apiKeyId, agentId, scope } = await resolveConnectorAttribution('plex');
  const connector = new PlexConnector();
  const sync = await connector.sync({ apiKeyId, agentId, scope });

  console.log(
    `[plex-sync] ${sync.events_ingested} ingested, ${sync.events_skipped} skipped, ${sync.duration_ms}ms`
  );
  if (sync.errors.length) {
    console.error('[plex-sync] errors:', sync.errors);
  }

  if (sync.events_ingested > 0) {
    const rollup = await rollupPendingEvents(scope, 200);
    console.log(`[plex-sync] rollup: ${rollup.rolled} memories, ${rollup.failed} failed`);
    if (rollup.errors.length) console.error('[plex-sync] rollup errors:', rollup.errors);
  }

  console.log('[plex-sync] done');
}

main()
  .then(() => shutdown())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[plex-sync] failed:', err.message);
    shutdown().finally(() => process.exit(1));
  });
