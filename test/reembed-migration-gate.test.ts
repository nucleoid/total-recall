import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production re-embedding fails closed until #9 identity storage and #61 mixed readers exist', async () => {
  const source = await readFile(new URL('../scripts/reembed-all.ts', import.meta.url), 'utf8');
  assert.match(source, /requireMixedEmbeddingMigrationSupport\(\)/);
  assert.match(source, /#9/);
  assert.match(source, /#61/);

  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/reembed-all.ts'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: 'postgres://must-not-connect.invalid/database',
      EMBEDDING_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'must-not-call-provider',
      EMBEDDING_MODEL: 'gemini-embedding-2-preview',
      EMBEDDING_DIMENSIONS: '768',
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /#9.*#61|#61.*#9/i);
  assert.doesNotMatch(result.stderr, /ENOTFOUND|ECONNREFUSED|Gemini.*request/i);
});
