import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import path from 'node:path';
import crypto from 'node:crypto';
import { setPoolForTesting } from '../../src/db.js';
import { resolveWorkspaceFile } from '../../src/watcher/paths.js';
import {
  commitPreparedFile,
  deleteObservedFile,
  fingerprintContent,
  prepareChunks,
  type FileSyncInput,
} from '../../src/watcher/sync.js';
import { chunkMarkdown } from '../../src/watcher/chunking.js';

type Call = { text: string; params?: unknown[] };

class TransactionClient {
  readonly pid: number;
  readonly calls: Call[] = [];
  releaseArgs: unknown[] | undefined;
  committed = new Map<string, string>();
  committedHash: string | null = 'old-hash';
  failMutation: 'second-upsert' | 'delete' | 'hash-write' | null = null;
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
    } else if (text.includes('DELETE FROM memories')) {
      if (this.failMutation === 'delete') throw new Error('delete failed');
      const [relPath, desiredKeys] = params as [string, string[] | undefined];
      for (const key of this.staged.keys()) {
        if (key.startsWith(`owned:${relPath}:`) && (!desiredKeys || !desiredKeys.includes(key.slice(`owned:${relPath}:`.length)))) {
          this.staged.delete(key);
        }
      }
    } else if (text.includes('DELETE FROM sync_state')) {
      const [relPath] = params as [string];
      if (relPath === 'notes/example.md') this.stagedHash = null;
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
  assert.deepEqual(client.calls.filter(({ text }) => /INSERT INTO memories|DELETE FROM memories|INSERT INTO sync_state/.test(text)).length, 3);
  assert.equal(client.calls.some(({ text }) => /\bDELETE\b/i.test(text)), true);
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

test('upsert, stale-delete, and hash-write failures roll back the complete prior snapshot', async () => {
  for (const failure of ['second-upsert', 'delete', 'hash-write'] as const) {
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

test('a never-synced CRLF file embeds and stores only body content with parsed tags', async () => {
  const content = '---\r\ntags: [alpha, beta]\r\n---\r\nBody content long enough to sync.\r\n';
  const embedded: string[] = [];
  const chunks = await prepareChunks(
    chunkMarkdown(content, 'test-source', 'notes/crlf.md'),
    async (value) => { embedded.push(value); return [0.1]; }
  );
  const client = new TransactionClient(501);
  client.committedHash = null;
  setPoolForTesting(new SequencedPool([client]) as unknown as pg.Pool);

  await commitPreparedFile({
    relPath: 'notes/crlf.md',
    hash: crypto.createHash('sha256').update(content).digest('hex'),
    namespace: 'projects',
    source: 'test-source',
    agentId: 'agent-1',
    chunks,
  });

  assert.deepEqual(embedded, ['Body content long enough to sync.']);
  assert.deepEqual([...client.committed.values()], embedded);
  const memoryCall = client.calls.find(({ text }) => text.includes('INSERT INTO memories'));
  assert.deepEqual(memoryCall?.params?.[4], ['alpha', 'beta']);
  assert.doesNotMatch(embedded[0], /---|tags:/);
});

test('corrected parsing deterministically replaces a previously stored raw-frontmatter root chunk', async () => {
  const lf = '---\ntags: [corrected]\n---\nBody content long enough to sync.\n';
  const crlf = lf.replaceAll('\n', '\r\n');
  const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
  assert.notEqual(hash(lf), hash(crlf));
  assert.equal(hash(crlf), hash(crlf));

  const client = new TransactionClient(502);
  client.committed.set('file-sync:notes/corrected.md:(root)', crlf.trim());
  setPoolForTesting(new SequencedPool([client, client]) as unknown as pg.Pool);

  for (const content of [lf, crlf]) {
    const chunks = await prepareChunks(
      chunkMarkdown(content, 'test-source', 'notes/corrected.md'),
      async () => [0.2]
    );
    await commitPreparedFile({
      relPath: 'notes/corrected.md',
      hash: hash(content),
      namespace: 'projects',
      source: 'test-source',
      agentId: 'agent-1',
      chunks,
    });
    assert.equal(client.committedHash, hash(content));
    assert.equal(client.committed.get('file-sync:notes/corrected.md:(root)'), 'Body content long enough to sync.');
  }
});

test('v2 fingerprints force legacy hashes through one reconciliation and then stabilize', () => {
  const content = 'same bytes';
  const legacy = crypto.createHash('sha256').update(content).digest('hex');
  const current = fingerprintContent(content);
  assert.notEqual(current, legacy);
  assert.match(current, /^watcher:v2:[a-f0-9]{64}$/);
  assert.equal(fingerprintContent(content), current);
});

test('observed unlink atomically deletes only exact-path watcher rows and sync state, idempotently', async () => {
  const client = new TransactionClient(399);
  client.committed.set('owned:notes/example.md:one', 'owned');
  client.committed.set('owned:notes/other.md:one', 'other');
  client.committed.set('manual:notes/example.md:one', 'manual');
  setPoolForTesting(new SequencedPool([client, client]) as unknown as pg.Pool);

  await deleteObservedFile({ relPath: 'notes/example.md', namespace: 'projects' });
  await deleteObservedFile({ relPath: 'notes/example.md', namespace: 'projects' });

  assert.deepEqual([...client.committed], [
    ['owned:notes/other.md:one', 'other'],
    ['manual:notes/example.md:one', 'manual'],
  ]);
  assert.equal(client.committedHash, null);
  const memoryDeletes = client.calls.filter(({ text }) => text.includes('DELETE FROM memories'));
  assert.equal(memoryDeletes.length, 2);
  assert.deepEqual(memoryDeletes[0].params, ['notes/example.md']);
  assert.ok(client.calls.some(({ text, params }) => text.includes('DELETE FROM sync_state') && params?.[0] === 'notes/example.md'));
});

test('reconciliation deletes only stale watcher-owned keys for the exact file', async () => {
  const client = new TransactionClient(400);
  client.committed.set('owned:notes/example.md:key-1', 'old first');
  client.committed.set('owned:notes/example.md:stale-key', 'stale');
  client.committed.set('owned:notes/other.md:stale-key', 'other file');
  client.committed.set('manual:notes/example.md:stale-key', 'manual');
  setPoolForTesting(new SequencedPool([client]) as unknown as pg.Pool);

  await commitPreparedFile(input());

  const deletion = client.calls.find(({ text }) => text.includes('DELETE FROM memories'));
  assert.deepEqual(deletion?.params, ['notes/example.md', ['key-1', 'key-2']]);
  assert.equal(client.committed.has('owned:notes/example.md:stale-key'), false);
  assert.equal(client.committed.get('owned:notes/other.md:stale-key'), 'other file');
  assert.equal(client.committed.get('manual:notes/example.md:stale-key'), 'manual');
  assert.equal(client.committedHash, 'new-hash');
});

test('zero-chunk files remove all exact-path watcher chunks and advance sync state', async () => {
  const client = new TransactionClient(401);
  client.committed.set('owned:notes/example.md:stale-key', 'old content');
  client.committed.set('manual:notes/example.md:stale-key', 'manual');
  setPoolForTesting(new SequencedPool([client]) as unknown as pg.Pool);

  await commitPreparedFile({ ...input(), chunks: [] });

  assert.deepEqual([...client.committed], [['manual:notes/example.md:stale-key', 'manual']]);
  assert.equal(client.committedHash, 'new-hash');
  assert.ok(client.calls.some(({ text }) => text.includes('DELETE FROM memories')));
});
