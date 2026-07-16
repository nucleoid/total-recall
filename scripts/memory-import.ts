import dotenv from 'dotenv';
import { createReadStream, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';

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
  const input = option(args, '--input') ?? '-';
  const checkpoint = option(args, '--checkpoint');
  const explicitResume = option(args, '--resume-after');
  const resume = explicitResume ?? (checkpoint && existsSync(checkpoint) ? readFileSync(checkpoint, 'utf8').trim() : '0');
  if (!/^\d+$/.test(resume)) throw new Error('resume checkpoint must contain one non-negative record number');
  const batch = option(args, '--batch-size') ?? '25';
  const query = new URLSearchParams({ resume_after: resume, batch_size: batch });
  if (args.includes('--dry-run')) query.set('dry_run', 'true');
  const body: Readable = input === '-' ? process.stdin : createReadStream(input);
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/transfer/import?${query}`, {
    method: 'POST', duplex: 'half', body: body as any,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-ndjson',
      'Content-Encoding': args.includes('--gzip') ? 'gzip' : 'identity',
    },
  } as RequestInit & { duplex: 'half' });
  const text = await response.text();
  let result: Record<string, unknown>;
  try { result = JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(`Import failed (${response.status}) with a non-JSON response`); }
  if (checkpoint && !args.includes('--dry-run') && typeof result.next_record === 'number') {
    const temporary = `${checkpoint}.tmp-${process.pid}`;
    writeFileSync(temporary, `${result.next_record}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, checkpoint);
  }
  if (!response.ok) throw new Error(`Import failed (${response.status}): ${String(result.error ?? result.code ?? 'unknown error')}; resume after ${String(result.next_record ?? resume)}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  console.error('[memory-import] completed; destination vectors were regenerated with the active embedding profile');
}

main().catch(error => {
  console.error(`[memory-import] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
