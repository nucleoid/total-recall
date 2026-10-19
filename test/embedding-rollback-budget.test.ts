import test from 'node:test';
import assert from 'node:assert/strict';
import { QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import { reserveLegacyRollbackEmbeddingInputs, type RollbackBudgetQueryable } from '../src/embedding-rollback-budget.js';
import { createMaintenanceEmbedder } from '../scripts/lib/maintenance-embedding.js';

const profile = {
  provider: 'gemini' as const, apiKey: 'synthetic',
  model: 'gemini-embedding-2-preview' as const, dimensions: 768 as const,
};

async function withEnvironment(run: () => Promise<void>): Promise<void> {
  const target = process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  const rollback = process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
  try { await run(); } finally {
    if (target === undefined) delete process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
    else process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = target;
    if (rollback === undefined) delete process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
    else process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES = rollback;
  }
}

test('legacy pre-migration and pre-target databases retain Gemini behavior', () => withEnvironment(async () => {
  delete process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  const database: RollbackBudgetQueryable = { query: async sql => {
    assert.match(sql, /to_regclass/);
    return { rows: [{ serving_table: null, reservation_function: null }] };
  } };
  await reserveLegacyRollbackEmbeddingInputs(3, database);
}));

test('database target is authoritative when environment is missing or stale', () => withEnvironment(async () => {
  const queries: string[] = [];
  const database: RollbackBudgetQueryable = { query: async sql => {
    queries.push(sql);
    if (sql.includes('to_regclass')) return { rows: [{ serving_table: 'embedding_serving_settings', reservation_function: 'reserve_embedding_rollback_inputs(integer)' }] };
    if (sql.includes('SELECT contract_id')) return { rows: [{ contract_id: QWEN_CONTRACT_ID }] };
    throw new Error('reservation must not be reached');
  } };
  delete process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  await assert.rejects(reserveLegacyRollbackEmbeddingInputs(3, database), /serving_contract_mismatch/);
  process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = 'unknown';
  await assert.rejects(reserveLegacyRollbackEmbeddingInputs(3, database), /unknown_serving_contract/);
  assert.equal(queries.some(sql => sql.includes('reserve_embedding_rollback_inputs($1')), false);
}));

test('maintenance denial prevents fetch and reservation uses the supplied database', () => withEnvironment(async () => {
  process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = QWEN_CONTRACT_ID;
  process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES = 'true';
  let fetches = 0, reservations = 0;
  const database: RollbackBudgetQueryable = { query: async (sql, values) => {
    if (sql.includes('to_regclass')) return { rows: [{ serving_table: 'embedding_serving_settings', reservation_function: 'reserve_embedding_rollback_inputs(integer)' }] };
    if (sql.includes('SELECT contract_id')) return { rows: [{ contract_id: QWEN_CONTRACT_ID }] };
    reservations++; assert.deepEqual(values, [2]); return { rows: [{ accepted: false }] };
  } };
  const embed = createMaintenanceEmbedder(profile, async () => {
    fetches++; throw new Error('fetch must not run');
  }, database);
  await assert.rejects(embed(['one', 'two']), /rollback_budget_unavailable/);
  assert.equal(reservations, 1);
  assert.equal(fetches, 0);
}));

test('approved rollback reserves before maintenance fetch', () => withEnvironment(async () => {
  process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = QWEN_CONTRACT_ID;
  process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES = 'true';
  const order: string[] = [];
  const database: RollbackBudgetQueryable = { query: async sql => {
    if (sql.includes('to_regclass')) return { rows: [{ serving_table: 'embedding_serving_settings', reservation_function: 'reserve_embedding_rollback_inputs(integer)' }] };
    if (sql.includes('SELECT contract_id')) return { rows: [{ contract_id: QWEN_CONTRACT_ID }] };
    order.push('reserve'); return { rows: [{ accepted: true }] };
  } };
  const embed = createMaintenanceEmbedder(profile, async () => {
    order.push('fetch');
    return new Response(JSON.stringify({ embeddings: [{ values: Array(768).fill(0) }] }), { status: 200 });
  }, database);
  await embed(['one']);
  assert.deepEqual(order, ['reserve', 'fetch']);
  for (const count of [0, -1, 1001, NaN, 0.5]) {
    await assert.rejects(reserveLegacyRollbackEmbeddingInputs(count, database), /rollback_batch_limit/);
  }
}));
