import { pathToFileURL } from 'node:url';
import { ingestionWorkerMain } from '../src/ingestion-worker.js';
export * from '../src/ingestion-worker.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ingestionWorkerMain().catch(() => { console.error('[ingestion-worker] failed; check database and worker configuration'); process.exitCode = 1; });
}
