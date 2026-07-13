#!/usr/bin/env node
import dotenv from 'dotenv';
import { YtmusicConnector } from '../src/connectors/ytmusic/connector.js';
import { preflightMediaConnectorKeys } from '../src/connectors/attribution.js';
import { shutdown } from '../src/db.js';

dotenv.config();

async function main(): Promise<void> {
  const [auth] = await preflightMediaConnectorKeys();
  const scope = { keyId: auth.keyId, namespaces: auth.namespaces };
  const connector = new YtmusicConnector();
  const preview = await connector.previewRecovery({ apiKeyId: auth.keyId, scope });

  console.log(JSON.stringify(preview, null, 2));
}

main()
  .then(() => shutdown())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`ytmusic-preview-recovery failed: ${err?.message ?? String(err)}`);
    shutdown().finally(() => process.exit(1));
  });
