import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import {
  type DbScope,
  queryScoped,
  setPoolForTesting,
  withScopedClient,
} from '../src/db.js';

type QueryCall = { text: string; params?: unknown[] };

class FakeClient {
  readonly calls: QueryCall[] = [];
  releaseArgs: unknown[] | undefined;
  failOnCommit = false;

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<pg.QueryResult<T>> {
    this.calls.push({ text, params });
    if (this.failOnCommit && text === 'COMMIT') {
      throw new Error('commit failed');
    }
    return {
      command: 'SELECT',
      rowCount: 0,
      oid: 0,
      fields: [],
      rows: [],
    };
  }

  release(err?: Error): void {
    this.releaseArgs = err ? [err] : [];
  }
}

class FakePool {
  constructor(private readonly client: FakeClient) {}

  async connect(): Promise<FakeClient> {
    return this.client;
  }
}

test('queryScoped wraps protected SQL in a transaction-local namespace/key scope', async () => {
  const client = new FakeClient();
  setPoolForTesting(new FakePool(client) as unknown as pg.Pool);

  const scope: DbScope = { namespaces: ['financial,quarterly', 'shared'], keyId: 'key-1', isAdmin: true };
  await queryScoped(scope, 'SELECT * FROM memories WHERE namespace = ANY($1)', [['shared']]);

  assert.deepEqual(
    client.calls.map((call) => call.text),
    [
      'BEGIN',
      "SELECT set_config('app.allowed_namespaces', $1, true)",
      "SELECT set_config('app.current_key_id', $1, true)",
      "SELECT set_config('app.current_key_is_admin', $1, true)",
      'SELECT * FROM memories WHERE namespace = ANY($1)',
      'COMMIT',
    ]
  );
  assert.equal(client.calls[1].params?.[0], JSON.stringify(scope.namespaces));
  assert.equal(client.calls[2].params?.[0], scope.keyId);
  assert.equal(client.calls[3].params?.[0], 'true');
  assert.deepEqual(client.releaseArgs, []);
});

test('withScopedClient rolls back and reuses the connection after callback failure', async () => {
  const client = new FakeClient();
  setPoolForTesting(new FakePool(client) as unknown as pg.Pool);

  await assert.rejects(
    () =>
      withScopedClient({ namespaces: [], keyId: 'key-2' }, async () => {
        throw new Error('callback failed');
      }),
    /callback failed/
  );

  assert.deepEqual(
    client.calls.map((call) => call.text),
    [
      'BEGIN',
      "SELECT set_config('app.allowed_namespaces', $1, true)",
      "SELECT set_config('app.current_key_id', $1, true)",
      "SELECT set_config('app.current_key_is_admin', $1, true)",
      'ROLLBACK',
    ]
  );
  assert.equal(client.calls[1].params?.[0], '[]');
  assert.deepEqual(client.releaseArgs, []);
});

test('withScopedClient rolls back and discards connections on commit failure', async () => {
  const client = new FakeClient();
  client.failOnCommit = true;
  setPoolForTesting(new FakePool(client) as unknown as pg.Pool);

  await assert.rejects(
    () => withScopedClient({ namespaces: ['shared'], keyId: 'key-3' }, async () => 'ok'),
    /commit failed/
  );

  assert.deepEqual(
    client.calls.map((call) => call.text),
    [
      'BEGIN',
      "SELECT set_config('app.allowed_namespaces', $1, true)",
      "SELECT set_config('app.current_key_id', $1, true)",
      "SELECT set_config('app.current_key_is_admin', $1, true)",
      'COMMIT',
      'ROLLBACK',
    ]
  );
  assert.equal((client.releaseArgs?.[0] as Error).message, 'commit failed');
});
