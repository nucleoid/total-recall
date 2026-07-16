import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export interface MemoryExportCliOptions {
  url: string;
  apiKey: string;
  output: string;
  gzip: boolean;
  namespaces: string[];
  includeSensitive: boolean;
  acknowledgePlaintextSensitive: boolean;
}

export function parseMemoryExportArgs(args: string[], env: NodeJS.ProcessEnv = process.env): MemoryExportCliOptions {
  const options: MemoryExportCliOptions = {
    url: env.TOTAL_RECALL_URL ?? 'http://127.0.0.1:3002',
    apiKey: env.TOTAL_RECALL_API_KEY ?? '',
    output: '-', gzip: false, namespaces: [], includeSensitive: false,
    acknowledgePlaintextSensitive: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--gzip') options.gzip = true;
    else if (arg === '--include-sensitive') options.includeSensitive = true;
    else if (arg === '--acknowledge-plaintext-sensitive') options.acknowledgePlaintextSensitive = true;
    else if (['--url', '--api-key', '--output', '--namespace'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--url') options.url = value;
      if (arg === '--api-key') options.apiKey = value;
      if (arg === '--output') options.output = value;
      if (arg === '--namespace') options.namespaces.push(value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.apiKey.startsWith('tr_')) throw new Error('TOTAL_RECALL_API_KEY or --api-key is required');
  if (options.includeSensitive && !options.acknowledgePlaintextSensitive) {
    throw new Error('--include-sensitive requires --acknowledge-plaintext-sensitive');
  }
  return options;
}

export async function runMemoryExport(options: MemoryExportCliOptions): Promise<void> {
  const endpoint = new URL('/api/transfer/export', options.url);
  for (const namespace of options.namespaces) endpoint.searchParams.append('namespace', namespace);
  if (options.includeSensitive) endpoint.searchParams.set('include_sensitive', 'true');
  if (options.acknowledgePlaintextSensitive) endpoint.searchParams.set('acknowledge_plaintext_sensitive', 'true');
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/x-ndjson' },
  });
  if (!response.ok || !response.body) throw new Error(`Export failed with HTTP ${response.status}`);
  const source = Readable.fromWeb(response.body as any);
  const destination = options.output === '-'
    ? process.stdout
    : createWriteStream(options.output, { flags: 'wx', mode: 0o600 });
  if (options.gzip) await pipeline(source, createGzip(), destination);
  else await pipeline(source, destination);
  console.error('[memory-export] completed');
}

async function main(): Promise<void> {
  await runMemoryExport(parseMemoryExportArgs(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`[memory-export] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
