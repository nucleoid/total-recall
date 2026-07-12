import assert from 'node:assert/strict';
import test from 'node:test';
import { DECAY_SCOPE, updateDecayWithClient } from '../scripts/decay-update.js';
import {
  resolveMaintenanceDatabaseUrl,
  verifyAllRowMaintenanceRole,
} from '../scripts/maintenance-database.js';

test('decay update materializes from stable base and is idempotent with unchanged facts', async () => {
  const queries: string[] = [];
  const rows = [
    { maintenance_ready: true, relevance_score: 1.1 },
    { maintenance_ready: true, relevance_score: 1.1 },
  ];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      return { rows, rowCount: rows.length };
    },
  };

  const first = await updateDecayWithClient(client as never);
  const second = await updateDecayWithClient(client as never);
  assert.deepEqual(first, second);
  assert.match(queries[0], /calculate_relevance\(relevance_base_score, decay_rate, accessed_at, access_count\)/);
  assert.doesNotMatch(queries[0], /calculate_relevance\(relevance_score/);
  assert.match(queries[0], /NOT EXISTS[\s\S]*relevance_base_score IS NULL/i);
});

test('decay fails closed without updating when any base remains unclassified', async () => {
  const client = {
    async query() {
      return { rows: [{ maintenance_ready: false, relevance_score: null }], rowCount: 1 };
    },
  };

  await assert.rejects(updateDecayWithClient(client as never), /unclassified relevance base/i);
});

test('maintenance uses an explicit owner-capable URL and never falls back to the app role', () => {
  assert.equal(resolveMaintenanceDatabaseUrl({
    MAINTENANCE_DATABASE_URL: 'postgres://maintenance',
    MIGRATION_DATABASE_URL: 'postgres://migration-owner',
    DATABASE_URL: 'postgres://runtime-app',
  }), 'postgres://maintenance');
  assert.equal(resolveMaintenanceDatabaseUrl({
    MIGRATION_DATABASE_URL: 'postgres://migration-owner',
    DATABASE_URL: 'postgres://runtime-app',
  }), 'postgres://migration-owner');
  assert.throws(() => resolveMaintenanceDatabaseUrl({
    DATABASE_URL: 'postgres://runtime-app',
  }), /MAINTENANCE_DATABASE_URL/);
});

test('maintenance role verification accepts superusers and inherited table ownership', async () => {
  let verificationSql = '';
  const client = {
    async query(sql: string) {
      verificationSql = sql;
      return {
        rows: [{
          all_rows: /rolsuper/i.test(sql) && /pg_has_role\s*\(/i.test(sql),
        }],
      };
    },
  };

  await verifyAllRowMaintenanceRole(client);
  assert.match(verificationSql, /rolbypassrls/i);
});

test('decay maintenance includes every currently supported namespace', () => {
  assert.deepEqual(DECAY_SCOPE.namespaces, ['personal', 'work', 'projects', 'financial', 'shared', 'media']);
  assert.equal(DECAY_SCOPE.isAdmin, true);
});
