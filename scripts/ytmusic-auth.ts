#!/usr/bin/env node
/**
 * One-time YouTube Music OAuth setup.
 *
 * Reads YTMUSIC_CLIENT_ID and YTMUSIC_CLIENT_SECRET from the environment,
 * runs ytmusicapi's device-code flow (perfect for headless: it prints a
 * URL + code to enter on any device), and stores the resulting token in
 * connector_credentials.
 *
 * Prereqs:
 *   - pip install ytmusicapi
 *   - Google Cloud project with YouTube Data API v3 enabled
 *   - OAuth 2.0 client of type "TVs and Limited Input devices"
 *
 * See docs/connectors/ytmusic.md for the full walkthrough.
 */
import dotenv from 'dotenv';
import { YtmusicConnector } from '../src/connectors/ytmusic/connector.js';
import { shutdown } from '../src/db.js';

dotenv.config();

async function main(): Promise<void> {
  const clientId = process.env.YTMUSIC_CLIENT_ID;
  const clientSecret = process.env.YTMUSIC_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('YTMUSIC_CLIENT_ID and YTMUSIC_CLIENT_SECRET must be set in the environment');
  }

  console.log('\nYouTube Music OAuth setup');
  console.log('-------------------------');
  console.log('A verification URL and code will appear below. Open the URL on any');
  console.log('device, sign in with the Google account that has YouTube Music,');
  console.log('and enter the code. This script will resume once you finish.\n');

  const connector = new YtmusicConnector();
  await connector.authorize(clientId, clientSecret);

  console.log('\n✓ Token stored in connector_credentials. You can now run:');
  console.log('    npm run ytmusic:sync\n');
}

main()
  .then(() => shutdown())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nYouTube Music auth failed:', err.message);
    shutdown().finally(() => process.exit(1));
  });
