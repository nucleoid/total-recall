import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('connector launcher uses only release-contained compiled entrypoints', async () => {
  const source = await readFile(new URL('../scripts/run-connector-sync.sh', import.meta.url), 'utf8');
  assert.match(source, /dist\/connector-runtime\/spotify\.js/);
  assert.match(source, /dist\/connector-runtime\/ytmusic\.js/);
  assert.doesNotMatch(source, /tsx\/dist\/cli|scripts\/.*-sync\.ts/);
  assert.match(source, /obsolete phase arguments are not supported/);
});
