import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  buildClaudeImport,
  executeClaudeImport,
  parseClaudeArguments,
} from '../scripts/preseed-claude.js';

const validPair = {
  uuid: 'conversation-1',
  name: 'Testing Claude Imports',
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-03T00:00:00.000Z',
  chat_messages: [
    { uuid: 'human-1', sender: 'human', text: 'Explain the import safety design', created_at: '2024-01-02T00:00:00.000Z' },
    { uuid: 'assistant-1', sender: 'assistant', text: 'A'.repeat(60), created_at: '2024-01-02T00:01:00.000Z' },
  ],
};

test('Claude empty export matrix produces no rows and an explicit zero summary', () => {
  const mtime = new Date('2024-02-01T00:00:00.000Z');
  for (const conversations of [[], [{}], [{ chat_messages: [] }], [{ chat_messages: undefined }]]) {
    for (const memories of [[], [{}], [{ conversations_memory: '' }], [{ conversations_memory: '   ' }]]) {
      const result = buildClaudeImport(conversations, memories, mtime);
      assert.deepEqual(result.rows, []);
      assert.deepEqual(result.summary, { conversationPairs: 0, memoryChunks: 0, total: 0 });
    }
  }
});

test('Claude parser rejects malformed roots and fields instead of trusting JSON casts', () => {
  const mtime = new Date('2024-02-01T00:00:00.000Z');
  for (const conversations of [null, {}, '[]']) {
    assert.throws(() => buildClaudeImport(conversations, [], mtime), /conversations.*array/i);
  }
  for (const memories of [null, {}, '[]', [{ conversations_memory: 42 }]]) {
    assert.throws(() => buildClaudeImport([], memories, mtime), /memories|conversations_memory/i);
  }
});

test('Claude skips pairs with missing content and rejects dates before PostgreSQL', () => {
  const mtime = new Date('2024-02-01T00:00:00.000Z');
  const missingHuman = {
    ...validPair,
    chat_messages: [{ ...validPair.chat_messages[0], text: undefined }, validPair.chat_messages[1]],
  };
  const missingAssistant = {
    ...validPair,
    chat_messages: [validPair.chat_messages[0], { ...validPair.chat_messages[1], text: undefined }],
  };
  assert.deepEqual(buildClaudeImport([missingHuman, missingAssistant], [], mtime).rows, []);
  const invalidDate = {
    ...validPair,
    chat_messages: [{ ...validPair.chat_messages[0], created_at: 'not-a-date' }, validPair.chat_messages[1]],
  };
  assert.throws(() => buildClaudeImport([invalidDate], [], mtime), /valid created_at/i);
});

test('Claude preserves conversation and memory identities, filtering, metadata, tags, and content', () => {
  const result = buildClaudeImport(
    [validPair],
    [{ conversations_memory: 'This is a sufficiently long memory paragraph that should become one stable chunk.' }],
    new Date('2024-02-01T00:00:00.000Z'),
  );
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[0], {
    content: `Q: Explain the import safety design\n\nA: ${'A'.repeat(60)}`,
    source: 'claude-conversation',
    namespace: 'work',
    tags: ['testing', 'claude', 'imports'],
    metadata: JSON.stringify({ conversation_name: 'Testing Claude Imports', conversation_uuid: 'conversation-1', message_uuid: 'human-1' }),
    sourceKey: 'claude-conv:conversation-1:human-1',
    createdAt: '2024-01-02T00:00:00.000Z',
  });
  assert.deepEqual(result.rows[1], {
    content: 'This is a sufficiently long memory paragraph that should become one stable chunk.',
    source: 'claude-memory',
    namespace: 'work',
    tags: ['claude', 'memory', 'profile'],
    metadata: JSON.stringify({ chunk_index: 0, total_chunks: 1 }),
    sourceKey: 'claude-memory:0',
    createdAt: '2024-01-03T00:00:00.000Z',
  });
});

test('memory-only Claude exports use one captured mtime or an explicit deterministic fallback', () => {
  const memories = [{ conversations_memory: 'A deterministic memory paragraph long enough to import without any conversations.' }];
  const mtime = new Date('2024-02-01T03:04:05.000Z');
  assert.equal(buildClaudeImport([], memories, mtime).rows[0].createdAt, mtime.toISOString());
  assert.equal(buildClaudeImport([], memories, mtime, '2020-01-02T00:00:00Z').rows[0].createdAt, '2020-01-02T00:00:00.000Z');
  assert.equal(buildClaudeImport([], memories, new Date(Number.NaN), '2020-01-02T00:00:00Z').rows[0].createdAt, '2020-01-02T00:00:00.000Z');
  assert.throws(() => buildClaudeImport([], memories, new Date(Number.NaN)), /memory timestamp|--memory-timestamp/i);
  assert.throws(() => buildClaudeImport([], memories, mtime, 'not-a-date'), /memory timestamp/i);
});

