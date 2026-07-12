import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const source = await fs.readFile(new URL('../../src/watcher.ts', import.meta.url), 'utf8');

test('watcher resolves and validates configured workspace before database or Chokidar startup', () => {
  assert.match(source, /resolveWorkspaceRoot\(process\.env\.OPENCLAW_WORKSPACE/);
  const validation = source.indexOf('resolveWorkspaceRoot(process.env.OPENCLAW_WORKSPACE');
  assert.ok(validation >= 0);
  assert.ok(validation < source.indexOf('upsertSystemAgent('));
  assert.ok(validation < source.indexOf('chokidar.watch('));
});

test('watcher routes add, change, and unlink through the per-path queue', () => {
  assert.match(source, /new PathWorkQueue/);
  assert.match(source, /const enqueue = \(filePath: string\) => queue\.enqueue\(resolveWorkspaceFile\(WORKSPACE, filePath\)\.absolutePath\)/);
  assert.match(source, /\.on\('add', enqueue\)/);
  assert.match(source, /\.on\('change', enqueue\)/);
  assert.match(source, /\.on\('unlink', enqueue\)/);
  assert.doesNotMatch(source, /const pending = new Map/);
});

test('watcher preserves the body-content DELIVERABLE exclusion owned by issue #32', () => {
  const processFile = source.indexOf('async function processFile(');
  const contentRead = source.indexOf("const content = fs.readFileSync(absolutePath, 'utf-8')", processFile);
  const exclusion = source.indexOf("if (content.includes('DELIVERABLE')) return;", processFile);
  const hash = source.indexOf("crypto.createHash('sha256').update(content)", processFile);

  assert.ok(contentRead >= 0);
  assert.ok(exclusion > contentRead, 'content exclusion must run after reading the file');
  assert.ok(exclusion < hash, 'content exclusion must run before hashing, embedding, or persistence');
});

test('watcher hashes preparation and currentness reads through the same UTF-8 decoding', () => {
  assert.match(source, /fs\.promises\.readFile\(filePath, 'utf8'\)/);
  assert.match(source, /fs\.readFileSync\(absolutePath, 'utf-8'\)/);
});

test('watcher shutdown uses the ordered queue drain before database shutdown', () => {
  assert.match(source, /shutdownWatcher\(\{/);
  assert.match(source, /shutdownDatabase: shutdown/);
});
