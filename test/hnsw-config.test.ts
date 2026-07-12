import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parseHnswEfSearch } from '../src/config.js';

test('parseHnswEfSearch defaults unset, empty, and whitespace-only values to 200', () => {
  assert.equal(parseHnswEfSearch(undefined), 200);
  assert.equal(parseHnswEfSearch(''), 200);
  assert.equal(parseHnswEfSearch('   \t\n'), 200);
});

test('parseHnswEfSearch accepts canonical integers with surrounding whitespace in pgvector range', () => {
  assert.equal(parseHnswEfSearch('1'), 1);
  assert.equal(parseHnswEfSearch('200'), 200);
  assert.equal(parseHnswEfSearch('1000'), 1000);
  assert.equal(parseHnswEfSearch(' 1'), 1);
  assert.equal(parseHnswEfSearch('200 '), 200);
  assert.equal(parseHnswEfSearch('\t1000\n'), 1000);

  for (const raw of ['0', '1001', '-1', '+200', '200x', '2.5', 'NaN', '001']) {
    assert.throws(
      () => parseHnswEfSearch(raw),
      /HNSW_EF_SEARCH must be a decimal integer from 1 to 1000/
    );
  }
});

test('invalid HNSW_EF_SEARCH fails during search module startup', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "import './src/search.ts'; console.log('search module loaded');",
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        HNSW_EF_SEARCH: '200x',
      },
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /HNSW_EF_SEARCH must be a decimal integer from 1 to 1000/);
  assert.doesNotMatch(result.stdout, /search module loaded/);
});
