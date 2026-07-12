import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { createMediaEventAtIndex } from './repair-media-event-at.js';

dotenv.config();

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const result = await createMediaEventAtIndex({ connectionString });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('media event_at index build failed:', err);
    process.exit(1);
  });
}
