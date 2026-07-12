import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_DOCUMENT_CHUNK_BYTES,
  MAX_DOCUMENT_CONTENT_BYTES,
  chunkDocumentContent,
  storeDocumentSchema,
} from '../src/tools/store-document.js';

function assertLosslessAndBounded(content: string): string[] {
  const chunks = chunkDocumentContent(content);
  assert.ok(chunks.length > 0);
  assert.equal(chunks.join(''), content);
  assert.deepEqual(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'utf8'))),
    Buffer.from(content, 'utf8')
  );
  for (const chunk of chunks) {
    assert.notEqual(chunk, '');
    assert.ok(
      Buffer.byteLength(chunk, 'utf8') <= MAX_DOCUMENT_CHUNK_BYTES,
      `chunk was ${Buffer.byteLength(chunk, 'utf8')} bytes`
    );
  }
  return chunks;
}

test('chunking preserves markdown, paragraph delimiters, CRLF, and repeated blank lines', () => {
  const content = [
    '# First\r\n',
    'intro\r\n\r\n\r\n',
    '## Second\n',
    `${'x'.repeat(2_500)}\n\n`,
    '### Third\n',
    'tail',
  ].join('');

  assertLosslessAndBounded(content);
});

test('hard splitting is UTF-8-byte bounded and never splits a Unicode code point', () => {
  const content = `${'a'.repeat(MAX_DOCUMENT_CHUNK_BYTES - 1)}😀e\u0301${'界'.repeat(900)}`;
  const chunks = assertLosslessAndBounded(content);

  assert.equal(chunks[0], 'a'.repeat(MAX_DOCUMENT_CHUNK_BYTES - 1));
  assert.ok(chunks[1].startsWith('😀'));
  assert.ok(chunks.every((chunk) => !chunk.includes('\uFFFD')));
});

test('exactly 2,000 UTF-8 bytes fit and the next code point starts a new chunk', () => {
  const exact = '😀'.repeat(MAX_DOCUMENT_CHUNK_BYTES / 4);
  assert.deepEqual(assertLosslessAndBounded(exact), [exact]);

  const crossing = `${'a'.repeat(MAX_DOCUMENT_CHUNK_BYTES - 1)}😀`;
  assert.deepEqual(assertLosslessAndBounded(crossing), [
    'a'.repeat(MAX_DOCUMENT_CHUNK_BYTES - 1),
    '😀',
  ]);
});

test('500 KB minified ASCII and multibyte documents produce only embedding-safe chunks', () => {
  for (const content of ['x'.repeat(500_000), '😀'.repeat(125_000)]) {
    const chunks = assertLosslessAndBounded(content);
    assert.ok(chunks.length > 1);
  }
});

test('document schema accepts exactly 1 MiB decoded UTF-8 and rejects one byte over', () => {
  const base = { title: 'limits' };
  const exactAscii = 'x'.repeat(MAX_DOCUMENT_CONTENT_BYTES);
  assert.equal(storeDocumentSchema.parse({ ...base, content: exactAscii }).content, exactAscii);

  const exactEmoji = '😀'.repeat(MAX_DOCUMENT_CONTENT_BYTES / 4);
  assert.equal(storeDocumentSchema.parse({ ...base, content: exactEmoji }).content, exactEmoji);

  for (const content of [`${exactAscii}x`, `${exactEmoji}x`]) {
    const result = storeDocumentSchema.safeParse({ ...base, content });
    assert.equal(result.success, false);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join(' ');
      assert.match(message, /1 MiB.*UTF-8/i);
      assert.doesNotMatch(message, new RegExp(content.slice(0, 100)));
    }
  }
});

test('document schema rejects empty and whitespace-only decoded content', () => {
  for (const content of ['', ' \t\r\n\u00a0']) {
    const result = storeDocumentSchema.safeParse({ title: 'blank', content });
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, /non-whitespace/i);
  }
});
