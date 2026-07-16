import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export interface MemoryImportCliOptions {
  url: string;
  apiKey: string;
  input: string;
  dryRun: boolean;
  gzip: boolean;
  resumeLine: number;
  checkpoint?: string;
}

export function parseMemoryImportArgs(args: string[], env: NodeJS.ProcessEnv = process.env): MemoryImportCliOptions {
  const options: MemoryImportCliOptions = {
    url: env.TOTAL_RECALL_URL ?? 'http://127.0.0.1:3002',
    apiKey: env.TOTAL_RECALL_API_KEY ?? '', input: '-', dryRun: false, gzip: false, resumeLine: 0,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--gzip') options.gzip = true;
    else if (['--url', '--api-key', '--input', '--resume-line', '--checkpoint'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--url') options.url = value;
      if (arg === '--api-key') options.apiKey = value;
      if (arg === '--input') options.input = value;
      if (arg === '--checkpoint') options.checkpoint = value;
      if (arg === '--resume-line') {
        if (!/^\d+$/.test(value)) throw new Error('--resume-line must be a non-negative integer');
        options.resumeLine = Number(value);
      }
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.apiKey.startsWith('tr_')) throw new Error('TOTAL_RECALL_API_KEY or --api-key is required');
  if (!Number.isSafeInteger(options.resumeLine)) throw new Error('--resume-line is outside the supported range');
  return options;
}

export async function runMemoryImport(options: MemoryImportCliOptions): Promise<Record<string, unknown>> {
  const endpoint = new URL('/api/transfer/import', options.url);
  if (options.dryRun) endpoint.searchParams.set('dry_run', 'true');
  const fileIsGzip = options.input !== '-' && options.input.toLowerCase().endsWith('.gz');
  let source: NodeJS.ReadableStream = options.input === '-' ? process.stdin : createReadStream(options.input);
  let contentEncoding = 'identity';

  if (options.resumeLine > 0) {
    if (fileIsGzip) source = source.pipe(createGunzip());
    source = Readable.from(linesAfterCheckpoint(source, options.resumeLine));
    if (options.gzip) {
      source = source.pipe(createGzip());
      contentEncoding = 'gzip';
    }
  } else if (fileIsGzip) {
    // Forward an existing gzip member without buffering or recompression.
    contentEncoding = 'gzip';
  } else if (options.gzip) {
    source = source.pipe(createGzip());
    contentEncoding = 'gzip';
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/x-ndjson',
      'Content-Encoding': contentEncoding,
    },
    body: source as any,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const result = await response.json() as Record<string, unknown>;
  if (options.resumeLine > 0) {
    if (typeof result.last_committed_line === 'number') {
      result.last_committed_line = options.resumeLine + result.last_committed_line - 1;
    }
    if (typeof result.last_committed_record === 'number') {
      result.last_committed_record = Math.max(0, options.resumeLine - 1) + result.last_committed_record;
    }
  }
  if (options.checkpoint) {
    await writeFile(options.checkpoint, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  if (!response.ok) throw new Error(`Import failed with HTTP ${response.status}; last committed line ${String(result.last_committed_line ?? 'none')}`);
  console.error(`[memory-import] inserted=${result.inserted} skipped=${result.skipped} conflicted=${result.conflicted} denied=${result.denied}`);
  return result;
}

async function* linesAfterCheckpoint(source: NodeJS.ReadableStream, resumeLine: number): AsyncGenerator<Buffer> {
  const reader = createInterface({ input: source as NodeJS.ReadableStream & { [Symbol.asyncIterator](): AsyncIterator<any> }, crlfDelay: Infinity });
  let line = 0;
  let manifest: string | undefined;
  for await (const value of reader) {
    line++;
    if (line === 1) {
      manifest = value;
      yield Buffer.from(`${value}\n`, 'utf8');
      continue;
    }
    if (line <= resumeLine) continue;
    yield Buffer.from(`${value}\n`, 'utf8');
  }
  if (manifest === undefined) throw new Error('Import input is empty');
}

async function main(): Promise<void> {
  await runMemoryImport(parseMemoryImportArgs(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`[memory-import] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
