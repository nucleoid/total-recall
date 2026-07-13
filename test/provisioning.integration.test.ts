import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  parseProvisionOptions,
  provisionDatabase,
  type ProvisionClient,
} from '../scripts/provision-db.js';

const ownerUrl = 'postgresql://owner:owner-secret@db.example/custom_name';
const specialPassword = String.raw`quo'te\\雪`;

test('provisioning requires separate owner URL and app password plus an explicit rotation flag', () => {
  assert.throws(() => parseProvisionOptions({}, []), /MIGRATION_DATABASE_URL/i);
  assert.throws(
    () => parseProvisionOptions({ MIGRATION_DATABASE_URL: ownerUrl }, []),
    /APP_DATABASE_PASSWORD/i,
  );
  assert.throws(
    () => parseProvisionOptions({ MIGRATION_DATABASE_URL: ownerUrl, APP_DATABASE_PASSWORD: '   ' }, []),
    /APP_DATABASE_PASSWORD/i,
  );
  assert.throws(
    () => parseProvisionOptions({ MIGRATION_DATABASE_URL: ownerUrl, APP_DATABASE_PASSWORD: 'x' }, ['--unknown']),
    /unknown option/i,
  );

  assert.deepEqual(
    parseProvisionOptions({ MIGRATION_DATABASE_URL: ownerUrl, APP_DATABASE_PASSWORD: specialPassword }, ['--rotate-app-password']),
    { connectionString: ownerUrl, appPassword: specialPassword, rotateAppPassword: true },
  );
});

type Event = { text: string; values?: readonly unknown[] };

function fakeClient(roleExists: boolean): { client: ProvisionClient; events: Event[] } {
  const events: Event[] = [];
  const client: ProvisionClient = {
    async query(text: string, values?: readonly unknown[]) {
      events.push({ text, values });
      if (/pg_advisory_lock/i.test(text)) return { rows: [{ locked: true }], rowCount: 1 };
      if (/FROM pg_roles\s+WHERE rolname = \$1/i.test(text) && !/rolsuper/i.test(text)) {
        return { rows: roleExists ? [{ exists: true }] : [], rowCount: roleExists ? 1 : 0 };
      }
      if (/format\('CREATE ROLE/i.test(text)) {
        return { rows: [{ sql: `CREATE ROLE total_recall_app LOGIN PASSWORD '<redacted-generated>'` }], rowCount: 1 };
      }
      if (/format\('ALTER ROLE/i.test(text)) {
        return { rows: [{ sql: `ALTER ROLE total_recall_app PASSWORD '<redacted-generated>'` }], rowCount: 1 };
      }
      if (/format\('GRANT CONNECT/i.test(text)) {
        return { rows: [{ sql: 'GRANT CONNECT ON DATABASE custom_name TO total_recall_app' }], rowCount: 1 };
      }
      if (/rolsuper/i.test(text)) {
        return {
          rows: [{ rolname: 'total_recall_app', rolcanlogin: true, rolsuper: false, rolbypassrls: false, owned_tables: 0 }],
          rowCount: 1,
        };
      }
      if (/pg_advisory_unlock/i.test(text)) return { rows: [{ unlocked: true }], rowCount: 1 };
      return { rows: [], rowCount: null };
    },
  };
  return { client, events };
}

test('new-role provisioning uses an owner lock and PostgreSQL format with parameterized identifiers and secrets', async () => {
  const { client, events } = fakeClient(false);
  const logs: string[] = [];
  await provisionDatabase(client, { appPassword: specialPassword, rotateAppPassword: false, log: message => logs.push(message) });

  assert.match(events[0].text, /pg_advisory_lock/i);
  const createFormat = events.find(event => /format\('CREATE ROLE/i.test(event.text));
  assert.deepEqual(createFormat?.values, ['total_recall_app', specialPassword]);
  assert.match(events.find(event => /format\('GRANT CONNECT/i.test(event.text))?.text ?? '', /current_database\(\)/i);
  assert.ok(events.some(event => event.text.startsWith('CREATE ROLE total_recall_app')));
  assert.ok(events.some(event => event.text === 'GRANT CONNECT ON DATABASE custom_name TO total_recall_app'));
  assert.match(events.at(-1)?.text ?? '', /pg_advisory_unlock/i);
  assert.doesNotMatch(logs.join('\n'), /owner-secret|quo'te|雪|postgresql:/i);
});

test('rerun preserves the password unless rotation is explicit and verifies least privilege', async () => {
  const preserved = fakeClient(true);
  await provisionDatabase(preserved.client, { appPassword: specialPassword, rotateAppPassword: false });
  assert.equal(preserved.events.some(event => /format\('ALTER ROLE/i.test(event.text)), false);
  assert.equal(preserved.events.some(event => event.text.startsWith('ALTER ROLE')), false);

  const rotated = fakeClient(true);
  await provisionDatabase(rotated.client, { appPassword: specialPassword, rotateAppPassword: true });
  const alterFormat = rotated.events.find(event => /format\('ALTER ROLE/i.test(event.text));
  assert.deepEqual(alterFormat?.values, ['total_recall_app', specialPassword]);
  assert.ok(rotated.events.some(event => event.text.startsWith('ALTER ROLE total_recall_app')));
  assert.ok(rotated.events.some(event => /rolcanlogin[\s\S]*rolbypassrls[\s\S]*owned_tables/i.test(event.text)));
});

test('operator contract documents the coordinated credential rotation without changing API keys', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  assert.equal(packageJson.scripts.provision, 'tsx scripts/provision-db.ts');
  assert.match(env, /^APP_DATABASE_PASSWORD=/m);
  assert.match(readme, /restorable.*backup/is);
  assert.match(readme, /rotate.*password[\s\S]*every DB-backed process[\s\S]*run.*migrat[\s\S]*restart every DB-backed process/is);
  assert.match(readme, /verify.*RLS.*application connectivity/is);
  assert.match(readme, /remove the old secret only after verification/is);
  assert.match(readme, /API keys remain unchanged/i);
  assert.match(readme, /no (?:memory )?(?:backfill|reindex)/i);
  assert.match(readme, /MIGRATION_DATABASE_URL.*owner-only[\s\S]*not.*runtime/is);
});

test('verification rejects an elevated app role or ownership of application tables', async () => {
  const { client } = fakeClient(true);
  const originalQuery = client.query.bind(client);
  client.query = async (text, values) => {
    if (/rolsuper/i.test(text)) {
      return { rows: [{ rolname: 'total_recall_app', rolcanlogin: true, rolsuper: false, rolbypassrls: true, owned_tables: 1 }], rowCount: 1 };
    }
    return originalQuery(text, values);
  };
  await assert.rejects(
    provisionDatabase(client, { appPassword: 'safe', rotateAppPassword: false }),
    /LOGIN.*not superuser.*BYPASSRLS.*own application tables/i,
  );
});
