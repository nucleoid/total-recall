import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(path, 'utf8');

test('environment, command, and connector docs describe explicit IANA calendar semantics', () => {
  const env = read('.env.example');
  assert.match(env, /MEDIA_TIME_ZONE=America\/Chicago/);
  assert.match(env, /default.*UTC/i);

  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['media:repair-dates'], 'tsx scripts/repair-media-rollup-dates.ts');

  const readme = read('README.md');
  assert.match(readme, /summary (?:text|content).*vector.*tags.*metadata/i);
  assert.match(readme, /skippedConcurrent[^\n]*final[^\n]*no-cursor/i);

  for (const path of ['README.md', 'docs/connectors/spotify.md', 'docs/connectors/ytmusic.md', 'docs/connectors/plex.md']) {
    const content = read(path);
    assert.match(content, /MEDIA_TIME_ZONE/);
    assert.match(content, /IANA/);
    assert.match(content, /UTC/);
  }
});
