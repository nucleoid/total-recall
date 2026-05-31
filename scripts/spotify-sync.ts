#!/usr/bin/env node
/**
 * Spotify sync entry point. Runs an incremental pull of recently-played
 * tracks, upserts them as media_events, then rolls up the new events into
 * embedded summary memories.
 *
 * Designed to run via cron. Example:
 *   STAR / 30 minutes
 *     cd /home/fuego/projects/total-recall && /usr/bin/node dist/scripts/spotify-sync.js
 */
import dotenv from 'dotenv';
import { SpotifyConnector } from '../src/connectors/spotify/connector.js';
import { resolveConnectorAttribution } from '../src/connectors/attribution.js';
import { rollupPendingEvents } from '../src/rollup.js';
import { shutdown } from '../src/db.js';

dotenv.config();

async function main(): Promise<void> {
  const started = new Date().toISOString();
  console.log(`[${started}] spotify-sync: starting`);

  const { apiKeyId, agentId } = await resolveConnectorAttribution('spotify');
  const connector = new SpotifyConnector();
  const sync = await connector.sync({ apiKeyId, agentId });

  console.log(
    `[spotify-sync] ${sync.events_ingested} ingested, ${sync.events_skipped} skipped, ${sync.duration_ms}ms`
  );
  if (sync.errors.length) {
    console.error('[spotify-sync] errors:', sync.errors);
  }

  if (sync.events_ingested > 0) {
    const rollup = await rollupPendingEvents(200);
    console.log(`[spotify-sync] rollup: ${rollup.rolled} memories, ${rollup.failed} failed`);
    if (rollup.errors.length) console.error('[spotify-sync] rollup errors:', rollup.errors);
  }

  console.log(`[spotify-sync] done`);
}

main()
  .then(() => shutdown())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[spotify-sync] failed:', err.message);
    shutdown().finally(() => process.exit(1));
  });
