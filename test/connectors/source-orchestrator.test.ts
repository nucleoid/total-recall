import assert from 'node:assert/strict';
import test from 'node:test';
import { runSourceConnector, type SourceConnectorDefinition } from '../../src/connectors/base.js';
import { setPoolForTesting } from '../../src/db.js';

const context = { apiKeyId: 'key-1', scope: { keyId: 'key-1', namespaces: ['activity'] } };

class FakePool {
  commands: string[] = [];
  readonly updatedAt = new Date('2026-01-01T00:00:00Z');
  inTransaction = false;
  on() {}
  async connect() {
    return {
      query: async (sql: string) => this.query(sql),
      release: () => undefined,
    };
  }
  async query(sql: string) {
    const normalized = sql.trim().split(/\s+/).slice(0, 3).join(' ');
    this.commands.push(normalized);
    if (normalized === 'BEGIN') this.inTransaction = true;
    if (normalized === 'COMMIT' || normalized === 'ROLLBACK') this.inTransaction = false;
    if (sql.includes('pg_try_advisory')) return { rows: [{ acquired: true }], rowCount: 1 };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ released: true }], rowCount: 1 };
    if (sql.includes('SELECT * FROM connector_sync_state')) {
      return {
        rows: [{
          service: 'fixture', source_id: 'good', namespace: 'activity', client_id: 'key-1',
          cursor: null, last_event_at: null, metadata: {}, last_sync_at: null, updated_at: this.updatedAt,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('UPDATE connector_sync_state')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }
}

test('source orchestration isolates failures and atomically orders event persistence before cursor update', { concurrency: false }, async (t) => {
  const pool = new FakePool();
  setPoolForTesting(pool as any);
  t.after(() => setPoolForTesting(null));
  const persisted: string[] = [];
  const connector: SourceConnectorDefinition<string> = {
    service: 'fixture',
    async listSources() {
      return [
        { sourceId: 'good', namespace: 'activity' },
        { sourceId: 'bad', namespace: 'activity' },
      ];
    },
    async fetchPage(source) {
      assert.equal(pool.inTransaction, false, 'provider I/O must run outside a database transaction');
      return { events: [source.sourceId], cursor: `after-${source.sourceId}`, done: true };
    },
    async persistPage(_client, source, events) {
      persisted.push(...events);
      if (source.sourceId === 'bad') throw new Error('fixture persistence failure');
      return { inserted: 1, skipped: 0 };
    },
  };

  const result = await runSourceConnector(connector, context, { maxPagesPerSource: 2 });
  assert.equal(result.status, 'partial_failure');
  assert.deepEqual(result.sources.map((source) => source.status), ['succeeded', 'failed']);
  assert.deepEqual(persisted, ['good', 'bad']);
  assert.equal(pool.commands.filter((command) => command === 'COMMIT').length, 3);
  assert.equal(pool.commands.filter((command) => command === 'ROLLBACK').length, 1);
});

test('dry-run fetches pages without sink or state mutations', { concurrency: false }, async (t) => {
  const pool = new FakePool();
  setPoolForTesting(pool as any);
  t.after(() => setPoolForTesting(null));
  let persists = 0;
  const connector: SourceConnectorDefinition<string> = {
    service: 'fixture',
    async listSources() { return [{ sourceId: 'good', namespace: 'activity' }]; },
    async fetchPage() { return { events: ['event'], cursor: 'after', done: true }; },
    async persistPage() { persists++; return { inserted: 1, skipped: 0 }; },
  };

  const result = await runSourceConnector(connector, context, { dryRun: true });
  assert.equal(result.status, 'dry_run');
  assert.equal(persists, 0);
  assert.equal(pool.commands.some((command) => command.startsWith('INSERT INTO connector_sync_state')), false);
  assert.equal(pool.commands.some((command) => command.startsWith('UPDATE connector_sync_state')), false);
});
