import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import {
  ensureMemoryLifecycleFinalization,
  type MemoryLifecycleFinalizerClient,
} from '../scripts/memory-lifecycle-finalizer.js';

type ConstraintState = { exists: boolean; isValid: boolean; definition?: string | null };
type IndexState = { exists: boolean; isValid: boolean; definition?: string | null };

const constraintDefinitionFor = (name: string): string =>
  name === 'memories_deleted_by_client_id_fkey'
    ? 'FOREIGN KEY (deleted_by_client_id) REFERENCES api_keys(id) ON DELETE SET NULL'
    : 'CHECK ((deletion_reason IS NULL) OR (char_length(deletion_reason) <= 512))';

const indexDefinitionFor = (name: string): string => name === 'memories_active_namespace_created_idx'
  ? 'CREATE INDEX memories_active_namespace_created_idx ON public.memories USING btree (namespace, created_at DESC) WHERE (deleted_at IS NULL)'
  : 'CREATE INDEX memories_deleted_purge_idx ON public.memories USING btree (deleted_at, id) WHERE (deleted_at IS NOT NULL)';

class FakeFinalizerClient implements MemoryLifecycleFinalizerClient {
  readonly queries: string[] = [];
  failValidation?: string;

  constructor(
    readonly constraints: Map<string, ConstraintState>,
    readonly indexes: Map<string, IndexState> = new Map()
  ) {}

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[] }> {
    const normalized = text.replace(/\s+/g, ' ').trim();
    this.queries.push(normalized);

    if (normalized.includes('FROM pg_constraint c')) {
      const name = String(values?.[0]);
      const state = this.constraints.get(name) ?? { exists: false, isValid: false };
      if (!state.exists) return { rows: [] };
      return {
        rows: [{
          isValid: state.isValid,
          definition: state.definition ?? constraintDefinitionFor(name),
        } as unknown as T],
      };
    }

    const validated = normalized.match(/ALTER TABLE public\.memories VALIDATE CONSTRAINT (\w+)/i)?.[1];
    if (validated) {
      if (this.failValidation === validated) throw new Error(`invalid existing rows for ${validated}`);
      const state = this.constraints.get(validated);
      if (!state?.exists) throw new Error(`missing constraint ${validated}`);
      state.isValid = true;
      return { rows: [] };
    }

    if (normalized.includes('FROM pg_class c')) {
      const name = String(values?.[0]);
      const state = this.indexes.get(name) ?? { exists: false, isValid: false };
      return {
        rows: [{
          ...state,
          definition: state.exists ? (state.definition ?? indexDefinitionFor(name)) : null,
        } as unknown as T],
      };
    }

    const dropped = normalized.match(/DROP INDEX CONCURRENTLY IF EXISTS public\.(\w+)/i)?.[1];
    if (dropped) {
      this.indexes.set(dropped, { exists: false, isValid: false, definition: null });
      return { rows: [] };
    }

    const created = normalized.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS (\w+)/i)?.[1];
    if (created) {
      this.indexes.set(created, { exists: true, isValid: true, definition: indexDefinitionFor(created) });
      return { rows: [] };
    }

    throw new Error(`unexpected query: ${normalized}`);
  }
}

function unvalidatedConstraints(): Map<string, ConstraintState> {
  return new Map([
    ['memories_deleted_by_client_id_fkey', { exists: true, isValid: false }],
    ['memories_deletion_reason_length', { exists: true, isValid: false }],
  ]);
}

