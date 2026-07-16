import dotenv from 'dotenv';
import { createWriteStream, openSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

dotenv.config();

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baseUrl = option(args, '--url') ?? process.env.TOTAL_RECALL_URL ?? 'http://127.0.0.1:3002';
  const apiKey = option(args, '--api-key') ?? process.env.TOTAL_RECALL_API_KEY;
  if (!apiKey) throw new Error('TOTAL_RECALL_API_KEY or --api-key is required');
  const output = option(args, '--output') ?? '-';
  const gzip = args.includes('--gzip');
  const query = new URLSearchParams();
  const namespaces = option(args, '--namespaces');
  if (namespaces) query.set('namespaces', namespaces);
  if (args.includes('--include-protected')) query.set('include_protected', 'true');
  if (args.includes('--acknowledge-plaintext')) query.set('acknowledge_plaintext', 'true');
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/transfer/export?${query}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/x-ndjson' },
  });
  if (!response.ok || !response.body) throw new Error(`Export failed (${response.status}): ${await response.text()}`);

  const source = Readable.fromWeb(response.body as any);
  const destination = output === '-'
    ? process.stdout
    : createWriteStream(output, { fd: openSync(output, 'wx', 0o600), autoClose: true });
  if (gzip) await pipeline(source, createGzip(), destination);
  else await pipeline(source, destination);
  console.error(`[memory-export] completed${output === '-' ? '' : `: ${output}`}; V1 is a memory-only feed, not a faithful backup`);
}

main().catch(error => {
  console.error(`[memory-export] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
