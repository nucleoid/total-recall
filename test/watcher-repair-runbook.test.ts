import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');

test('orphan repair has an explicit owner-run command and no automatic lifecycle hook', () => {
  assert.equal(packageJson.scripts['repair:watcher-orphans'], 'tsx scripts/repair-watcher-orphans.ts');
  for (const hook of ['prestart', 'start', 'watcher', 'start:watcher', 'postinstall']) {
    assert.doesNotMatch(packageJson.scripts[hook] ?? '', /repair-watcher-orphans/);
  }
});

test('watcher runbook preserves preview-first explicit approval for historical rows', () => {
  assert.match(readme, /migration 020.*before.*watcher.*all (?:file )?sync.*fail/is);
  assert.match(readme, /verified restorable backup/i);
  assert.match(readme, /--preview/i);
  assert.match(readme, /authoritative.*workspace/i);
  assert.match(readme, /independently confirm/i);
  assert.match(readme, /exact (?:row )?IDs.*paths/i);
  assert.match(readme, /--apply/i);
  assert.match(readme, /unverified.*unchanged/i);
  assert.doesNotMatch(readme, /No duplicates, no stale entries/);
});
