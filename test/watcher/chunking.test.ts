import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  assertUniqueSourceKeys,
  buildSourceKey,
  chunkMarkdown,
  extractFrontmatter,
} from '../../src/watcher/chunking.js';

function framed(value: string | null): Buffer {
  if (value === null) return Buffer.from([0, 0, 0, 0, 0]);
  const bytes = Buffer.from(value, 'utf8');
  const header = Buffer.alloc(5);
  header[0] = 1;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

function expectedV2Key(
  relPath: string,
  h2: string,
  h2Occurrence: number,
  h3: string | null = null,
  h3Occurrence: number | null = null,
): string {
  const canonical = Buffer.concat([
    Buffer.from('file-sync-key\0v2\0', 'utf8'),
    framed(relPath),
    framed(h2),
    framed(String(h2Occurrence)),
    framed(h3),
    framed(h3Occurrence === null ? null : String(h3Occurrence)),
  ]);
  return `file-sync:v2:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

test('LF and CRLF frontmatter produce the same tags while preserving body line endings', () => {
  const lf = '---\ntags: [alpha, "two words"]\n---\nBody line one\nBody line two\n';
  const crlf = lf.replaceAll('\n', '\r\n');

  assert.deepEqual(extractFrontmatter(lf), {
    tags: ['alpha', 'two words'],
    body: 'Body line one\nBody line two\n',
  });
  assert.deepEqual(extractFrontmatter(crlf), {
    tags: ['alpha', 'two words'],
    body: 'Body line one\r\nBody line two\r\n',
  });

  const lfChunks = chunkMarkdown(lf, 'source', 'notes/example.md');
  const crlfChunks = chunkMarkdown(crlf, 'source', 'notes/example.md');
  assert.deepEqual(crlfChunks.map(({ content }) => content.replaceAll('\r\n', '\n')), lfChunks.map(({ content }) => content));
  assert.deepEqual(crlfChunks.map(({ tags }) => tags), lfChunks.map(({ tags }) => tags));
});

test('mixed endings, empty blocks, and closing delimiters at EOF are parsed', () => {
  assert.deepEqual(extractFrontmatter('---\r\ntags: [one, two]\n---\r\nBody\n'), {
    tags: ['one', 'two'],
    body: 'Body\n',
  });
  assert.deepEqual(extractFrontmatter('---\r\n---\nBody'), { tags: [], body: 'Body' });
  assert.deepEqual(extractFrontmatter('---\ntags: []\n---'), { tags: [], body: '' });
});

test('only an exact complete line closes frontmatter', () => {
  const input = '---\nvalue: ---x\nother: before --- after\ntags: [kept]\n---\nActual body';
  assert.deepEqual(extractFrontmatter(input), { tags: ['kept'], body: 'Actual body' });
});

test('malformed and unsupported openings fall back byte-for-byte', () => {
  const fixtures = [
    '---\ntags: [open-only]\nBody',
    '---\ntags: [suffix]\n---x\nBody',
    '---\ntags: [indented-close]\n  ---\nBody',
    ' \n---\ntags: [leading-space]\n---\nBody',
    '\uFEFF---\ntags: [bom]\n---\nBody',
  ];

  for (const fixture of fixtures) {
    assert.deepEqual(extractFrontmatter(fixture), { tags: [], body: fixture });
  }
});

test('existing limited bracket-list tag forms remain supported', () => {
  assert.deepEqual(extractFrontmatter("---\ntags: ['one', two, \"three words\"]\n---\nBody"), {
    tags: ['one', 'two', 'three words'],
    body: 'Body',
  });
  assert.deepEqual(extractFrontmatter('---\ntitle: no tags\n---\nBody'), { tags: [], body: 'Body' });
});

test('CRLF H2 and H3 headings never leak carriage returns into headings or source keys', () => {
  const longH2Body = 'intro text '.repeat(210);
  const input = `---\r\ntags: [headings]\r\n---\r\n## Parent\r\n${longH2Body}\r\n### Child\r\nchild body content\r\n`;
  const chunks = chunkMarkdown(input, 'source', 'notes/headings.md');

  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.doesNotMatch(chunk.heading, /\r/);
    assert.doesNotMatch(chunk.sourceKey, /\r/);
    assert.doesNotMatch(String(chunk.metadata.heading), /\r/);
  }
  assert.ok(chunks.some(({ heading }) => heading === '## Parent > ### Child'));
});

