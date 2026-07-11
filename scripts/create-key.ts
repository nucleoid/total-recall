import { randomBytes, createHash } from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

function parseArgs() {
  const args = process.argv.slice(2);
  let name = '';
  let namespaces = ['shared'];
  let permissions = ['read', 'write'];
  let maxAccessLevel = 'normal';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) name = args[++i];
    else if (args[i] === '--namespaces' && args[i + 1]) namespaces = args[++i].split(',');
    else if (args[i] === '--permissions' && args[i + 1]) permissions = args[++i].split(',');
    else if (args[i] === '--max-access-level' && args[i + 1]) maxAccessLevel = args[++i];
  }

  if (!name) {
    console.error('Usage: create-key --name <name> [--namespaces ns1,ns2] [--permissions read,write] [--max-access-level normal|sensitive|secret]');
    process.exit(1);
  }

  if (!['normal', 'sensitive', 'secret'].includes(maxAccessLevel)) {
    console.error('--max-access-level must be one of: normal, sensitive, secret');
    process.exit(1);
  }

  return { name, namespaces, permissions, maxAccessLevel };
}

async function main() {
  const { name, namespaces, permissions, maxAccessLevel } = parseArgs();
  const rawKey = 'tr_' + randomBytes(32).toString('hex');
  const keyHash = createHash('sha256').update(rawKey).digest('hex');

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query(
      `INSERT INTO api_keys (key_hash, name, namespaces, permissions, max_access_level)
       VALUES ($1, $2, $3, $4, $5)`,
      [keyHash, name, namespaces, permissions, maxAccessLevel]
    );

    console.log('API key created successfully!');
    console.log(`Name: ${name}`);
    console.log(`Namespaces: ${namespaces.join(', ')}`);
    console.log(`Permissions: ${permissions.join(', ')}`);
    console.log(`Max access level: ${maxAccessLevel}`);
    console.log(`\nKey (save this — it cannot be recovered):\n${rawKey}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
