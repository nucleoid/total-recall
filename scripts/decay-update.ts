import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { connectMaintenanceClient, inventoryNamespaces } from './lib/maintenance-db.js';
import {
  purgeExpiredMemories,
  ttlPurgeBatchSizeFromEnv,
  updateDecayBatchWithClient,
  updateDecayWithClient,
  type DecaySummary,
} from '../src/maintenance.js';

export { purgeExpiredMemories, ttlPurgeBatchSizeFromEnv, updateDecayBatchWithClient, updateDecayWithClient } from '../src/maintenance.js';
export type { DecaySummary, TtlPurgeSummary } from '../src/maintenance.js';

dotenv.config();

export function parseDecayCli(args: string[]): { asOf: string; afterId: string | null; limit: number; apply: boolean } {
  let asOf = '', afterId: string | null = null, limit = 100, apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--as-of') asOf = args[++index] ?? '';
    else if (arg === '--after') afterId = args[++index] ?? '';
    else if (arg === '--limit') limit = Number(args[++index]);
    else if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else throw new Error(`Unknown decay option: ${arg}`);
  }
  if (!asOf) throw new Error('--as-of is required');
  return { asOf, afterId, limit, apply };
}

async function main() {
  const options = parseDecayCli(process.argv.slice(2));
  const { client, identity } = await connectMaintenanceClient();
  try {
    console.log('[decay] Maintenance database', identity);
    const summary = await updateDecayBatchWithClient(client, options);
    console.log('[decay] Bounded logical decay', summary);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[decay] Failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
