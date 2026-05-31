#!/usr/bin/env node
/**
 * One-time Plex authentication via the PIN flow.
 *
 * Headless-friendly: prints a link + 4-char code, you open the link on any
 * device (laptop/phone), enter the code, approve. The script polls until
 * authorization completes, then stores the auth_token in
 * connector_credentials.
 *
 * No env vars required — the PIN flow doesn't need pre-configured OAuth
 * credentials. Plex tracks tokens per X-Plex-Client-Identifier, which we
 * generate once and persist with the credentials.
 */
import dotenv from 'dotenv';
import { pinFlow } from '../src/connectors/plex/auth.js';
import { getAccount, listServers } from '../src/connectors/plex/discovery.js';
import { shutdown } from '../src/db.js';

dotenv.config();

async function main(): Promise<void> {
  console.log('\nPlex authentication');
  console.log('-------------------');
  console.log('Open the link below on any device and enter the 4-character code\n');

  const creds = await pinFlow((link, code) => {
    console.log(`  Link:  ${link}`);
    console.log(`  Code:  ${code}\n`);
    console.log('Waiting for authorization (PIN expires in 25 minutes)...\n');
  });

  console.log('\n✓ Authorized. Storing account + server discovery...\n');

  const account = await getAccount(creds);
  const servers = await listServers(creds);

  console.log(`  Plex account: ${account.username || '(no username)'} (id=${account.id})`);
  console.log(`  Servers accessible: ${servers.length}`);
  for (const s of servers) {
    console.log(`    - ${s.name}  owned=${s.owned}  connections=${s.connections.length}`);
  }
  console.log('\nRun `npm run plex:sync` to verify history retrieval.\n');
}

main()
  .then(() => shutdown())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nPlex auth failed:', err.message);
    shutdown().finally(() => process.exit(1));
  });
