import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { finalizeMemoryLifecycle } from './memory-lifecycle-finalizer.js';

dotenv.config();

async function main() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) {
    throw new Error('MIGRATION_DATABASE_URL is required');
  }

  const result = await finalizeMemoryLifecycle({ connectionString });
  const allValid =
    result.constraints.every(constraint => constraint.constraintValid) &&
    result.indexes.every(index => index.indexValid);
  console.log(JSON.stringify({ ...result, allValid }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('memory lifecycle finalization failed:', err);
    process.exit(1);
  });
}
