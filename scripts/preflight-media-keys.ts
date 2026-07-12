#!/usr/bin/env node
import dotenv from 'dotenv';
import { preflightMediaConnectorKeys } from '../src/connectors/attribution.js';
import { shutdown } from '../src/db.js';

dotenv.config();

async function main(): Promise<void> {
  const auths = await preflightMediaConnectorKeys();
  for (const auth of auths) {
    console.log(`[preflight:media-keys] ok: ${auth.name} (${auth.keyId})`);
  }
}

main()
  .then(() => shutdown())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[preflight:media-keys] failed:', err.message);
    shutdown().finally(() => process.exit(1));
  });
