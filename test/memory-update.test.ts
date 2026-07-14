import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseSupersededScoreFactor } from '../src/config.js';
import { memoryUpdate, updateSchema } from '../src/tools/update.js';
import type { AuthContext } from '../src/types.js';

const ID = '11111111-1111-4111-8111-111111111111';
const PREDECESSOR = '22222222-2222-4222-8222-222222222222';

test('memory update schema is strict and preserves replacement semantics', () => {
  assert.throws(() => updateSchema.parse({ id: ID }), /update field/i);
  assert.throws(() => updateSchema.parse({ id: ID, content: null }));
  assert.throws(() => updateSchema.parse({ id: ID, content: '   ' }), /blank/i);
  assert.throws(() => updateSchema.parse({ id: ID, tags: [], unknown: true }), /unrecognized/i);
  assert.throws(() => updateSchema.parse({ id: ID, supersedes: ID }), /itself/i);
  assert.throws(() => updateSchema.parse({ id: ID, content: 'x'.repeat(100_001) }));

  assert.deepEqual(updateSchema.parse({
    id: ID.toUpperCase(),
    tags: [],
    metadata: {},
    supersedes: PREDECESSOR.toUpperCase(),
  }), {
    id: ID,
    tags: [],
    metadata: {},
    supersedes: PREDECESSOR,
  });
});

test('memory update denies missing write permission before database work', async () => {
  const auth: AuthContext = {
    keyId: PREDECESSOR,
    name: 'reader',
    namespaces: ['shared'],
    permissions: ['read'],
    maxAccessLevel: 'normal',
  };
  await assert.rejects(
    memoryUpdate({ id: ID, tags: [] }, auth),
    (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'forbidden',
  );
});

test('memory update preserves one database clock and selects validity SQL before mutation', () => {
  const source = readFileSync(new URL('../src/tools/update.ts', import.meta.url), 'utf8');
  assert.match(source, /statement_timestamp\(\)::text AS now/);
  assert.match(source, /FROM pg_attribute[\s\S]*memory_kind[\s\S]*valid_from[\s\S]*valid_to/);
  assert.match(source, /valid_from = .*timestamp.*::timestamptz/);
  assert.match(source, /valid_to = \$1::timestamptz/);
  assert.match(source, /partially deployed; refusing manual supersession/);
  assert.doesNotMatch(source, /query<\{ now: Date \}>/);
  assert.doesNotMatch(source, /42703/);
});

test('superseded score factor defaults and fails closed outside (0, 1]', () => {
  assert.equal(parseSupersededScoreFactor(undefined), 0.25);
  assert.equal(parseSupersededScoreFactor(''), 0.25);
  assert.equal(parseSupersededScoreFactor('1'), 1);
  assert.equal(parseSupersededScoreFactor('0.1'), 0.1);
  for (const invalid of ['0', '-1', '1.1', 'NaN', 'Infinity', 'nope']) {
    assert.throws(() => parseSupersededScoreFactor(invalid), /SUPERSEDED_SCORE_FACTOR/);
  }
});
