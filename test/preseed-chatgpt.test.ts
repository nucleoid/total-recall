import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  buildChunks,
  commitChunkBatch,
  discoverConversationFiles,
  importConversationFiles,
  parseImportArguments,
  walkConversation,
  streamConversations,
} from '../scripts/preseed-chatgpt.js';

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'preseed-chatgpt-'));
}

test('discovers only accepted conversation exports in deterministic numeric order and once per real path', async () => {
  const directory = await tempDirectory();
  for (const name of [
    'conversations-12.json',
    'conversations-2.json',
    'conversations.json',
    'conversations-000.json',
    'conversations-backup.json',
    'other.json',
  ]) await writeFile(path.join(directory, name), '[]');
  await mkdir(path.join(directory, 'conversations-3.json'));
  try {
    await symlink(path.join(directory, 'conversations-2.json'), path.join(directory, 'conversations-02.json'));
  } catch (error: any) {
    if (error?.code !== 'EPERM') throw error;
  }

  const files = await discoverConversationFiles(directory);
  const names = files.map(file => path.basename(file));
  assert.deepEqual(names, ['conversations.json', 'conversations-000.json', 'conversations-2.json', 'conversations-12.json']);
  assert.equal(new Set(await Promise.all(files.map(file => realpath(file)))).size, files.length);
});

test('an empty import directory fails clearly before database work', async () => {
  await assert.rejects(discoverConversationFiles(await tempDirectory()), /no conversation export files/i);
});

test('streams a root array one record at a time, accepts empty arrays, and rejects invalid roots', async () => {
  const directory = await tempDirectory();
  const valid = path.join(directory, 'conversations.json');
  await writeFile(valid, '[{"conversation_id":"a"},{"conversation_id":"b"}]');
  const seen: unknown[] = [];
  for await (const item of streamConversations(valid, 1024)) seen.push(item);
  assert.deepEqual(seen, [{ conversation_id: 'a' }, { conversation_id: 'b' }]);

  await writeFile(valid, '[]');
  for await (const _item of streamConversations(valid, 1024)) assert.fail('empty array yielded a record');

  await writeFile(valid, '{"conversation_id":"not-an-array"}');
  await assert.rejects(async () => {
    for await (const _item of streamConversations(valid, 1024)) { /* consume */ }
  }, /root array|top-level array/i);
});

test('preserves first-child walking, filtering inputs, chunk identity, content, and timestamps', () => {
  const conversation = {
    title: 'Stable title',
    conversation_id: 'stable-id',
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    mapping: {
      root: { parent: null, children: ['user'], message: null },
      user: { parent: 'root', children: ['assistant', 'ignored'], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['hello ', 42, 'world'] }, create_time: 1_700_000_001 } },
      assistant: { parent: 'user', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['answer'] }, create_time: 1_700_000_002 } },
      ignored: { parent: 'user', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['wrong branch'] }, create_time: 1_700_000_003 } },
    },
  };
  const turns = walkConversation(conversation.mapping);
  assert.deepEqual(turns, [
    { role: 'user', text: 'hello \nworld', create_time: 1_700_000_001 },
    { role: 'assistant', text: 'answer', create_time: 1_700_000_002 },
  ]);
  assert.deepEqual(buildChunks(conversation, turns), [{
    content: '[Stable title]\n\nUser: hello \nworld\nAssistant: answer',
    sourceKey: 'chatgpt-conv:stable-id:0',
    createdAt: new Date(1_700_000_001_000).toISOString(),
  }]);
});

test('embeds a deduplicated batch before one atomic transaction and uses transaction-local personal scope', async () => {
  const events: string[] = [];
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      events.push(text.startsWith('INSERT') ? 'insert' : text);
      queries.push({ text, values });
      return {};
    },
  };
  const chunks = [
    { content: 'old duplicate', sourceKey: 'same', createdAt: '2024-01-01T00:00:00.000Z', metadata: '{"title":"old","model":null}' },
    { content: 'replacement', sourceKey: 'same', createdAt: '2024-01-02T00:00:00.000Z', metadata: '{"title":"new","model":null}' },
    { content: 'other', sourceKey: 'other', createdAt: '2024-01-03T00:00:00.000Z', metadata: '{"title":"other","model":null}' },
  ];
  const committed = await commitChunkBatch(chunks, async texts => {
    events.push(`embed:${texts.join('|')}`);
    return texts.map(() => Array(768).fill(0.5));
  }, client);

  assert.equal(committed, 2);
  assert.deepEqual(events, ['embed:replacement|other', 'BEGIN', "SELECT set_config('app.current_namespace', 'personal', true)", 'insert', 'COMMIT']);
  assert.match(queries[2].text, /INSERT INTO memories[\s\S]*VALUES[\s\S]*ON CONFLICT \(source_key\)/);
  assert.equal(queries[2].values?.length, 16);
  assert.equal(queries[2].values?.[0], 'replacement');
  assert.equal(queries[2].values?.[6], 'same');
});

test('embedding, SQL, and commit failures never leave a partial batch', async () => {
  let queryCalls = 0;
  await assert.rejects(commitChunkBatch([
    { content: 'x', sourceKey: 'x', createdAt: '2024-01-01T00:00:00.000Z', metadata: '{}' },
  ], async () => [], { async query() { queryCalls++; return {}; } }), /count mismatch/i);
  assert.equal(queryCalls, 0, 'provider validation happens before BEGIN');

  const commands: string[] = [];
  await assert.rejects(commitChunkBatch([
    { content: 'x', sourceKey: 'x', createdAt: '2024-01-01T00:00:00.000Z', metadata: '{}' },
  ], async () => [Array(768).fill(0)], {
    async query(text: string) {
      commands.push(text.startsWith('INSERT') ? 'INSERT' : text);
      if (text.startsWith('INSERT')) throw new Error('database down');
      return {};
    },
  }), /database down/);
  assert.deepEqual(commands, ['BEGIN', "SELECT set_config('app.current_namespace', 'personal', true)", 'INSERT', 'ROLLBACK']);
});

