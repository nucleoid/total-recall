#!/usr/bin/env node
/**
 * Browser-headers auth for YouTube Music.
 *
 * Use this when the OAuth path (`ytmusic:auth`) fails — currently the
 * common case, because YouTube Music's backend rejects the device-code
 * client type for music API calls.
 *
 * How to use:
 *   1. Open https://music.youtube.com in a real browser, signed into the
 *      Google account whose history you want.
 *   2. Open DevTools (F12) → Network tab. Refresh the page.
 *   3. Click any request to /youtubei/v1/browse (or similar youtubei call).
 *   4. Right-click → Copy → Copy as Headers (Chrome: "Copy request headers";
 *      Firefox: under "Headers" tab, right-click → Copy → Copy Request Headers).
 *   5. Paste them into the prompt this script shows, then press Ctrl+D
 *      (Linux/macOS) or Ctrl+Z + Enter (Windows) to finish input.
 *
 * The headers are sent to ytmusicapi.setup() which extracts the auth
 * cookies + user identifiers and stores them in connector_credentials.
 */
import dotenv from 'dotenv';
import { stdin } from 'node:process';
import { YtmusicConnector } from '../src/connectors/ytmusic/connector.js';
import { shutdown } from '../src/db.js';

dotenv.config();

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf-8');
    stdin.on('data', (chunk) => (data += chunk));
    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  console.log('\nYouTube Music browser-headers auth');
  console.log('-----------------------------------');
  console.log('Paste the raw request headers (one per line) from a YouTube Music');
  console.log('request you copied from DevTools, then press Ctrl+D to finish.\n');

  const rawHeaders = await readStdin();
  if (!rawHeaders.trim()) {
    throw new Error('No headers received. Paste headers then press Ctrl+D.');
  }

  const connector = new YtmusicConnector();
  await connector.authorizeBrowser(rawHeaders);

  console.log('\n✓ Browser headers stored in connector_credentials.');
  console.log('  Run `npm run ytmusic:sync` to verify the connection.\n');
}

main()
  .then(() => shutdown())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nYouTube Music browser auth failed:', err.message);
    shutdown().finally(() => process.exit(1));
  });
