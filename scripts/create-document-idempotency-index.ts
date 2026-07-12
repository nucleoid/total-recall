import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { createDocumentIdempotencyIndex } from './document-idempotency-index.js';

dotenv.config();

async function main() {
  const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
  }

  const result = await createDocumentIdempotencyIndex({ connectionString });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('document idempotency index build failed:', err);
    process.exit(1);
  });
}
