import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import path from 'node:path';
import { setPoolForTesting } from '../../src/db.js';
import { resolveWorkspaceFile } from '../../src/watcher/paths.js';
import {
  commitPreparedFile,
  prepareChunks,
  type FileSyncInput,
} from '../../src/watcher/sync.js';

type Call = { text: string; params?: unknown[] };

class TransactionClient {
  readonly pid: number;
  readonly calls: Call[] = [];
  releaseArgs: unknown[] | undefined;
  committed = new Map<string, string>();
  committedHash: string | null = 'old-hash';
  failMutation: 'second-upsert' | 'hash-write' | null = null;
  private staged = new Map<string, string>();
  private stagedHash: string | null = null;
  private upserts = 0;

  constructor(pid: number) { this.pid = pid; }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
    this.calls.push({ text, params });
    if (text === 'BEGIN') {
      this.staged = new Map(this.committed);
      this.stagedHash = this.committedHash;
    } else if (text.includes('INSERT INTO memories')) {
      this.upserts++;
      if (this.failMutation === 'second-upsert' && this.upserts === 2) throw new Error('second upsert failed');
      this.staged.set(params?.[6] as string, params?.[0] as string);
    } else if (text.includes('INSERT INTO sync_state')) {
      if (this.failMutation === 'hash-write') throw new Error('hash write failed');
      this.stagedHash = params?.[1] as string;
    } else if (text === 'COMMIT') {
      this.committed = new Map(this.staged);
      this.committedHash = this.stagedHash;
    }
    return { command: 'SELECT', rowCount: 0, oid: 0, fields: [], rows: [] };
  }

  release(err?: Error): void { this.releaseArgs = err ? [err] : []; }
}

class SequencedPool {
  readonly connected: TransactionClient[] = [];
  constructor(private readonly clients: TransactionClient[]) {}
  async connect(): Promise<TransactionClient> {
    const client = this.clients[this.connected.length];
    this.connected.push(client);
    return client;
  }
}

function input(namespace = 'projects'): FileSyncInput {
  return {
    relPath: 'notes/example.md',
    hash: 'new-hash',
    namespace,
    source: 'test-source',
    agentId: 'agent-1',
    chunks: [
      { content: 'first', vectorStr: '[0.1]', sourceKey: 'key-1', tags: [], metadata: { file: 'notes/example.md' } },
      { content: 'second', vectorStr: '[0.2]', sourceKey: 'key-2', tags: [], metadata: { file: 'notes/example.md' } },
    ],
  };
}

test.afterEach(() => setPoolForTesting(null));

test('separator and dot-segment aliases share queue, source, metadata, and sync-state identities', async () => {
  const workspace = 'C:\\Users\\me\\.openclaw\\workspace';
  const aliases = [
    'C:\\Users\\me\\.openclaw\\workspace\\memory\\day.md',
    'C:/Users/me/.openclaw/workspace/memory/./day.md',
  ];
  const identities = aliases.map(candidate => resolveWorkspaceFile(workspace, candidate, path.win32));
  assert.deepEqual(identities, [
    { absolutePath: aliases[0], relativePath: 'memory/day.md' },
    { absolutePath: aliases[0], relativePath: 'memory/day.md' },
  ]);

  const client = new TransactionClient(99);
  setPoolForTesting(new SequencedPool([client, client]) as unknown as pg.Pool);
  for (const identity of identities) {
    await commitPreparedFile({
      relPath: identity.relativePath,
      hash: 'same-hash',
      namespace: 'personal',
      source: 'openclaw-daily',
      agentId: 'agent-1',
      chunks: [{
        content: 'same content',
        vectorStr: '[0.1]',
        sourceKey: `file-sync:${identity.relativePath}:(root)`,
        tags: [],
        metadata: { file: identity.relativePath },
      }],
    });
  }

  const memoryCalls = client.calls.filter(({ text }) => text.includes('INSERT INTO memories'));
  const stateCalls = client.calls.filter(({ text }) => text.includes('INSERT INTO sync_state'));
  assert.deepEqual(new Set(memoryCalls.map(call => call.params?.[6])), new Set(['file-sync:memory/day.md:(root)']));
  assert.deepEqual(new Set(memoryCalls.map(call => JSON.parse(call.params?.[5] as string).file)), new Set(['memory/day.md']));
  assert.deepEqual(new Set(stateCalls.map(call => call.params?.[0])), new Set(['memory/day.md']));
});

