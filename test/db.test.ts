import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import { setPoolForTesting, withScopedClient } from '../src/db.js';

type QueryCall = { text: string; params?: unknown[] };

class FakeClient {
  readonly calls: QueryCall[] = [];
  releaseArgs: unknown[] | undefined;
  failOn = new Map<string, Error>();

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<pg.QueryResult<T>> {
    this.calls.push({ text, params });
    const failure = this.failOn.get(text);
    if (failure) throw failure;
    return { command: 'SELECT', rowCount: 0, oid: 0, fields: [], rows: [] };
  }

  release(err?: Error): void {
    this.releaseArgs = err ? [err] : [];
  }
}

class FakePool {
  constructor(readonly client: FakeClient) {}
  async connect(): Promise<FakeClient> { return this.client; }
}

const scope = { namespaces: ['projects'], keyId: 'watcher' };

test.afterEach(() => setPoolForTesting(null));

test('scoped transactions clear inherited namespace authority before BEGIN and leave none after commit', async () => {
  const client = new FakeClient();
  setPoolForTesting(new FakePool(client) as unknown as pg.Pool);

  await withScopedClient(scope, async (checkedOut) => {
    assert.equal(checkedOut, client);
    await checkedOut.query('INSERT mutation');
  });

  assert.deepEqual(client.calls.map(({ text }) => text), [
    "SELECT set_config('app.allowed_namespaces', '', false)",
    'BEGIN',
    "SELECT set_config('app.allowed_namespaces', $1, true)",
    "SELECT set_config('app.current_key_id', $1, true)",
    "SELECT set_config('app.current_key_is_admin', $1, true)",
    'INSERT mutation',
    'COMMIT',
  ]);
  assert.equal(client.calls[2].params?.[0], JSON.stringify(['projects']));
  assert.deepEqual(client.releaseArgs, []);
});

test('scoped transactions reject namespace values that could widen legacy comma-delimited RLS', async () => {
  for (const namespace of ['', '  ', 'personal,projects']) {
    const client = new FakeClient();
    setPoolForTesting(new FakePool(client) as unknown as pg.Pool);
    await assert.rejects(
      () => withScopedClient({ ...scope, namespaces: [namespace] }, async () => undefined),
      /namespace/i
    );
    assert.equal(client.calls.length, 0);
  }
});

test('callback failure preserves the primary error, records rollback failure, and destroys the client', async () => {
  const client = new FakeClient();
  const rollbackFailure = new Error('rollback transport failed');
  client.failOn.set('ROLLBACK', rollbackFailure);
  setPoolForTesting(new FakePool(client) as unknown as pg.Pool);
  const primary = new Error('second upsert failed');

  let caught: Error | undefined;
  try {
    await withScopedClient(scope, async () => { throw primary; });
  } catch (error) {
    caught = error as Error;
  }

  assert.equal(caught, primary);
  assert.equal((caught as Error & { rollbackError?: Error }).rollbackError, rollbackFailure);
  assert.equal(client.calls.at(-1)?.text, 'ROLLBACK');
  assert.equal(client.releaseArgs?.[0], primary);
});

test('non-Error callback throws preserve rollback diagnostics on the normalized error', async () => {
  const client = new FakeClient();
  const rollbackFailure = new Error('rollback transport failed');
  client.failOn.set('ROLLBACK', rollbackFailure);
  setPoolForTesting(new FakePool(client) as unknown as pg.Pool);

  let caught: unknown;
  try {
    await withScopedClient(scope, async () => { throw 'string failure'; });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof Error);
  assert.equal(caught.message, 'string failure');
  assert.equal((caught as Error & { rollbackError?: Error }).rollbackError, rollbackFailure);
  assert.equal(client.releaseArgs?.[0], caught);
});

test('setup and commit failures destroy clients whose transaction state is uncertain', async () => {
  for (const statement of ['BEGIN', 'COMMIT']) {
    const client = new FakeClient();
    const failure = new Error(`${statement} connection lost`);
    client.failOn.set(statement, failure);
    setPoolForTesting(new FakePool(client) as unknown as pg.Pool);

    await assert.rejects(() => withScopedClient(scope, async () => undefined), failure);
    assert.equal(client.releaseArgs?.[0], failure);
  }
});
