import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkMarkdown, extractFrontmatter } from '../../src/watcher/chunking.js';

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