test('duplicate H2 sections retain every body with deterministic occurrence keys', () => {
  const chunks = chunkMarkdown([
    '## Notes',
    'first body',
    '## Notes',
    'second body',
    '## Notes',
    'third body',
  ].join('\n'), 'source', 'notes/duplicate.md');

  assert.deepEqual(chunks.map(chunk => chunk.content), [
    '## Notes\nfirst body',
    '## Notes\nsecond body',
    '## Notes\nthird body',
  ]);
  assert.deepEqual(chunks.map(chunk => chunk.sourceKey), [
    'file-sync:notes/duplicate.md:## Notes',
    expectedV2Key('notes/duplicate.md', '## Notes', 2),
    expectedV2Key('notes/duplicate.md', '## Notes', 3),
  ]);
  assert.deepEqual(chunks.map(chunk => chunk.metadata.h2_occurrence), [1, 2, 3]);
});

test('filtered H2 and H3 bodies still reserve their syntactic occurrences', () => {
  const h2Chunks = chunkMarkdown([
    '## Notes',
    'tiny',
    '## Notes',
    'second body survives',
  ].join('\n'), 'source', 'notes/filtered-h2.md');
  assert.equal(h2Chunks.length, 1);
  assert.equal(h2Chunks[0].sourceKey, expectedV2Key('notes/filtered-h2.md', '## Notes', 2));
  assert.equal(h2Chunks[0].metadata.h2_occurrence, 2);

  const h3Chunks = chunkMarkdown([
    '## Parent',
    'long preamble '.repeat(170),
    '### Child',
    'tiny',
    '### Child',
    'second child survives',
  ].join('\n'), 'source', 'notes/filtered-h3.md');
  const child = h3Chunks.find(chunk => chunk.heading === '## Parent > ### Child');
  assert.ok(child);
  assert.equal(child.sourceKey, expectedV2Key('notes/filtered-h3.md', '## Parent', 1, '### Child', 2));
  assert.equal(child.metadata.h2_occurrence, 1);
  assert.equal(child.metadata.h3_occurrence, 2);
});

test('repeated H3s are scoped to their exact repeated H2 occurrence', () => {
  const long = 'parent preamble '.repeat(150);
  const chunks = chunkMarkdown([
    '## Parent', long, '### Child', 'first child body', '### Child', 'second child body',
    '## Parent', long, '### Child', 'third child body', '### Child', 'fourth child body',
  ].join('\n'), 'source', 'notes/nested.md');
  const children = chunks.filter(chunk => chunk.heading === '## Parent > ### Child');

  assert.deepEqual(children.map(chunk => [
    chunk.metadata.h2_occurrence,
    chunk.metadata.h3_occurrence,
    chunk.sourceKey,
  ]), [
    [1, 1, 'file-sync:notes/nested.md:## Parent:### Child'],
    [1, 2, expectedV2Key('notes/nested.md', '## Parent', 1, '### Child', 2)],
    [2, 1, expectedV2Key('notes/nested.md', '## Parent', 2, '### Child', 1)],
    [2, 2, expectedV2Key('notes/nested.md', '## Parent', 2, '### Child', 2)],
  ]);
  assert.equal(new Set(chunks.map(chunk => chunk.sourceKey)).size, chunks.length);
});

test('root, preamble, and first structured occurrences keep legacy keys byte-for-byte', () => {
  assert.equal(
    chunkMarkdown('root body long enough', 'source', 'notes/root.md')[0].sourceKey,
    'file-sync:notes/root.md:(root)',
  );
  const chunks = chunkMarkdown([
    'preamble long enough',
    '## Parent',
    'parent preamble '.repeat(150),
    '### Child',
    'child body',
  ].join('\n'), 'source', 'notes/legacy.md');
  assert.deepEqual(chunks.map(chunk => chunk.sourceKey), [
    'file-sync:notes/legacy.md:(preamble)',
    'file-sync:notes/legacy.md:## Parent',
    'file-sync:notes/legacy.md:## Parent:### Child',
  ]);
});

test('structured v2 framing separates delimiter-like and Unicode tuples', () => {
  const left = buildSourceKey('路径:notes.md', '## A:### B', 2, '### C', 1);
  const right = buildSourceKey('路径:notes.md', '## A', 2, '### B:### C', 1);
  assert.notEqual(left, right);
  assert.equal(left, expectedV2Key('路径:notes.md', '## A:### B', 2, '### C', 1));
  assert.equal(right, expectedV2Key('路径:notes.md', '## A', 2, '### B:### C', 1));
  assert.match(left, /^file-sync:v2:[a-f0-9]{64}$/);
});

test('duplicate emitted source keys fail before downstream embedding can overwrite content', () => {
  assert.throws(() => assertUniqueSourceKeys([
    { sourceKey: 'same' },
    { sourceKey: 'same' },
  ]), /duplicate source key.*same/i);
});
