import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const readme = await fs.readFile(new URL('../../README.md', import.meta.url), 'utf8');

test('watcher tests have one common unit and DB reconciliation command', () => {
  assert.equal(
    packageJson.scripts['test:watcher'],
    'node --test --test-concurrency=1 --import ./test/setup-embedding-env.mjs --import tsx "test/watcher/**/*.test.ts"',
  );
});

test('watcher runbook documents duplicate-heading identity and upgrade behavior', () => {
  assert.match(readme, /duplicate headings?.*one-based occurrence/is);
  assert.match(readme, /first occurrence.*legacy source key/is);
  assert.match(readme, /file-sync:v2:/i);
  assert.match(readme, /h2_occurrence.*h3_occurrence/is);
  assert.match(readme, /stop (?:every|all) old watcher/is);
  assert.match(readme, /embedding-provider quota/i);
  assert.match(readme, /rollback.*stale/is);
});
