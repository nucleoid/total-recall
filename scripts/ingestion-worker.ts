import { isDirectExecution } from '../src/entrypoint.js';
import { ingestionWorkerMain } from '../src/ingestion-worker.js';
export * from '../src/ingestion-worker.js';

if (isDirectExecution(import.meta.url, process.argv[1])) {
  ingestionWorkerMain().catch(() => { console.error('[ingestion-worker] failed; check database and worker configuration'); process.exitCode = 1; });
}
