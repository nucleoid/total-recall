import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { connectMaintenanceClient, inventoryNamespaces } from './lib/maintenance-db.js';
import {
  purgeExpiredMemories,
  ttlPurgeBatchSizeFromEnv,
  updateDecayWithClient,
  type DecaySummary,
} from '../src/maintenance.js';

export { purgeExpiredMemories, ttlPurgeBatchSizeFromEnv, updateDecayWithClient } from '../src/maintenance.js';
export type { DecaySummary, TtlPurgeSummary } from '../src/maintenance.js';

dotenv.config();

async function main() {
  const { client, identity } = await connectMaintenanceClient();
  try {
    console.log('[decay] Maintenance database', identity);
    console.log('[decay] Initial namespace inventory', await inventoryNamespaces(client));
    const purge = await purgeExpiredMemories(client, ttlPurgeBatchSizeFromEnv(process.env.TTL_PURGE_BATCH_SIZE));
    console.log('[decay] TTL purge totals', purge);
    const summary: DecaySummary = await updateDecayWithClient(client);
    console.log('[decay] Actual updated totals', summary);
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
