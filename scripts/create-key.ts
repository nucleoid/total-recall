import { randomBytes, createHash } from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

function parseArgs() {
  const args = process.argv.slice(2);
  let name = '';
  let namespaces = ['shared'];
  let permissions = ['read', 'write'];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) name = args[++i];
    else if (args[i] === '--namespaces' && args[i + 1]) namespaces = args[++i].split(',');
    else if (args[i] === '--permissions' && args[i + 1]) permissions = args[++i].split(',');
  }

  if (!name) {
    console.error('Usage: create-key --name <name> [--namespaces ns1,ns2] [--permissions read,write]');
    process.exit(1);
  }

  return { name, namespaces, permissions };
}

async function main() {
  const { name, namespaces, permissions } = parseArgs();
  const rawKey = 'tr_' + randomBytes(32).toString('hex');
  const keyHash = createHash('sha256').update(rawKey).digest('hex');

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query(
      `INSERT INTO api_keys (key_hash, name, namespaces, permissions)
       VALUES ($1, $2, $3, $4)`,
      [keyHash, name, namespaces, permissions]
    );

    console.log('API key created successfully!');
    console.log(`Name: ${name}`);
    console.log(`Namespaces: ${namespaces.join(', ')}`);
    console.log(`Permissions: ${permissions.join(', ')}`);
    console.log(`\nKey (save this — it cannot be recovered):\n${rawKey}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