function exportConversation(id: string) {
  return {
    title: `Conversation ${id}`,
    conversation_id: id,
    create_time: 1_700_000_000,
    update_time: 1_700_000_001,
    mapping: {
      root: { parent: null, children: ['u'], message: null },
      u: { parent: 'root', children: ['a'], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['question '.repeat(15)] }, create_time: 1_700_000_000 } },
      a: { parent: 'u', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['answer '.repeat(15)] }, create_time: 1_700_000_001 } },
    },
  };
}

test('imports incrementally with pending output bounded to ten and reports empty exports without invalid dates', async () => {
  const directory = await tempDirectory();
  const populated = path.join(directory, 'conversations.json');
  const empty = path.join(directory, 'conversations-2.json');
  await writeFile(populated, JSON.stringify(Array.from({ length: 23 }, (_, index) => exportConversation(String(index)))));
  await writeFile(empty, '[]');
  const pendingSizes: number[] = [];
  const inserts: unknown[][] = [];
  const summary = await importConversationFiles([populated, empty], {
    async query(text: string, values?: unknown[]) {
      if (text.startsWith('INSERT')) inserts.push(values ?? []);
      return {};
    },
  }, async texts => texts.map(() => Array(768).fill(0)), {
    onPendingSize: size => pendingSizes.push(size),
  });

  assert.equal(Math.max(...pendingSizes), 10);
  assert.equal(inserts.length, 3);
  assert.deepEqual(summary, {
    files: 2,
    conversationsAccepted: 23,
    conversationsSkipped: 0,
    chunksCommitted: 23,
    minDate: '2023-11-14T22:13:20.000Z',
    maxDate: '2023-11-14T22:13:20.000Z',
  });

  const emptySummary = await importConversationFiles([empty], { async query() { assert.fail('empty export queried database'); } }, async () => { assert.fail('empty export called provider'); });
  assert.equal(emptySummary.minDate, null);
  assert.equal(emptySummary.maxDate, null);
  assert.equal(emptySummary.chunksCommitted, 0);
});

test('a later provider failure preserves prior committed batches for safe source-key rerun', async () => {
  const directory = await tempDirectory();
  const file = path.join(directory, 'conversations.json');
  await writeFile(file, JSON.stringify(Array.from({ length: 11 }, (_, index) => exportConversation(String(index)))));
  let embedCalls = 0;
  const commands: string[] = [];
  await assert.rejects(importConversationFiles([file], {
    async query(text: string) { commands.push(text.startsWith('INSERT') ? 'INSERT' : text); return {}; },
  }, async texts => {
    embedCalls++;
    if (embedCalls === 2) throw new Error('provider unavailable');
    return texts.map(() => Array(768).fill(0));
  }), /provider unavailable/);
  assert.equal(embedCalls, 2);
  assert.equal(commands.filter(command => command === 'COMMIT').length, 1);
  assert.equal(commands.filter(command => command === 'INSERT').length, 1);
});

test('requires an explicit import directory, validates the memory guard, and retains the #41 fail-closed gate', async () => {
  assert.throws(() => parseImportArguments([], {}), /CHATGPT_IMPORTS_DIR.*CLI/i);
  assert.equal(parseImportArguments([], { CHATGPT_IMPORTS_DIR: './exports' }).maxConversationBytes, 16 * 1024 * 1024);
  assert.equal(parseImportArguments(['./cli', '--max-conversation-bytes', '1024'], {}).maxConversationBytes, 1024);
  assert.throws(() => parseImportArguments(['./cli', '--max-conversation-bytes', String(64 * 1024 * 1024 + 1)], {}), /no greater than/i);

  const source = await readFile(new URL('../scripts/preseed-chatgpt.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /readFileSync|allConversations|conversations-000\.json|IMPORTS_DIR\s*=/);
  assert.match(source, /requireEmbeddingIdentityWriter\(\)[\s\S]*discoverConversationFiles\(directory\)[\s\S]*pool\.connect\(\)/);
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(packageJson.scripts['typecheck:scripts'], /tsconfig\.scripts\.json/);
});

test('turns source stream failures into contextual import errors and cleans up', async () => {
  let destroyed = false;
  const failing = new Readable({
    read() { this.destroy(new Error('simulated disk failure')); },
    destroy(error, callback) { destroyed = true; callback(error); },
  });
  await assert.rejects(async () => {
    for await (const _item of streamConversations('broken.json', 1024, () => failing)) { /* consume */ }
  }, /broken\.json.*simulated disk failure/i);
  assert.equal(destroyed, true);
});

test('rejects oversized and unusable records with file and record context', async () => {
  const directory = await tempDirectory();
  const file = path.join(directory, 'conversations.json');
  await writeFile(file, JSON.stringify([null, { conversation_id: 'huge', payload: 'x'.repeat(200) }]));
  await assert.rejects(async () => {
    for await (const _item of streamConversations(file, 100)) { /* consume */ }
  }, /conversations\.json.*record 1.*usable conversation object/i);

  await writeFile(file, JSON.stringify([{ conversation_id: 'huge', payload: 'x'.repeat(200) }]));
  await assert.rejects(async () => {
    for await (const _item of streamConversations(file, 100)) { /* consume */ }
  }, /conversations\.json.*record 1.*maximum.*100 bytes/i);
});
