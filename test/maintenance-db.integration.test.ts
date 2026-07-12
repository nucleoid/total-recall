import assert from 'node:assert/strict';
import test from 'node:test';
import {
  connectMaintenanceClient,
  inventoryNamespaces,
  prepareAllRowMaintenance,
  resolveMaintenanceDatabaseUrl,
} from '../scripts/lib/maintenance-db.js';

test('maintenance URL uses maintenance, migration, then deprecated owner fallback and never the runtime role', () => {
  const warnings: string[] = [];
  assert.equal(resolveMaintenanceDatabaseUrl({
    MAINTENANCE_DATABASE_URL: 'postgres://maintenance/custom-db',
    MIGRATION_DATABASE_URL: 'postgres://migration/custom-db',
    OWNER_DATABASE_URL: 'postgres://legacy/custom-db',
    DATABASE_URL: 'postgres://app/runtime',
  }, warning => warnings.push(warning)), 'postgres://maintenance/custom-db');
  assert.equal(resolveMaintenanceDatabaseUrl({
    MAINTENANCE_DATABASE_URL: '  ',
    MIGRATION_DATABASE_URL: 'postgres://migration/custom-db',
    OWNER_DATABASE_URL: 'postgres://legacy/custom-db',
    DATABASE_URL: 'postgres://app/runtime',
  }, warning => warnings.push(warning)), 'postgres://migration/custom-db');
  assert.equal(resolveMaintenanceDatabaseUrl({
    OWNER_DATABASE_URL: 'postgres://legacy/custom-db',
    DATABASE_URL: 'postgres://app/runtime',
  }, warning => warnings.push(warning)), 'postgres://legacy/custom-db');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /OWNER_DATABASE_URL.*deprecated.*MIGRATION_DATABASE_URL/i);
  assert.throws(
    () => resolveMaintenanceDatabaseUrl({ DATABASE_URL: 'postgres://app/runtime' }),
    /MAINTENANCE_DATABASE_URL.*MIGRATION_DATABASE_URL.*OWNER_DATABASE_URL/i,
  );
});

test('preflight disables RLS and proves table visibility on the same session without namespace GUCs', async () => {
  const sql: string[] = [];
  const client = {
    async query(statement: string) {
      sql.push(statement);
      if (/current_database/i.test(statement)) return { rows: [{ database: 'custom-db', user: 'owner', server: 'db:5432' }] };
      return { rows: [{ count: '0' }] };
    },
  };
  const identity = await prepareAllRowMaintenance(client as never);
  assert.equal(identity.database, 'custom-db');
  assert.match(sql[0], /SET\s+row_security\s*=\s*off/i);
  assert.ok(sql.some(statement => /FROM public\.memories/i.test(statement)));
  assert.ok(sql.every(statement => !/set_config|allowed_namespaces/i.test(statement)));
});

test('an RLS-limited app role fails closed during preflight', async () => {
  const client = {
    async query(statement: string) {
      if (/SET\s+row_security/i.test(statement)) return { rows: [] };
      if (/FROM public\.memories/i.test(statement)) throw new Error('query would be affected by row-level security policy');
      return { rows: [{ database: 'db', user: 'app', server: 'db:5432' }] };
    },
  };
  await assert.rejects(prepareAllRowMaintenance(client as never), /all-row maintenance preflight failed/i);
});

test('namespace inventory treats unusual and future names as data', async () => {
  const client = { async query() { return { rows: [
    { namespace: 'media', count: '2' },
    { namespace: 'future, odd', count: '1' },
  ] }; } };
  assert.deepEqual(await inventoryNamespaces(client as never), [
    { namespace: 'media', count: 2 },
    { namespace: 'future, odd', count: 1 },
  ]);
});

test('connection failures still close the dedicated maintenance client', async () => {
  let closed = 0;
  const client = {
    async connect() { throw new Error('connection setup failed'); },
    async end() { closed++; },
  };

  await assert.rejects(
    connectMaintenanceClient(
      { MAINTENANCE_DATABASE_URL: 'postgres://owner/db' },
      (() => client) as never,
    ),
    /connection setup failed/,
  );
  assert.equal(closed, 1);
});