test('memory lifecycle finalizer validates constraints and builds indexes without opening a transaction', async () => {
  const client = new FakeFinalizerClient(unvalidatedConstraints());

  const first = await ensureMemoryLifecycleFinalization(client);
  assert.deepEqual(first.constraints.map(constraint => [
    constraint.constraintName,
    constraint.validated,
    constraint.constraintValid,
  ]), [
    ['memories_deleted_by_client_id_fkey', true, true],
    ['memories_deletion_reason_length', true, true],
  ]);
  assert.equal(first.indexes.every(index => index.created && index.indexValid), true);
  assert.equal(client.queries.some(query => /^(?:BEGIN|COMMIT|ROLLBACK)$/i.test(query)), false);
  assert.deepEqual(
    client.queries.filter(query => /VALIDATE CONSTRAINT/i.test(query)),
    [
      'ALTER TABLE public.memories VALIDATE CONSTRAINT memories_deleted_by_client_id_fkey',
      'ALTER TABLE public.memories VALIDATE CONSTRAINT memories_deletion_reason_length',
    ]
  );

  const retry = await ensureMemoryLifecycleFinalization(client);
  assert.deepEqual(retry.constraints.map(constraint => constraint.validated), [false, false]);
  assert.deepEqual(retry.indexes.map(index => index.created), [false, false]);
  assert.equal(retry.constraints.every(constraint => constraint.constraintValid), true);
  assert.equal(retry.indexes.every(index => index.indexValid), true);
});

test('memory lifecycle finalizer resumes after a validation failure committed earlier progress', async () => {
  const client = new FakeFinalizerClient(unvalidatedConstraints());
  client.failValidation = 'memories_deletion_reason_length';

  await assert.rejects(
    ensureMemoryLifecycleFinalization(client),
    /invalid existing rows for memories_deletion_reason_length/
  );
  assert.equal(client.constraints.get('memories_deleted_by_client_id_fkey')?.isValid, true);
  assert.equal(client.constraints.get('memories_deletion_reason_length')?.isValid, false);
  assert.equal(client.indexes.size, 0);

  client.failValidation = undefined;
  const retry = await ensureMemoryLifecycleFinalization(client);
  assert.deepEqual(retry.constraints.map(constraint => constraint.validated), [false, true]);
  assert.equal(retry.indexes.every(index => index.created && index.indexValid), true);
});

test('memory lifecycle finalizer refuses missing or unexpected same-name constraints', async () => {
  const missing = unvalidatedConstraints();
  missing.delete('memories_deleted_by_client_id_fkey');
  await assert.rejects(
    ensureMemoryLifecycleFinalization(new FakeFinalizerClient(missing)),
    /constraint memories_deleted_by_client_id_fkey is missing; run npm run migrate first/
  );

  const wrong = unvalidatedConstraints();
  wrong.set('memories_deleted_by_client_id_fkey', {
    exists: true,
    isValid: false,
    definition: 'FOREIGN KEY (deleted_by_client_id) REFERENCES other_table(id)',
  });
  await assert.rejects(
    ensureMemoryLifecycleFinalization(new FakeFinalizerClient(wrong)),
    /unexpected definition; refusing to validate/
  );
});

test('memory lifecycle finalizer refuses a valid same-name index with the wrong definition', async () => {
  const constraints = unvalidatedConstraints();
  for (const state of constraints.values()) state.isValid = true;
  const client = new FakeFinalizerClient(constraints, new Map([
    ['memories_active_namespace_created_idx', {
      exists: true,
      isValid: true,
      definition: 'CREATE INDEX memories_active_namespace_created_idx ON public.other_table USING btree (namespace)',
    }],
  ]));

  await assert.rejects(
    ensureMemoryLifecycleFinalization(client),
    /exists with an unexpected definition; refusing to replace a valid index/
  );
  assert.equal(client.queries.some(query => query.startsWith('CREATE INDEX')), false);
});

test('memory lifecycle finalizer drops invalid concurrent-build leftovers before rebuilding', async () => {
  const constraints = unvalidatedConstraints();
  for (const state of constraints.values()) state.isValid = true;
  const client = new FakeFinalizerClient(constraints, new Map([
    ['memories_active_namespace_created_idx', { exists: true, isValid: false }],
    ['memories_deleted_purge_idx', { exists: true, isValid: false }],
  ]));

  const result = await ensureMemoryLifecycleFinalization(client);

  assert.equal(result.indexes.every(index => index.created && index.indexValid), true);
  assert.ok(client.queries.includes(
    'DROP INDEX CONCURRENTLY IF EXISTS public.memories_active_namespace_created_idx'
  ));
  assert.ok(client.queries.includes(
    'DROP INDEX CONCURRENTLY IF EXISTS public.memories_deleted_purge_idx'
  ));
});
