import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('private evaluation datasets and artifacts remain ignored', async () => {
  const ignore = await readFile('.gitignore', 'utf8');
  assert.match(ignore, /^eval\/private\/$/m);
  assert.match(ignore, /^\*\.eval-report\.json$/m);
  assert.match(ignore, /^\*\.eval-baseline\.json$/m);
});
