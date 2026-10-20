import type pg from 'pg';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID, sha256 } from './local-embedding-contract.js';
import { assertShadowOperator } from './shadow-embedding-audit.js';
import { CURRENT_PARENT_ELIGIBILITY } from './shadow-embedding-store.js';
import { validateShadowHostPlan, type ShadowHostPlan } from './shadow-embedding-resource-guard.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

export interface OperationalResources {
  maxParentsPerBatch: number; maxSourceBytesPerBatch: number; maxTokensPerBatch: number; maxElapsedMsPerBatch: number; maxAttempts: number;
  host: ShadowHostPlan; indexBuild: { maintenanceWorkMemMb: number; maxParallelMaintenanceWorkers: number;
    lockTimeoutMs: number; statementTimeoutMs: number };
}
export interface OperationalRuntime {
  acceptanceReceiptSha256: string; artifactSha256: string; runtimeContract: string;
  expectedRuntimeHost: string; expectedRuntimeMode: 'gpu' | 'cpu'; tls?: {caSha256:string;spkiSha256:string};
}
export interface OperationalManifest {
  version: 1;
  approval: { reference: string; sha256: string; approvedBy: string; approvedAt: string };
  source: { releaseSha: string };
  eligibility: { predicate: string; namespaces: 'all'; includeNullVectors: true; activeSubscriptions: true };
  resources: OperationalResources;
  runtime: OperationalRuntime;
  steadyState?: { resources: OperationalResources; runtime: OperationalRuntime };
}

export interface ManifestEnvelope { manifest: OperationalManifest; manifestSha256: string }

export function canonicalOperationalManifest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalOperationalManifest).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalOperationalManifest(item)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('embedding.operational_manifest');
  return encoded;
}

export function hashOperationalManifest(value: unknown): string { return sha256(canonicalOperationalManifest(value)); }

export function validateOperationalManifest(value: unknown, expectedHash: string): ManifestEnvelope {
  if (!SHA256.test(expectedHash)) throw new Error('embedding.manifest_hash');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('embedding.operational_manifest');
  const m = value as OperationalManifest;
  exactKeys(m as unknown as Record<string, unknown>, m.steadyState===undefined
    ? ['version','approval','source','eligibility','resources','runtime']
    : ['version','approval','source','eligibility','resources','runtime','steadyState']);
  exactKeys(m.approval as unknown as Record<string, unknown>, ['reference','sha256','approvedBy','approvedAt']);
  exactKeys(m.source as unknown as Record<string, unknown>, ['releaseSha']);
  exactKeys(m.eligibility as unknown as Record<string, unknown>, ['predicate','namespaces','includeNullVectors','activeSubscriptions']);
  if (m.version !== 1 || !m.approval || !m.source || !m.eligibility || !m.resources || !m.runtime) throw new Error('embedding.operational_manifest');
  if (typeof m.approval.reference !== 'string' || !m.approval.reference.trim()
    || typeof m.approval.sha256 !== 'string' || !SHA256.test(m.approval.sha256)
    || typeof m.approval.approvedBy !== 'string' || !m.approval.approvedBy.trim()
    || typeof m.approval.approvedAt !== 'string' || !Number.isFinite(Date.parse(m.approval.approvedAt))) throw new Error('embedding.approval_manifest');
  if (typeof m.source.releaseSha !== 'string' || !SHA1.test(m.source.releaseSha)) throw new Error('embedding.release_sha');
  if (m.eligibility.predicate !== CURRENT_PARENT_ELIGIBILITY || m.eligibility.namespaces !== 'all'
    || m.eligibility.includeNullVectors !== true || m.eligibility.activeSubscriptions !== true) throw new Error('embedding.eligibility_contract');
  validateOperationalResources(m.resources);
  validateOperationalRuntime(m.runtime);
  if (m.steadyState !== undefined) {
    if (!m.steadyState || typeof m.steadyState !== 'object' || Array.isArray(m.steadyState)) throw new Error('embedding.operational_manifest');
    exactKeys(m.steadyState as unknown as Record<string, unknown>, ['resources','runtime']);
    validateOperationalResources(m.steadyState.resources);
    validateOperationalRuntime(m.steadyState.runtime);
    if (m.steadyState.runtime.expectedRuntimeMode !== 'cpu') throw new Error('embedding.steady_runtime_mode');
  }
  const actual = hashOperationalManifest(m);
  if (actual !== expectedHash) throw new Error('embedding.manifest_hash_mismatch');
  return { manifest: m, manifestSha256: actual };
}

