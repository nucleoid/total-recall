#!/usr/bin/env node
/**
 * YouTube Music sync entry point.
 *
 * Designed to run via cron. Example (every hour):
 *   0 * * * * cd /home/fuego/projects/total-recall && /usr/bin/node dist/scripts/ytmusic-sync.js
 */
import dotenv from 'dotenv';
import { YtmusicConnector } from '../src/connectors/ytmusic/connector.js';
import { rollupPendingEvents } from '../src/rollup.js';
import { shutdown } from '../src/db.js';

dotenv.config();

async function main(): Promise<void> {
  const started = new Date().toISOString();
  console.log(`[${started}] ytmusic-sync: starting`);

  const connector = new YtmusicConnector();
  const sync = await connector.sync();

  console.log(
    `[ytmusic-sync] ${sync.events_ingested} ingested, ${sync.events_skipped} skipped, ${sync.duration_ms}ms`
  );
  if (sync.errors.length) {
    console.error('[ytmusic-sync] errors:', sync.errors);
  }

  if (sync.events_ingested > 0) {
    const rollup = await rollupPendingEvents(200);
    console.log(`[ytmusic-sync] rollup: ${rollup.rolled} memories, ${rollup.failed} failed`);
    if (rollup.errors.length) console.error('[ytmusic-sync] rollup errors:', rollup.errors);
  }

  console.log('[ytmusic-sync] done');
}

main()
  .then(() => shutdown())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[ytmusic-sync] failed:', err.message);
    shutdown().finally(() => process.exit(1));
  });
