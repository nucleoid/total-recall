#!/usr/bin/env node
/**
 * One-time Spotify OAuth setup.
 *
 * Usage:
 *   1. Create a Spotify app at https://developer.spotify.com/dashboard
 *   2. Add http://localhost:8888/callback as a Redirect URI
 *   3. Set env vars: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
 *      (optional) SPOTIFY_REDIRECT_URI (defaults to http://localhost:8888/callback)
 *      (optional) SPOTIFY_AUTH_PORT (defaults to 8888)
 *   4. Run: npm run spotify-auth
 *
 * The script spins up a one-shot HTTP server on the callback port, opens
 * the authorize URL (prints it as a fallback), catches the redirect,
 * exchanges the code for tokens, and stores them in connector_credentials.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import dotenv from 'dotenv';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  saveInitialCreds,
} from '../src/connectors/spotify/auth.js';
import { shutdown } from '../src/db.js';

dotenv.config();

const PORT = parseInt(process.env.SPOTIFY_AUTH_PORT || '8888', 10);
const state = randomBytes(16).toString('hex');
const authorizeUrl = buildAuthorizeUrl(state);

function tryOpenBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start ""'
    : 'xdg-open';
  exec(`${cmd} "${url}"`, () => {
    /* best-effort: ignore errors */
  });
}

async function main(): Promise<void> {
  console.log('\nSpotify OAuth setup');
  console.log('-------------------');
  console.log(`Listening for callback on http://localhost:${PORT}/callback`);
  console.log(`\nOpen this URL in your browser if it does not open automatically:\n`);
  console.log(`  ${authorizeUrl}\n`);

  await new Promise<void>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      if (!req.url) {
        res.writeHead(400).end();
        return;
      }
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Spotify error: ${error}`);
        server.close();
        reject(new Error(`Spotify returned error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Missing code or state mismatch');
        server.close();
        reject(new Error('Missing code or state mismatch'));
        return;
      }

      try {
        const creds = await exchangeCodeForTokens(code);
        await saveInitialCreds(creds);
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(
          '<html><body><h2>Spotify connected.</h2><p>You can close this tab and return to the terminal.</p></body></html>'
        );
        console.log('\n✓ Tokens exchanged and stored in connector_credentials.');
        console.log(`  scopes: ${creds.scope}`);
        console.log(`  access_token expires in ~${Math.round((creds.expires_at - Date.now()) / 60000)} min`);
        console.log(`  refresh_token: stored\n`);
        server.close();
        resolve();
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`Error: ${err.message}`);
        server.close();
        reject(err);
      }
    });

    server.listen(PORT, () => {
      tryOpenBrowser(authorizeUrl);
    });

    server.on('error', reject);
  });
}

main()
  .then(() => shutdown())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nSpotify auth failed:', err.message);
    shutdown().finally(() => process.exit(1));
  });