test('embedding completes before a client is acquired and all mutations use that one client', async () => {
  const client = new TransactionClient(101);
  const pool = new SequencedPool([client]);
  setPoolForTesting(pool as unknown as pg.Pool);
  const events: string[] = [];

  const chunks = await prepareChunks(
    [{ content: 'first', sourceKey: 'key-1', tags: [], metadata: {} }],
    async () => { events.push('embed'); return [0.1, 0.2]; }
  );
  events.push(`connections:${pool.connected.length}`);
  await commitPreparedFile({ ...input(), chunks });

  assert.deepEqual(events, ['embed', 'connections:0']);
  assert.equal(pool.connected.length, 1);
  assert.deepEqual(client.calls.filter(({ text }) => /INSERT INTO memories|INSERT INTO sync_state/.test(text)).length, 2);
  assert.equal(client.calls.some(({ text }) => /\bDELETE\b/i.test(text)), false);
  assert.equal(
    client.calls.find(({ text, params }) => text.includes("set_config('app.allowed_namespaces'") && params)?.params?.[0],
    JSON.stringify(['projects'])
  );
});

test('chunk embeddings are prepared serially before opening the transaction', async () => {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];

  const chunks = await prepareChunks(
    [
      { content: 'first', sourceKey: 'key-1', tags: [], metadata: {} },
      { content: 'second', sourceKey: 'key-2', tags: [], metadata: {} },
      { content: 'third', sourceKey: 'key-3', tags: [], metadata: {} },
    ],
    async (content) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${content}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      order.push(`end:${content}`);
      active--;
      return [content.length];
    }
  );

  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    'start:first', 'end:first',
    'start:second', 'end:second',
    'start:third', 'end:third',
  ]);
  assert.deepEqual(chunks.map(({ vectorStr }) => vectorStr), ['[5]', '[6]', '[5]']);
});

test('second-upsert and hash-write failures roll back all upserts and sync state', async () => {
  for (const failure of ['second-upsert', 'hash-write'] as const) {
    const client = new TransactionClient(200);
    client.committed.set('stale-key', 'old content');
    client.failMutation = failure;
    setPoolForTesting(new SequencedPool([client]) as unknown as pg.Pool);

    await assert.rejects(() => commitPreparedFile(input()), /failed/);
    assert.deepEqual([...client.committed], [['stale-key', 'old content']], failure);
    assert.equal(client.committedHash, 'old-hash', failure);
    assert.equal(client.calls.at(-1)?.text, 'ROLLBACK');
  }
});

test('concurrent files receive independent transaction-local namespace scopes', async () => {
  const personal = new TransactionClient(301);
  const projects = new TransactionClient(302);
  setPoolForTesting(new SequencedPool([personal, projects]) as unknown as pg.Pool);

  await Promise.all([
    commitPreparedFile(input('personal')),
    commitPreparedFile(input('projects')),
  ]);

  const configured = [personal, projects].map((client) =>
    client.calls.find(({ text, params }) => text.includes("set_config('app.allowed_namespaces'") && params)?.params?.[0]
  );
  assert.deepEqual(configured, [JSON.stringify(['personal']), JSON.stringify(['projects'])]);
  assert.notEqual(personal.pid, projects.pid);
});

test('zero-chunk files advance sync state without requiring DELETE authority', async () => {
  const client = new TransactionClient(401);
  client.committed.set('stale-key', 'old content');
  setPoolForTesting(new SequencedPool([client]) as unknown as pg.Pool);

  await commitPreparedFile({ ...input(), chunks: [] });

  assert.deepEqual([...client.committed], [['stale-key', 'old content']]);
  assert.equal(client.committedHash, 'new-hash');
  assert.equal(client.calls.some(({ text }) => /\bDELETE\b/i.test(text)), false);
});
