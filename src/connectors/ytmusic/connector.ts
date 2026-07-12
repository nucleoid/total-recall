import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { BaseConnector } from '../base.js';
import {
  getConnectorCredentials,
  setConnectorCredentials,
  type MediaEventInput,
} from '../../media.js';
import { queryScoped } from '../../db.js';
import type { ConnectorContext } from '../base.js';
import { toMediaEvent, type YtHistoryItem } from './transform.js';

const PYTHON = process.env.YTMUSIC_PYTHON || 'python3';

function helperPath(): string {
  // src/connectors/ytmusic/connector.ts  →  scripts/ytmusic_helper.py
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', 'scripts', 'ytmusic_helper.py');
}

interface ChildResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runPython(args: string[], inheritStdio = false, stdinPayload?: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const stdinMode = stdinPayload !== undefined ? 'pipe' : (inheritStdio ? 'inherit' : 'pipe');
    const stderrMode = inheritStdio ? 'inherit' : 'pipe';
    const child = spawn(PYTHON, [helperPath(), ...args], {
      stdio: [stdinMode, 'pipe', stderrMode],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => (stdout += b.toString()));
    child.stderr?.on('data', (b) => (stderr += b.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    if (stdinPayload !== undefined && child.stdin) {
      child.stdin.write(stdinPayload);
      child.stdin.end();
    }
  });
}

export class YtmusicConnector extends BaseConnector {
  readonly service = 'ytmusic';

  /**
   * One-time OAuth auth flow. Runs the Python helper with inherited stdio
   * so the user can see the verification URL + device code and the helper
   * can block waiting for them to complete it.
   *
   * Note: OAuth auth currently fails on YouTube Music's backend for most
   * users (Google rejects the device-code client type for music API calls).
   * Prefer `authorizeBrowser` until/unless Google fixes this.
   */
  async authorize(clientId: string, clientSecret: string): Promise<void> {
    const result = await runPython(
      ['auth', '--client-id', clientId, '--client-secret', clientSecret],
      true
    );
    if (result.code !== 0) {
      throw new Error(`ytmusic auth failed: ${result.stderr || 'exit ' + result.code}`);
    }
    const token = JSON.parse(result.stdout);
    await setConnectorCredentials(this.service, token);
  }

  /**
   * Browser-headers auth. The caller supplies the raw request headers
   * copied from a real YouTube Music browser session (DevTools → Network
   * → any browse request → Copy → request headers). This bypasses OAuth
   * entirely and uses the same session as the web app.
   */
  async authorizeBrowser(rawHeaders: string): Promise<void> {
    const result = await runPython(['auth-browser'], false, rawHeaders);
    if (result.code !== 0) {
      throw new Error(`ytmusic browser auth failed: ${result.stderr || 'exit ' + result.code}`);
    }
    const config = JSON.parse(result.stdout);
    await setConnectorCredentials(this.service, config);
  }

  protected async fetchSince(since: Date | null, ctx: ConnectorContext): Promise<{
    events: MediaEventInput[];
    cursor?: string;
  }> {
    const stored = await getConnectorCredentials(this.service);
    if (!stored) {
      throw new Error('No ytmusic credentials. Run scripts/ytmusic-auth.ts first.');
    }

    const dir = await mkdtemp(join(tmpdir(), 'ytmusic-'));
    const tokenPath = join(dir, 'token.json');

    try {
      await writeFile(tokenPath, JSON.stringify(stored));

      const args = ['fetch', '--token-file', tokenPath];
      if (since) args.push('--since', since.toISOString());

      const result = await runPython(args);
      if (result.code !== 0) {
        throw new Error(`ytmusic fetch failed: ${result.stderr || 'exit ' + result.code}`);
      }

      // Look for a token-refresh notice on stderr and persist if present.
      const refreshMatch = result.stderr
        .split('\n')
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .find((obj) => obj && typeof obj === 'object' && 'token_update' in obj);
      if (refreshMatch?.token_update) {
        await setConnectorCredentials(this.service, refreshMatch.token_update);
      }

      const parsed = JSON.parse(result.stdout) as { items: YtHistoryItem[] };
      const events = (parsed.items ?? [])
        .map(toMediaEvent)
        .filter((e): e is MediaEventInput => e !== null);

      // YouTube Music returns relative "played" buckets that drift across
      // syncs ("Today" → "Yesterday" the next day). Without extra dedup
      // we'd insert a fresh row every time a bucket rolls. Suppress any
      // event whose videoId already exists in media_events for this service.
      if (events.length === 0) return { events };

      const videoIds = [...new Set(events.map((e) => e.service_id).filter(Boolean))] as string[];
      const existingRows = await queryScoped<{ service_id: string }>(
        ctx.scope,
        `SELECT DISTINCT service_id FROM media_events
         WHERE client_id = $1 AND service = 'ytmusic' AND service_id = ANY($2)`,
        [ctx.scope.keyId, videoIds]
      );
      const seen = new Set(existingRows.rows.map((r) => r.service_id));
      const fresh = events.filter((e) => e.service_id && !seen.has(e.service_id));

      return { events: fresh };
    } finally {
      // We also read the file back so the Python helper's refreshed token
      // is captured even if it didn't emit the stderr notice (some
      // ytmusicapi versions just rewrite the file silently).
      try {
        const after = JSON.parse(await readFile(tokenPath, 'utf-8'));
        if (JSON.stringify(after) !== JSON.stringify(stored)) {
          // preserve client creds bundled by the auth flow
          const merged = {
            ...after,
            _client_id: stored._client_id ?? after._client_id,
            _client_secret: stored._client_secret ?? after._client_secret,
          };
          await setConnectorCredentials(this.service, merged);
        }
      } catch {
        /* nothing to merge */
      }
      await rm(dir, { recursive: true, force: true });
    }
  }
}
