import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import {
  ensureMemorySupersessionFinalization,
  type MemorySupersessionFinalizerClient,
} from '../scripts/memory-supersession-finalizer.js';

type ConstraintState = { exists: boolean; isValid: boolean; definition?: string | null };
type IndexState = { exists: boolean; isValid: boolean; definition?: string | null };

const constraintDefinitionFor = (name: string): string =>
  name === 'memories_supersedes_not_self'
    ? 'CHECK ((supersedes_id IS NULL) OR (supersedes_id <> id))'
    : 'FOREIGN KEY (supersedes_id) REFERENCES memories(id) ON DELETE RESTRICT';

const indexDefinitionFor = (name: string): string => name === 'memories_supersedes_id_unique'
  ? 'CREATE UNIQUE INDEX memories_supersedes_id_unique ON public.memories USING btree (supersedes_id)'
  : 'CREATE INDEX memories_superseded_at_idx ON public.memories USING btree (superseded_at) WHERE (superseded_at IS NOT NULL)';

class FakeFinalizerClient implements MemorySupersessionFinalizerClient {
  readonly queries: string[] = [];
  failValidation?: string;

  constructor(
    readonly constraints: Map<string, ConstraintState>,
    readonly indexes: Map<string, IndexState> = new Map(),
  ) {}

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
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

    const created = normalized.match(/CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS (\w+)/i)?.[1];
    if (created) {
      this.indexes.set(created, { exists: true, isValid: true, definition: indexDefinitionFor(created) });
      return { rows: [] };
    }

    throw new Error(`unexpected query: ${normalized}`);
  }
}

function unvalidatedConstraints(): Map<string, ConstraintState> {
  return new Map([
    ['memories_supersedes_not_self', { exists: true, isValid: false }],
    ['memories_supersedes_id_fkey', { exists: true, isValid: false }],
  ]);
}

test('memory supersession finalizer validates constraints and builds indexes without a transaction', async () => {
  const client = new FakeFinalizerClient(unvalidatedConstraints());

  const first = await ensureMemorySupersessionFinalization(client);
  assert.deepEqual(first.constraints.map(row => [row.constraintName, row.validated, row.constraintValid]), [
    ['memories_supersedes_not_self', true, true],
    ['memories_supersedes_id_fkey', true, true],
  ]);
  assert.equal(first.indexes.every(index => index.created && index.indexValid), true);
  assert.equal(client.queries.some(query => /^(?:BEGIN|COMMIT|ROLLBACK)$/i.test(query)), false);

  const retry = await ensureMemorySupersessionFinalization(client);
  assert.deepEqual(retry.constraints.map(row => row.validated), [false, false]);
  assert.deepEqual(retry.indexes.map(row => row.created), [false, false]);
  assert.equal(retry.constraints.every(row => row.constraintValid), true);
  assert.equal(retry.indexes.every(row => row.indexValid), true);
});

test('memory supersession finalizer resumes after partial validation', async () => {
  const client = new FakeFinalizerClient(unvalidatedConstraints());
  client.failValidation = 'memories_supersedes_id_fkey';

  await assert.rejects(
    ensureMemorySupersessionFinalization(client),
    /invalid existing rows for memories_supersedes_id_fkey/,
  );
  assert.equal(client.constraints.get('memories_supersedes_not_self')?.isValid, true);
  assert.equal(client.constraints.get('memories_supersedes_id_fkey')?.isValid, false);
  assert.equal(client.indexes.size, 0);

  client.failValidation = undefined;
  const retry = await ensureMemorySupersessionFinalization(client);
  assert.deepEqual(retry.constraints.map(row => row.validated), [false, true]);
  assert.equal(retry.indexes.every(row => row.created && row.indexValid), true);
});

test('memory supersession finalizer refuses missing or unexpected constraints', async () => {
  const missing = unvalidatedConstraints();
  missing.delete('memories_supersedes_not_self');
  await assert.rejects(
    ensureMemorySupersessionFinalization(new FakeFinalizerClient(missing)),
    /constraint memories_supersedes_not_self is missing; run npm run migrate first/,
  );

  const wrong = unvalidatedConstraints();
  wrong.set('memories_supersedes_id_fkey', {
    exists: true,
    isValid: false,
    definition: 'FOREIGN KEY (supersedes_id) REFERENCES other_table(id)',
  });
  await assert.rejects(
    ensureMemorySupersessionFinalization(new FakeFinalizerClient(wrong)),
    /unexpected definition; refusing to validate/,
  );
});

test('memory supersession finalizer refuses a wrong valid same-name index', async () => {
  const constraints = unvalidatedConstraints();
  for (const state of constraints.values()) state.isValid = true;
  const client = new FakeFinalizerClient(constraints, new Map([
    ['memories_supersedes_id_unique', {
      exists: true,
      isValid: true,
      definition: 'CREATE INDEX memories_supersedes_id_unique ON public.memories USING btree (supersedes_id)',
    }],
  ]));

  await assert.rejects(
    ensureMemorySupersessionFinalization(client),
    /exists with an unexpected definition; refusing to replace a valid index/,
  );
  assert.equal(client.queries.some(query => query.startsWith('CREATE')), false);
});

test('memory supersession finalizer repairs invalid concurrent-build leftovers', async () => {
  const constraints = unvalidatedConstraints();
  for (const state of constraints.values()) state.isValid = true;
  const client = new FakeFinalizerClient(constraints, new Map([
    ['memories_supersedes_id_unique', { exists: true, isValid: false }],
    ['memories_superseded_at_idx', { exists: true, isValid: false }],
  ]));

  const result = await ensureMemorySupersessionFinalization(client);
  assert.equal(result.indexes.every(index => index.created && index.indexValid), true);
  assert.ok(client.queries.includes(
    'DROP INDEX CONCURRENTLY IF EXISTS public.memories_supersedes_id_unique',
  ));
  assert.ok(client.queries.includes(
    'DROP INDEX CONCURRENTLY IF EXISTS public.memories_superseded_at_idx',
  ));
});
