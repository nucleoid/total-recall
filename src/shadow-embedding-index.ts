import type pg from 'pg';
import { QWEN_CONTRACT_ID } from './local-embedding-contract.js';
import { assertShadowOperator } from './shadow-embedding-audit.js';
import { hashOperationalManifest, type ManifestEnvelope } from './shadow-embedding-control.js';

export interface ShadowIndexPlan { maintenanceWorkMemMb: number; maxParallelMaintenanceWorkers: number; lockTimeoutMs: number; statementTimeoutMs: number }
export interface ShadowIndexStatus { partition: string; index: string; exists: boolean; valid: boolean; ready: boolean; definition?: string }
const INDEX = `memory_embedding_chunks_${QWEN_CONTRACT_ID.slice(0, 12)}_hnsw`;

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
export function validateShadowIndexPlan(value: unknown): ShadowIndexPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('embedding.index_plan');
  const plan = value as ShadowIndexPlan;
  const fields = ['maintenanceWorkMemMb','maxParallelMaintenanceWorkers','lockTimeoutMs','statementTimeoutMs'];
  if (Object.keys(plan).length !== fields.length || Object.keys(plan).some(key => !fields.includes(key))) throw new Error('embedding.index_plan');
  for (const [key,min,max] of [['maintenanceWorkMemMb',64,4096],['maxParallelMaintenanceWorkers',0,4],
    ['lockTimeoutMs',100,30_000],['statementTimeoutMs',60_000,3_600_000]] as const) {
    if (!Number.isSafeInteger(plan[key]) || plan[key]<min || plan[key]>max) throw new Error(`embedding.index_${key}`);
  }
  return plan;
}

async function partition(client: pg.PoolClient): Promise<string> {
  const result = await client.query(`SELECT c.relname FROM pg_inherits h JOIN pg_class c ON c.oid=h.inhrelid
    WHERE h.inhparent='public.memory_embedding_chunks'::regclass
      AND pg_get_expr(c.relpartbound,c.oid) LIKE '%'||$1||'%'`, [QWEN_CONTRACT_ID]);
  if (result.rows.length !== 1) throw new Error('embedding.partition_identity');
  return result.rows[0].relname;
}

export async function inspectShadowIndex(client: pg.PoolClient, expectedDatabase: string): Promise<ShadowIndexStatus> {
  await assertShadowOperator(client, expectedDatabase);
  const table = await partition(client);
  const result = await client.query(`SELECT i.indisvalid AS valid,i.indisready AS ready,pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=$1::regclass AND c.relname=$2`,
  [`public.${table}`, INDEX]);
  const row = result.rows[0];
  const exact = row?.valid === true && row?.ready === true && String(row?.definition).includes('USING hnsw')
    && String(row?.definition).includes('vector_cosine_ops');
  return { partition: table, index: INDEX, exists: Boolean(row), valid: exact, ready: row?.ready === true,
    definition: row?.definition };
}

async function assertRunBinding(client: pg.PoolClient, expectedDatabase: string, runId: string, envelope: ManifestEnvelope,
  states: string[]) {
  await assertShadowOperator(client, expectedDatabase);
  const result = await client.query('SELECT status,release_sha,manifest FROM embedding_runs WHERE id=$1 AND contract_id=$2', [runId,QWEN_CONTRACT_ID]);
  const run = result.rows[0];
  if (!run || !states.includes(run.status) || run.release_sha!==envelope.manifest.source.releaseSha
    || hashOperationalManifest(run.manifest)!==envelope.manifestSha256) throw new Error('embedding.run_manifest_identity');
}

export async function buildShadowIndex(client: pg.PoolClient, expectedDatabase: string, runId: string,
  envelope: ManifestEnvelope, planValue: unknown): Promise<ShadowIndexStatus> {
  const plan = validateShadowIndexPlan(planValue);
  const approved = validateShadowIndexPlan(envelope.manifest.resources.indexBuild);
  if ((Object.keys(approved) as Array<keyof ShadowIndexPlan>).some(key=>plan[key]!==approved[key])) {
    throw new Error('embedding.index_plan_manifest_mismatch');
  }
  await assertRunBinding(client, expectedDatabase, runId, envelope, ['prepared','paused']);
  const before = await inspectShadowIndex(client, expectedDatabase);
  if (before.exists) {
    if (!before.valid || !before.ready || !before.definition?.includes('USING hnsw')
      || !before.definition.includes('vector_cosine_ops')) throw new Error('embedding.index_invalid');
    return before;
  }
  try {
    await client.query(`SET maintenance_work_mem='${plan.maintenanceWorkMemMb}MB'`);
    await client.query(`SET max_parallel_maintenance_workers=${plan.maxParallelMaintenanceWorkers}`);
    await client.query(`SET lock_timeout='${plan.lockTimeoutMs}ms'`);
    await client.query(`SET statement_timeout='${plan.statementTimeoutMs}ms'`);
    await client.query(`CREATE INDEX CONCURRENTLY ${quoteIdentifier(INDEX)} ON public.${quoteIdentifier(before.partition)}
      USING hnsw (embedding vector_cosine_ops) WITH (m=16,ef_construction=64)`);
  } finally {
    await client.query('RESET maintenance_work_mem; RESET max_parallel_maintenance_workers; RESET lock_timeout; RESET statement_timeout');
  }
  const after = await inspectShadowIndex(client, expectedDatabase);
  if (!after.exists || !after.valid || !after.ready || !after.definition?.includes('vector_cosine_ops')) throw new Error('embedding.index_invalid');
  return after;
}

export async function completeShadowRun(client: pg.PoolClient, expectedDatabase: string, runId: string,
  envelope: ManifestEnvelope, attestation: unknown, cutoverWatermark: string) {
  if (!Number.isFinite(Date.parse(cutoverWatermark))) throw new Error('embedding.cutover_watermark');
  const plan=validateShadowIndexPlan(envelope.manifest.resources.indexBuild);
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout='${plan.lockTimeoutMs}ms'; SET LOCAL statement_timeout='${plan.statementTimeoutMs}ms'; SET LOCAL work_mem='16MB'`);
    await assertRunBinding(client, expectedDatabase, runId, envelope, ['paused']);
    const result = await client.query(`UPDATE embedding_runs SET status='complete',completion_attestation=$2::jsonb,
      cutover_watermark=$3::timestamptz,updated_at=statement_timestamp() WHERE id=$1 RETURNING id,status,cutover_watermark`,
    [runId,JSON.stringify(attestation),cutoverWatermark]);
    await client.query('COMMIT'); return result.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
