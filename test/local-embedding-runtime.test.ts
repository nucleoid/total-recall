import assert from 'node:assert/strict';
import test from 'node:test';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import { getLocalServingClient, localServingEnabled } from '../src/local-embedding-runtime.js';

const valid = {
  SHADOW_EMBEDDING_CURRENT_CONTRACT: QWEN_CONTRACT_ID,
  SHADOW_EMBEDDING_URL: 'http://127.0.0.1:18089',
  SHADOW_EMBEDDING_API_KEY: 'fixture',
  SHADOW_EMBEDDING_RUNTIME_JSON: JSON.stringify({
    contractId: QWEN_CONTRACT_ID,
    artifactSha256: QWEN_CHUNK_CONTRACT.artifactSha256,
    runtimeContract: QWEN_CHUNK_CONTRACT.runtimeContract,
    acceptanceReceiptSha256: 'a'.repeat(64),
  }),
};

test('local serving is opt-in by exact immutable contract id', () => {
  assert.equal(localServingEnabled({}), false);
  assert.equal(localServingEnabled(valid), true);
  assert.throws(() => localServingEnabled({ SHADOW_EMBEDDING_CURRENT_CONTRACT: 'unknown' }), /unknown_serving_contract/);
  assert.throws(() => localServingEnabled({ SHADOW_EMBEDDING_CURRENT_CONTRACT: ` ${QWEN_CONTRACT_ID}` }), /unknown_serving_contract/);
});

test('local serving runtime JSON is strict and identity verified', () => {
  assert.ok(getLocalServingClient(valid));
  assert.throws(() => getLocalServingClient({ ...valid, SHADOW_EMBEDDING_RUNTIME_JSON: '{' }), /runtime_json/);
  assert.throws(() => getLocalServingClient({
    ...valid,
    SHADOW_EMBEDDING_RUNTIME_JSON: JSON.stringify({ ...JSON.parse(valid.SHADOW_EMBEDDING_RUNTIME_JSON), extra: true }),
  }), /runtime_shape/);
  assert.throws(() => getLocalServingClient({
    ...valid,
    SHADOW_EMBEDDING_RUNTIME_JSON: JSON.stringify({ ...JSON.parse(valid.SHADOW_EMBEDDING_RUNTIME_JSON), contractId: 'wrong' }),
  }), /runtime_identity/);
});
