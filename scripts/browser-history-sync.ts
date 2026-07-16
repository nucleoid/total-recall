#!/usr/bin/env node
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
import { BrowserHistoryConnector, type BrowserFamily } from '../src/connectors/browser/connector.js';
import { runSourceConnector } from '../src/connectors/base.js';
import { resolveActivityConnectorAttribution } from '../src/connectors/attribution.js';
import { shutdown } from '../src/db.js';

dotenv.config();

interface Options {
  browser: BrowserFamily;
  profile: string;
  database?: string;
  dryRun: boolean;
  fullPath: boolean;
  since?: Date;
  pageSize: number;
  maxPages: number;
}

export function parseBrowserSyncArgs(args: string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run' || arg === '--full-path') {
      flags.add(arg);
      continue;
    }
    if (!arg.startsWith('--') || index + 1 >= args.length || args[index + 1].startsWith('--')) {
      throw new Error(`Invalid browser sync argument: ${arg}`);
    }
    values.set(arg, args[++index]);
  }
  const browser = values.get('--browser');
  if (browser !== 'chromium' && browser !== 'firefox') {
    throw new Error('--browser must be chromium or firefox');
  }
  const profile = values.get('--profile');
  if (!profile) throw new Error('--profile is required and must explicitly select one browser profile');
  const pageSize = integerOption(values.get('--page-size'), 250, 1, 500, '--page-size');
  const maxPages = integerOption(values.get('--max-pages'), 20, 1, 100, '--max-pages');
  const sinceValue = values.get('--since');
  const since = sinceValue ? new Date(sinceValue) : undefined;
  if (since && !Number.isFinite(since.getTime())) throw new Error('--since must be a valid ISO timestamp');
  return {
    browser,
    profile,
    database: values.get('--database'),
    dryRun: flags.has('--dry-run'),
    fullPath: flags.has('--full-path'),
    since,
    pageSize,
    maxPages,
  };
}

export async function runBrowserHistorySync(args = process.argv.slice(2)): Promise<number> {
  const options = parseBrowserSyncArgs(args);
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('Browser sync cancelled'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const attribution = await resolveActivityConnectorAttribution('browser', options.dryRun);
    const connector = new BrowserHistoryConnector({
      browser: options.browser,
      profilePath: options.profile,
      databasePath: options.database,
      fullPath: options.fullPath,
      pageSize: options.pageSize,
      since: options.since,
    });
    const outcome = await runSourceConnector(
      connector,
      {
        apiKeyId: attribution.apiKeyId,
        agentId: attribution.agentId,
        scope: attribution.scope,
      },
      {
        dryRun: options.dryRun,
        maxPagesPerSource: options.maxPages,
        signal: abort.signal,
      },
    );
    console.log(JSON.stringify(outcome));
    return outcome.status === 'failed' || outcome.status === 'partial_failure' ? 1 : 0;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await shutdown();
  }
}

function integerOption(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBrowserHistorySync()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`browser-history-sync failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
