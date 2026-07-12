import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const source = await fs.readFile(new URL('../../src/watcher.ts', import.meta.url), 'utf8');

test('watcher routes add, change, and unlink through the per-path queue', () => {
  assert.match(source, /new PathWorkQueue/);
  assert.match(source, /\.on\('add', \(fp\) => queue\.enqueue\(fp\)\)/);
  assert.match(source, /\.on\('change', \(fp\) => queue\.enqueue\(fp\)\)/);
  assert.match(source, /\.on\('unlink', \(fp\) => queue\.enqueue\(fp\)\)/);
  assert.doesNotMatch(source, /const pending = new Map/);
});

test('watcher hashes preparation and currentness reads through the same UTF-8 decoding', () => {
  assert.match(source, /fs\.promises\.readFile\(filePath, 'utf8'\)/);
  assert.match(source, /fs\.readFileSync\(filePath, 'utf-8'\)/);
});

test('watcher shutdown uses the ordered queue drain before database shutdown', () => {
  assert.match(source, /shutdownWatcher\(\{/);
  assert.match(source, /shutdownDatabase: shutdown/);
});