function validateOperationalResources(resources: OperationalResources): void {
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) throw new Error('embedding.operational_manifest');
  exactKeys(resources as unknown as Record<string, unknown>, ['maxParentsPerBatch','maxSourceBytesPerBatch','maxTokensPerBatch','maxElapsedMsPerBatch','maxAttempts','host','indexBuild']);
  if (!resources.host || typeof resources.host !== 'object' || Array.isArray(resources.host)) throw new Error('embedding.operational_manifest');
  exactKeys(resources.host as unknown as Record<string, unknown>, ['deploymentProfile','expectedHostname','diskPath','minAvailableMemoryBytes',
    'minAvailableDiskBytes','maxLoadPerCpu','maxSwapUsedBytes','maxMemoryPsiAvg10','maxCpuPsiAvg10']);
  if (!resources.indexBuild || typeof resources.indexBuild !== 'object' || Array.isArray(resources.indexBuild)) throw new Error('embedding.operational_manifest');
  exactKeys(resources.indexBuild as unknown as Record<string, unknown>,
    ['maintenanceWorkMemMb','maxParallelMaintenanceWorkers','lockTimeoutMs','statementTimeoutMs']);
  for (const [key, min, max] of [['maxParentsPerBatch', 1, 1000], ['maxSourceBytesPerBatch', 1, 100_000_000],
    ['maxTokensPerBatch', 1, 1_000_000], ['maxElapsedMsPerBatch', 1000, 3_600_000], ['maxAttempts', 1, 10]] as const) {
    const n = resources[key];
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`embedding.limit_${key}`);
  }
  validateShadowHostPlan(resources.host, resources.maxElapsedMsPerBatch, resources.maxParentsPerBatch);
  for (const [key, min, max] of [['maintenanceWorkMemMb',64,4096], ['maxParallelMaintenanceWorkers',0,4],
    ['lockTimeoutMs',100,30_000], ['statementTimeoutMs',60_000,3_600_000]] as const) {
    const n = resources.indexBuild[key];
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`embedding.index_plan_${key}`);
  }
}

function validateOperationalRuntime(runtime: OperationalRuntime): void {
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) throw new Error('embedding.runtime_contract');
  exactKeys(runtime as unknown as Record<string, unknown>,
    runtime.tls===undefined?['acceptanceReceiptSha256','artifactSha256','runtimeContract','expectedRuntimeHost','expectedRuntimeMode']:
      ['acceptanceReceiptSha256','artifactSha256','runtimeContract','expectedRuntimeHost','expectedRuntimeMode','tls']);
  if(runtime.tls!==undefined){if(!runtime.tls||typeof runtime.tls!=='object'||Array.isArray(runtime.tls))throw new Error('embedding.runtime_contract');
    exactKeys(runtime.tls as unknown as Record<string,unknown>,['caSha256','spkiSha256']);}
  if (!SHA256.test(runtime.acceptanceReceiptSha256)
    || runtime.artifactSha256 !== QWEN_CHUNK_CONTRACT.artifactSha256
    || runtime.runtimeContract !== QWEN_CHUNK_CONTRACT.runtimeContract
    || typeof runtime.expectedRuntimeHost !== 'string' || !runtime.expectedRuntimeHost.trim()
    || runtime.expectedRuntimeHost !== runtime.expectedRuntimeHost.trim()
    || !['gpu','cpu'].includes(runtime.expectedRuntimeMode)
    || runtime.tls!==undefined&&(!SHA256.test(runtime.tls.caSha256)||!SHA256.test(runtime.tls.spkiSha256))) throw new Error('embedding.runtime_contract');
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error('embedding.operational_manifest');
}

// Includes future-valid rows that can become eligible solely through passage of time.
const INVENTORY_PARENT_CANDIDACY = `deleted_at IS NULL AND superseded_at IS NULL
  AND consolidated_into_id IS NULL AND (expires_at IS NULL OR expires_at > statement_timestamp())
  AND (valid_to IS NULL OR valid_to > statement_timestamp())`;

