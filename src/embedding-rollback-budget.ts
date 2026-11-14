import { getPool } from './db.js';
import { QWEN_CONTRACT_ID } from './local-embedding-contract.js';

export interface RollbackBudgetQueryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
}

/** Explicit, globally budgeted temporary Gemini rollback writes after target cutover. */
export async function reserveLegacyRollbackEmbeddingInputs(
  count: number,
  database: RollbackBudgetQueryable = getPool(),
): Promise<void> {
  const target = process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error('embedding.rollback_batch_limit');
  if (target && target !== QWEN_CONTRACT_ID) throw new Error('embedding.unknown_serving_contract');

  // Catalog discovery is safe before migration 040 and does not reference an
  // absent relation, so a legacy deployment remains valid without poisoning a
  // caller transaction.
  const capability = await database.query(`SELECT
    to_regclass('public.embedding_serving_settings')::text AS serving_table,
    to_regprocedure('public.reserve_embedding_rollback_inputs(integer)')::text AS reservation_function`);
  const available = capability.rows[0];
  if (!available?.serving_table) {
    if (!target) return;
    throw new Error('embedding.rollback_budget_unavailable');
  }

  const setting = await database.query('SELECT contract_id FROM public.embedding_serving_settings WHERE singleton');
  const databaseTarget = setting.rows[0]?.contract_id;
  if (!databaseTarget) {
    if (!target) return;
    throw new Error('embedding.rollback_budget_unavailable');
  }
  if (databaseTarget !== QWEN_CONTRACT_ID || target !== databaseTarget) {
    throw new Error('embedding.serving_contract_mismatch');
  }
  if (process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES !== 'true') throw new Error('embedding.rollback_not_approved');
  if (!available.reservation_function) throw new Error('embedding.rollback_budget_unavailable');
  const result = await database.query(
    'SELECT public.reserve_embedding_rollback_inputs($1::integer) AS accepted', [count]);
  if (result.rows[0]?.accepted !== true) throw new Error('embedding.rollback_budget_unavailable');
}
