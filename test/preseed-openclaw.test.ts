import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  chunkMarkdown,
  executeOpenClawImport,
  parseOpenClawArguments,
} from '../scripts/preseed-openclaw.js';

test('OpenClaw chunking preserves identities, content, tags, metadata, and filtering', () => {
  const now = '2024-01-01T00:00:00.000Z';
  assert.deepEqual(chunkMarkdown('---\ntags: [one, "two"]\n---\n## Heading\nUseful body', 'openclaw-memory', 'MEMORY.md', now), [{
    content: '## Heading\nUseful body',
    heading: '## Heading',
    sourceKey: 'openclaw-memory:MEMORY.md:## Heading',
    tags: ['one', 'two'],
    metadata: { file: 'MEMORY.md', heading: '## Heading', preseed_at: now },
  }]);
  assert.deepEqual(chunkMarkdown('short', 'source', 'short.md', now), []);
  assert.equal(chunkMarkdown(`${'preamble '.repeat(3)}\n## Heading\n${'body '.repeat(500)}`, 'source', 'long.md', now).length, 2);
});

test('OpenClaw arguments require app DATABASE_URL and configured workspace roots', () => {
  assert.throws(() => parseOpenClawArguments([], {}), /DATABASE_URL/i);
  assert.throws(() => parseOpenClawArguments([], { DATABASE_URL: 'postgres://app/db' }), /OPENCLAW_WORKSPACE/i);
  const parsed = parseOpenClawArguments([], {
    DATABASE_URL: 'postgres://app/db',
    OPENCLAW_WORKSPACE: './workspace',
    OPENCLAW_CORTEX_CONTENT: './cortex',
    OPENCLAW_SECOND_BRAIN: './second-brain',
  });
  assert.deepEqual(parsed, {
    databaseUrl: 'postgres://app/db',
    workspace: path.resolve('./workspace'),
    cortexContent: path.resolve('./cortex'),
    secondBrain: path.resolve('./second-brain'),
  });
});

test('OpenClaw checks role before workspace reads, deduplicates canonical paths, batches, and closes resources', async () => {
  const events: string[] = [];
  const inserts: Array<{ text: string; values?: unknown[] }> = [];
  const files = Array.from({ length: 11 }, (_, index) => `/workspace/memory/${index}.md`);
  const client = {
    async query(text: string, values?: unknown[]) {
      if (text.startsWith('SELECT\n  current_user')) events.push('role-check');
      if (text.startsWith('INSERT')) inserts.push({ text, values });
      return { rows: [{ current_user: 'app', rolsuper: false, rolbypassrls: false, owns_memories: false }] };
    },
    release() { events.push('release'); },
  };
  const batchSizes: number[] = [];
  const summary = await executeOpenClawImport({
    databaseUrl: 'postgres://app/db', workspace: '/workspace', cortexContent: '/cortex', secondBrain: '/second-brain',
  }, {
    gate() {},
    createPool: () => ({ async connect() { events.push('connect'); return client; }, async end() { events.push('end'); } }),
    async stat(file: string) { events.push(`stat:${file}`); return { isDirectory: () => file === '/workspace' }; },
    async glob(pattern: string, options: { cwd: string }) {
      if (options.cwd === '/workspace' && pattern === 'memory/*.md') return [...files, '/workspace/memory/duplicate.md'];
      if (options.cwd === '/second-brain' && pattern === 'journals/*.md') return ['/workspace/memory/duplicate.md'];
      return [];
    },
    async realpath(file: string) { return file.endsWith('duplicate.md') ? files[0] : file; },
    async readFile(file: string) { events.push(`read:${file}`); return `Content for ${file} is definitely long enough.`; },
    async embedBatch(texts: string[]) { batchSizes.push(texts.length); return texts.map(() => Array(768).fill(0)); },
    now: () => '2024-01-01T00:00:00.000Z',
    log() {},
  });
  assert.deepEqual(events.slice(0, 3), ['connect', 'role-check', 'stat:/workspace']);
  assert.deepEqual(batchSizes, [10, 1]);
  assert.equal(inserts.length, 2);
  assert.deepEqual(summary, { files: 11, chunks: 11 });
  assert.deepEqual(events.slice(-2), ['release', 'end']);
  assert.ok(inserts.every(insert => insert.values?.includes('preseed')));
  for (const insert of inserts) {
    const conflictClause = insert.text.split('ON CONFLICT')[1];
    assert.doesNotMatch(conflictClause, /created_at\s*=/, 'OpenClaw reruns preserve the original creation time');
  }
});

test('direct OpenClaw execution cannot bypass the #41 gate', async () => {
  let poolCreated = false;
  await assert.rejects(executeOpenClawImport({
    databaseUrl: 'postgres://app/db', workspace: '/workspace', cortexContent: '/cortex', secondBrain: '/second-brain',
  }, {
    gate() { throw new Error('#9 identity schema gate closed'); },
    createPool: () => { poolCreated = true; throw new Error('pool reached'); },
    async stat() { throw new Error('stat reached'); },
    async glob() { return []; },
    async realpath(file: string) { return file; },
    async readFile() { return ''; },
    async embedBatch() { return []; },
    now: () => '', log() {},
  }), /#9.*gate closed/i);
  assert.equal(poolCreated, false);
});

test('OpenClaw rejects privileged role before workspace access and cleans up failures', async () => {
  let stats = 0;
  let released = false;
  let ended = false;
  await assert.rejects(executeOpenClawImport({
    databaseUrl: 'postgres://owner/db', workspace: '/secret', cortexContent: '/cortex', secondBrain: '/second-brain',
  }, {
    gate() {},
    createPool: () => ({
      async connect() { return {
        async query() { return { rows: [{ current_user: 'owner', rolsuper: false, rolbypassrls: false, owns_memories: true }] }; },
        release() { released = true; },
      }; },
      async end() { ended = true; },
    }),
    async stat() { stats++; return { isDirectory: () => true }; },
    async glob() { return []; },
    async realpath(file: string) { return file; },
    async readFile() { return ''; },
    async embedBatch() { assert.fail('unsafe role embedded'); return []; },
    now: () => '',
    log() {},
  }), /unsafe.*owner/i);
  assert.equal(stats, 0);
  assert.equal(released, true);
  assert.equal(ended, true);
});