async function lockRun(client: pg.PoolClient, expectedDatabase: string, runId: string, envelope: ManifestEnvelope) {
  if (!UUID.test(runId)) throw new Error('embedding.run_id');
  await assertShadowOperator(client, expectedDatabase);
  const result = await client.query(`SELECT id,status,release_sha,manifest FROM embedding_runs
    WHERE id=$1 AND contract_id=$2 FOR UPDATE`, [runId, QWEN_CONTRACT_ID]);
  const run = result.rows[0];
  if (!run || run.release_sha !== envelope.manifest.source.releaseSha
    || hashOperationalManifest(run.manifest) !== envelope.manifestSha256) throw new Error('embedding.run_manifest_identity');
  return run as { id: string; status: string };
}

export async function prepareShadowRun(client: pg.PoolClient, expectedDatabase: string, envelope: ManifestEnvelope) {
  await assertShadowOperator(client, expectedDatabase);
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");
    await client.query(`INSERT INTO embedding_contracts(id,canonical_json,capture_enabled) VALUES($1,$2,false)
      ON CONFLICT(id) DO NOTHING`, [QWEN_CONTRACT_ID, JSON.stringify(QWEN_CHUNK_CONTRACT)]);
    const contract = await client.query('SELECT canonical_json,capture_enabled FROM embedding_contracts WHERE id=$1 FOR UPDATE', [QWEN_CONTRACT_ID]);
    if (!contract.rows[0] || sha256(contract.rows[0].canonical_json) !== QWEN_CONTRACT_ID) throw new Error('embedding.contract_identity');
    if (contract.rows[0].capture_enabled !== false) throw new Error('embedding.capture_already_enabled');
    const partitions = await client.query(`SELECT c.relname,pg_get_expr(c.relpartbound,c.oid) AS bound
      FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
      WHERE i.inhparent='memory_embedding_chunks'::regclass`);
    const matching = partitions.rows.filter(row => String(row.bound).includes(QWEN_CONTRACT_ID));
    if (matching.length > 1) throw new Error('embedding.partition_identity');
    let partition: string;
    if (matching.length === 1) partition = matching[0].relname;
    else {
      partition = `memory_embedding_chunks_${QWEN_CONTRACT_ID.slice(0, 16)}`;
      if (partitions.rows.some(row => row.relname === partition)) throw new Error('embedding.partition_identity');
      await client.query(`CREATE TABLE ${partition} PARTITION OF memory_embedding_chunks FOR VALUES IN ('${QWEN_CONTRACT_ID}')`);
      const verified = await client.query(`SELECT pg_get_expr(c.relpartbound,c.oid) AS bound FROM pg_inherits i
        JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='memory_embedding_chunks'::regclass AND c.relname=$1`, [partition]);
      if (verified.rows.length !== 1 || !String(verified.rows[0].bound).includes(QWEN_CONTRACT_ID)) throw new Error('embedding.partition_identity');
    }
    const created = await client.query(`INSERT INTO embedding_runs(contract_id,release_sha,manifest,status)
      VALUES($1,$2,$3::jsonb,'prepared') RETURNING id,status,source_watermark`,
    [QWEN_CONTRACT_ID, envelope.manifest.source.releaseSha, JSON.stringify(envelope.manifest)]);
    await client.query('COMMIT');
    return { contractId: QWEN_CONTRACT_ID, partition, ...created.rows[0], captureEnabled: false, inventoryComplete: false };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function inventoryShadowPage(client: pg.PoolClient, expectedDatabase: string, runId: string,
  envelope: ManifestEnvelope, limit = 500) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('embedding.inventory_limit');
  // Publish capture before opening the inventory snapshot. A writer that commits
  // before this transaction is visible to the scan; one after it is durably queued.
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");
    const run = await lockRun(client, expectedDatabase, runId, envelope);
    if (!['prepared', 'paused'].includes(run.status)) throw new Error('embedding.inventory_run_state');
    await client.query('UPDATE embedding_contracts SET capture_enabled=true WHERE id=$1', [QWEN_CONTRACT_ID]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'");
    const run = await lockRun(client, expectedDatabase, runId, envelope);
    if (!['prepared', 'paused'].includes(run.status)) throw new Error('embedding.inventory_run_state');
    const state = (await client.query('SELECT memory_cursor,subscription_cursor,inventory_complete FROM embedding_runs WHERE id=$1', [runId])).rows[0];
    if (state.inventory_complete) { await client.query('COMMIT'); return { runId, inventoryComplete: true, inserted: 0 }; }
    let type: 'memory' | 'subscription' = state.memory_cursor === '00000000-0000-0000-0000-000000000000' ? 'subscription' : 'memory';
    let rows;
    if (type === 'memory') {
      rows = await client.query(`SELECT id FROM memories WHERE (${INVENTORY_PARENT_CANDIDACY})
        AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2`, [state.memory_cursor, limit]);
      if (rows.rows.length) {
        await client.query(`INSERT INTO embedding_work_items(contract_id,parent_type,parent_id)
          SELECT $1,'memory',x.id FROM unnest($2::uuid[]) x(id) ON CONFLICT DO NOTHING`, [QWEN_CONTRACT_ID, rows.rows.map(r => r.id)]);
        await client.query('UPDATE embedding_runs SET memory_cursor=$2,updated_at=statement_timestamp() WHERE id=$1', [runId, rows.rows.at(-1).id]);
      } else {
        await client.query(`UPDATE embedding_runs SET memory_cursor='00000000-0000-0000-0000-000000000000',updated_at=statement_timestamp() WHERE id=$1`, [runId]);
        type = 'subscription';
      }
    }
    if (type === 'subscription' && (!rows || rows.rows.length === 0)) {
      rows = await client.query(`SELECT id FROM memory_subscriptions WHERE status='active'
        AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2`, [state.subscription_cursor, limit]);
      if (rows.rows.length) {
        await client.query(`INSERT INTO embedding_work_items(contract_id,parent_type,parent_id)
          SELECT $1,'subscription',x.id FROM unnest($2::uuid[]) x(id) ON CONFLICT DO NOTHING`, [QWEN_CONTRACT_ID, rows.rows.map(r => r.id)]);
        await client.query('UPDATE embedding_runs SET subscription_cursor=$2,updated_at=statement_timestamp() WHERE id=$1', [runId, rows.rows.at(-1).id]);
      } else await client.query(`UPDATE embedding_runs SET inventory_complete=true,updated_at=statement_timestamp() WHERE id=$1`, [runId]);
    }
    const finalState = (await client.query('SELECT inventory_complete,memory_cursor,subscription_cursor FROM embedding_runs WHERE id=$1', [runId])).rows[0];
    await client.query('COMMIT');
    return { runId, parentType: type, inserted: rows?.rows.length ?? 0, ...finalState };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function setShadowRunState(client: pg.PoolClient, expectedDatabase: string, runId: string,
  envelope: ManifestEnvelope, action: 'start' | 'pause' | 'resume') {
  await client.query('BEGIN');
  try {
    const run = await lockRun(client, expectedDatabase, runId, envelope);
    const expected = action === 'start' ? 'prepared' : action === 'pause' ? 'running' : 'paused';
    if (run.status !== expected) throw new Error('embedding.run_state');
    if (action === 'start') {
      const inventory = await client.query('SELECT inventory_complete FROM embedding_runs WHERE id=$1', [runId]);
      if (inventory.rows[0]?.inventory_complete !== true) throw new Error('embedding.inventory_incomplete');
    }
    const status = action === 'pause' ? 'paused' : 'running';
    await client.query(`UPDATE embedding_runs SET status=$2,last_error_code=NULL,updated_at=statement_timestamp() WHERE id=$1`, [runId, status]);
    await client.query('COMMIT'); return { runId, status };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function requeueShadowItems(client: pg.PoolClient, expectedDatabase: string, runId: string,
  envelope: ManifestEnvelope, parentType: 'memory' | 'subscription', parentIds: string[]) {
  if (!parentIds.length || parentIds.length > 1000 || parentIds.some(id => !UUID.test(id)) || new Set(parentIds).size !== parentIds.length) {
    throw new Error('embedding.requeue_ids');
  }
  await client.query('BEGIN');
  try {
    const run = await lockRun(client, expectedDatabase, runId, envelope);
    if (!['prepared', 'paused'].includes(run.status)) throw new Error('embedding.requeue_run_state');
    const result = await client.query(`UPDATE embedding_work_items SET state='retry',attempts=0,next_attempt_at=statement_timestamp(),
      claimed_by=NULL,lease_until=NULL,error_code=NULL,updated_at=statement_timestamp()
      WHERE contract_id=$1 AND parent_type=$2 AND parent_id=ANY($3::uuid[]) AND state='failed' RETURNING parent_id`,
    [QWEN_CONTRACT_ID, parentType, parentIds]);
    if (result.rowCount !== parentIds.length) throw new Error('embedding.requeue_exact_match');
    await client.query('COMMIT'); return { runId, parentType, requeued: result.rows.map(r => r.parent_id) };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
