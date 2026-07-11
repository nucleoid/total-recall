import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { globSync } from 'glob';

const root = join(import.meta.dirname, '..');
const files = globSync('{src,scripts}/**/*.ts', { cwd: root, nodir: true });

test('runtime code does not use process-wide or session-scoped namespace context', () => {
  const offenders = files.flatMap((file) => {
    const text = readFileSync(join(root, file), 'utf8');
    const matches = [
      ...text.matchAll(/setNamespaceContext|getCurrentNamespaces|_currentNamespaces/g),
      ...text.matchAll(/set_config\('app\.allowed_namespaces'[^)]*,\s*false\)/g),
      ...text.matchAll(/SET\s+app\.allowed_namespaces/gi),
    ];
    return matches.map((match) => `${file}: ${match[0]}`);
  });

  assert.deepEqual(offenders, []);
});

test('watcher does not use a synthetic scope key as an api_keys foreign key', () => {
  const watcher = readFileSync(join(root, 'src/watcher.ts'), 'utf8');
  assert.doesNotMatch(watcher, /WATCHER_SCOPE\.keyId/);
});

test('document storage caps chunk count before buffering embeddings', () => {
  const storeDocument = readFileSync(join(root, 'src/tools/store-document.ts'), 'utf8');
  assert.match(storeDocument, /MAX_DOCUMENT_CHUNKS/);
  assert.match(storeDocument, /chunks\.length > MAX_DOCUMENT_CHUNKS/);
});
