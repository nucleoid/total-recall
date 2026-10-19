import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID, QWEN_QUERY_PREFIX, formatLocalEmbeddingInput,
  projectQwenVector, sha256, validateEmbeddingText, validateLocalStoredVector } from '../src/local-embedding-contract.js';
import { planEmbeddingChunks, validateParentChunkPlan } from '../src/embedding-chunks.js';

const count = async (text: string) => Array.from(text).length + 2;

test('contract pins exact query bytes, artifact, runtime, dimensions and projection', () => {
  assert.equal(sha256(QWEN_QUERY_PREFIX), QWEN_CHUNK_CONTRACT.queryPrefixSha256);
  assert.equal(QWEN_CONTRACT_ID.length, 64);
  assert.equal(formatLocalEmbeddingInput('where?', 'query'), QWEN_QUERY_PREFIX + 'where?');
  assert.equal(formatLocalEmbeddingInput(' raw\r\n', 'document'), ' raw\r\n');
  assert.throws(() => formatLocalEmbeddingInput('x', 'unknown' as 'query'), /invalid_role/);
  assert.ok(Object.isFrozen(QWEN_CHUNK_CONTRACT));
});

for (const [label, input] of Object.entries({
  empty: '', whitespace: ' \t\r\n\r\n  ', code: 'function x() {\r\n return "a";\r\n}\r\n\r\n// tail',
  unicode: ('漢字🙂e\u0301\r\n\r\n').repeat(90), unbroken: 'x'.repeat(81439),
  paragraphs: ('paragraph '.repeat(20) + '\n\n').repeat(12) + 'critical tail',
  specialWhitespace: 'a\n\u0085\n\nβ\r\n\u001c\r\nlast',
})) {
  test(`chunks preserve exact UTF-8 bytes, bounds and deterministic identity: ${label}`, async () => {
    const plan = await planEmbeddingChunks(input, count);
    assert.deepEqual(await planEmbeddingChunks(input, count), plan);
    assert.equal(plan.sourceBytes, Buffer.byteLength(input));
    assert.equal(plan.chunks.map(chunk => chunk.text).join(''), input);
    validateParentChunkPlan(input, plan);
    for (const chunk of plan.chunks) {
      assert.equal(chunk.tokens, await count(chunk.text));
      assert.ok(chunk.tokens <= 256);
      assert.equal(Buffer.from(input).subarray(chunk.coreStart, chunk.coreEnd).toString('utf8'), chunk.text);
    }
    if (input) assert.throws(() => validateParentChunkPlan(input + '!', plan), /plan_identity/);
  });
}

test('short final paragraph is isolated even when combined paragraph fits', async () => {
  const plan = await planEmbeddingChunks('first paragraph\r\n\r\ncritical tail', count);
  assert.deepEqual(plan.chunks.map(x => x.text), ['first paragraph\r\n\r\n', 'critical tail']);
});

test('token counts need not be monotonic with character length', async () => {
  const plan = await planEmbeddingChunks('a'.repeat(1024), async text => text.length === 1024 ? 2000 : 100);
  assert.equal(plan.chunks.length, 2);
  assert.equal(plan.chunks[0].text.length, 512);
});

test('invalid source and tokenization fail before a manifest can be accepted', async () => {
  for (const input of ['\u0000', '\ud800', '\udfff', 'x\ud800!']) {
    assert.throws(() => validateEmbeddingText(input));
    await assert.rejects(planEmbeddingChunks(input, count));
  }
  await assert.rejects(planEmbeddingChunks('🙂', async () => 257), /codepoint_over_token_limit/);
  for (const bad of [NaN, Infinity, -1, 0.5]) await assert.rejects(planEmbeddingChunks('x', async () => bad), /invalid_token_count/);
  assert.throws(() => validateEmbeddingText('x'.repeat(1_048_577)), /parent_byte_limit/);
});

test('manifest rejects missing ordinals, gaps, hash changes and partial reconstruction', async () => {
  const source = 'first\n\nlast';
  const plan = await planEmbeddingChunks(source, count);
  for (const mutate of [
    (p: typeof plan) => { p.chunks[0].ordinal = 4; },
    (p: typeof plan) => { p.chunks[1].coreStart++; },
    (p: typeof plan) => { p.chunks[0].sha256 = '0'.repeat(64); },
    (p: typeof plan) => { p.chunks.pop(); },
    (p: typeof plan) => { p.chunks[0].tokens = 257; },
  ]) {
    const bad = structuredClone(plan); mutate(bad);
    assert.throws(() => validateParentChunkPlan(source, bad));
  }
});

test('native projection crops before normalization and rejects malformed responses', () => {
  const native = Array.from({ length: 1024 }, (_, i) => i < 768 ? 2 : 10_000);
  const stored = projectQwenVector(native);
  validateLocalStoredVector(stored);
  assert.equal(stored.length, 768);
  assert.ok(Math.abs(stored[0] - 1 / Math.sqrt(768)) < 1e-12);
  for (const bad of [null, [], Array(768).fill(1), Array(1024).fill(0),
    [NaN, ...native.slice(1)], [Infinity, ...native.slice(1)], [true, ...native.slice(1)],
    [...Array(768).fill(0), ...Array(256).fill(1)]]) assert.throws(() => projectQwenVector(bad));
  assert.throws(() => validateLocalStoredVector(Array(768).fill(1)), /stored_norm/);
  assert.throws(() => validateLocalStoredVector(Array(768).fill(NaN)), /stored_vector/);
});