test('Claude command checks role before exports and closes resources on empty and malformed input', async () => {
  const events: string[] = [];
  let conversations = '[]';
  const client = {
    async query(text: string) {
      events.push(text.startsWith('SELECT\n  current_user') ? 'role-check' : text);
      return { rows: [{ current_user: 'app', rolsuper: false, rolbypassrls: false, owns_memories: false }], rowCount: 1 };
    },
    release() { events.push('release'); },
  };
  const dependencies = {
    gate() {},
    createPool: () => ({ async connect() { events.push('connect'); return client; }, async end() { events.push('end'); } }),
    async readFile(file: string) { events.push(`read:${path.basename(file)}`); return file.endsWith('conversations.json') ? conversations : '[]'; },
    async stat() { return { mtime: new Date('2024-02-01T00:00:00.000Z') }; },
    async embedBatch() { assert.fail('empty export embedded'); return []; },
    log(message: string) { events.push(`log:${message}`); },
  };
  const options = { databaseUrl: 'postgres://app/db', importsDir: '/exports' };
  const summary = await executeClaudeImport(options, dependencies);
  assert.deepEqual(summary, { conversationPairs: 0, memoryChunks: 0, total: 0 });
  assert.deepEqual(events.slice(0, 4), ['connect', 'role-check', 'read:conversations.json', 'read:memories.json']);
  assert.ok(events.some(event => /Done: 0 conversation pairs.*0 memory chunks.*0 total/.test(event)));
  assert.deepEqual(events.slice(-2), ['release', 'end']);

  events.length = 0;
  conversations = '{}';
  await assert.rejects(executeClaudeImport(options, dependencies), /conversations.*array/i);
  assert.deepEqual(events.slice(-2), ['release', 'end']);
});

test('direct Claude execution cannot bypass the #41 gate', async () => {
  let poolCreated = false;
  await assert.rejects(executeClaudeImport({ databaseUrl: 'postgres://app/db', importsDir: '/exports' }, {
    gate() { throw new Error('#9 identity schema gate closed'); },
    createPool: () => { poolCreated = true; throw new Error('pool reached'); },
    async readFile() { throw new Error('read reached'); },
    async stat() { throw new Error('stat reached'); },
    async embedBatch() { return []; },
    log() {},
  }), /#9.*gate closed/i);
  assert.equal(poolCreated, false);
});

test('Claude command rejects privileged roles before reading sensitive exports', async () => {
  let reads = 0;
  let released = false;
  let ended = false;
  await assert.rejects(executeClaudeImport({ databaseUrl: 'postgres://owner/db', importsDir: '/secret' }, {
    gate() {},
    createPool: () => ({
      async connect() { return {
        async query() { return { rows: [{ current_user: 'owner', rolsuper: false, rolbypassrls: false, owns_memories: true }] }; },
        release() { released = true; },
      }; },
      async end() { ended = true; },
    }),
    async readFile() { reads++; return '[]'; },
    async stat() { return { mtime: new Date() }; },
    async embedBatch() { assert.fail('unsafe role embedded'); return []; },
    log() {},
  }), /unsafe.*owner/i);
  assert.equal(reads, 0);
  assert.equal(released, true);
  assert.equal(ended, true);
});

test('Claude command commits checked embeddings in groups of at most ten', async () => {
  const conversations = Array.from({ length: 11 }, (_, index) => ({
    ...validPair,
    uuid: `conversation-${index}`,
    chat_messages: validPair.chat_messages.map(message => ({ ...message, uuid: `${message.uuid}-${index}` })),
  }));
  const batchSizes: number[] = [];
  let inserts = 0;
  await executeClaudeImport({ databaseUrl: 'postgres://app/db', importsDir: '/exports' }, {
    gate() {},
    createPool: () => ({
      async connect() { return {
        async query(text: string) {
          if (text.startsWith('INSERT')) inserts++;
          return { rows: [{ current_user: 'app', rolsuper: false, rolbypassrls: false, owns_memories: false }] };
        },
        release() {},
      }; },
      async end() {},
    }),
    async readFile(file: string) { return file.endsWith('conversations.json') ? JSON.stringify(conversations) : '[]'; },
    async stat() { return { mtime: new Date('2024-02-01T00:00:00.000Z') }; },
    async embedBatch(texts: string[]) { batchSizes.push(texts.length); return texts.map(() => Array(768).fill(0)); },
    log() {},
  });
  assert.deepEqual(batchSizes, [10, 1]);
  assert.equal(inserts, 2);
});

test('Claude arguments require DATABASE_URL and an explicit import root', () => {
  assert.throws(() => parseClaudeArguments([], {}), /DATABASE_URL/i);
  assert.throws(() => parseClaudeArguments([], { DATABASE_URL: 'postgres://app/db' }), /CLAUDE_IMPORTS_DIR/i);
  assert.deepEqual(parseClaudeArguments(['/tmp/export', '--memory-timestamp', '2020-01-02T00:00:00Z'], { DATABASE_URL: 'postgres://app/db' }), {
    databaseUrl: 'postgres://app/db',
    importsDir: path.resolve('/tmp/export'),
    memoryTimestamp: '2020-01-02T00:00:00.000Z',
  });
});
