import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import {
  finalizeMemoryValidity,
  type ValidityFinalizerClient,
} from '../scripts/finalize-memory-validity.js';

type IndexState = { valid: boolean; ready: boolean; definition: string };

const initialConstraints = () => new Map<string, boolean>([
  ['memories_memory_kind_check', false],
  ['memories_supersedes_not_self', false],
  ['memories_supersedes_id_fkey', false],
]);

class FakeClient implements ValidityFinalizerClient {
  readonly queries: string[] = [];
  readonly constraints = initialConstraints();
  readonly indexes = new Map<string, IndexState>();
  duplicatePredecessors = 0;

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }> {
    const sql = text.replace(/\s+/g, ' ').trim();
    this.queries.push(sql);

    if (sql.includes('duplicatePredecessors')) {
      return { rows: [{
        missing: '0', invalid: '0', mismatched: '0',
        duplicatePredecessors: String(this.duplicatePredecessors),
      } as unknown as T] };
    }
    if (sql.includes('FROM pg_class index_relation')) {
      const state = this.indexes.get(String(values?.[0]));
      return { rows: state ? [state as unknown as T] : [] };
    }
    const dropped = sql.match(/DROP INDEX CONCURRENTLY IF EXISTS public\.(\w+)/i)?.[1];
    if (dropped) {
      this.indexes.delete(dropped);
      return { rows: [] };
    }
    const created = sql.match(/CREATE (UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS (\w+)/i);
    if (created) {
      const [, unique, name] = created;
      const definition = name === 'memories_supersedes_id_unique_idx'
        ? `CREATE ${unique ?? ''}INDEX ${name} ON public.memories USING btree (supersedes_id)`
        : name === 'memories_current_semantic_candidates_idx'
          ? `CREATE INDEX ${name} ON public.memories USING btree (namespace, access_level, id) WHERE deleted_at IS NULL AND superseded_at IS NULL AND valid_to IS NULL AND memory_kind = 'semantic'`
          : `CREATE INDEX ${name} ON public.memories USING btree (namespace, valid_from, valid_to) WHERE deleted_at IS NULL`;
      this.indexes.set(name, { valid: true, ready: true, definition });
      return { rows: [] };
    }
    if (sql.startsWith('DO $$ BEGIN')) {
      if (sql.includes('memories_validity_interval_check')) this.constraints.set('memories_validity_interval_check', false);
      if (sql.includes('memories_valid_from_present')) this.constraints.set('memories_valid_from_present', false);
      if (sql.includes('memories_validity_supersession_check')) this.constraints.set('memories_validity_supersession_check', false);
      return { rows: [] };
    }
    if (sql.includes('FROM pg_constraint c')) {
      const name = String(values?.[0]);
      return { rows: [{ exists: this.constraints.has(name), valid: this.constraints.get(name) ?? false } as unknown as T] };
    }
    const validated = sql.match(/VALIDATE CONSTRAINT (\w+)/i)?.[1];
    if (validated) {
      this.constraints.set(validated, true);
      return { rows: [] };
    }
    if (sql === 'ALTER TABLE public.memories ALTER COLUMN valid_from SET NOT NULL') return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  }
}

test('validity finalizer builds unique supersession index concurrently before validation', async () => {
  const client = new FakeClient();
  await finalizeMemoryValidity(client);

  const createUnique = client.queries.findIndex(query =>
    query.startsWith('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS memories_supersedes_id_unique_idx'));
  const firstValidation = client.queries.findIndex(query => query.includes('VALIDATE CONSTRAINT'));
  assert.ok(createUnique >= 0);
  assert.ok(firstValidation > createUnique);
  assert.equal(client.queries.some(query => /^(BEGIN|COMMIT|ROLLBACK)$/i.test(query)), false);
  assert.equal(client.constraints.get('memories_valid_from_present'), true);
  assert.equal(client.constraints.get('memories_validity_supersession_check'), true);

  await finalizeMemoryValidity(client);
  assert.equal(client.queries.filter(query =>
    query.startsWith('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS memories_supersedes_id_unique_idx')).length, 2);
});

test('validity finalizer rejects duplicate predecessors before schema changes', async () => {
  const client = new FakeClient();
  client.duplicatePredecessors = 1;

  await assert.rejects(finalizeMemoryValidity(client), /duplicate_predecessors=1/);
  assert.equal(client.queries.some(query => query.includes('CREATE UNIQUE INDEX')), false);
  assert.equal(client.constraints.has('memories_valid_from_present'), false);
});

test('validity finalizer repairs an invalid concurrent unique-index leftover', async () => {
  const client = new FakeClient();
  client.indexes.set('memories_supersedes_id_unique_idx', {
    valid: false,
    ready: false,
    definition: 'CREATE UNIQUE INDEX memories_supersedes_id_unique_idx ON public.memories USING btree (supersedes_id)',
  });

  await finalizeMemoryValidity(client);
  assert.ok(client.queries.includes(
    'DROP INDEX CONCURRENTLY IF EXISTS public.memories_supersedes_id_unique_idx',
  ));
});
