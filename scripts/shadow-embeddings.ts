import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { auditShadowPage } from '../src/shadow-embedding-audit.js';
import { readShadowEmbeddingStatus } from '../src/shadow-embedding-status.js';
import { inventoryShadowPage, prepareShadowRun, requeueShadowItems, setShadowRunState,
  hashOperationalManifest, validateOperationalManifest, type ManifestEnvelope } from '../src/shadow-embedding-control.js';
import { LocalEmbeddingClient, type VerifiedLocalRuntime } from '../src/local-embedding-client.js';
import { OpenRouterEmbeddingClient } from '../src/openrouter-embedding-client.js';
import { QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import { ShadowEmbeddingStore } from '../src/shadow-embedding-store.js';
import { runShadowBatch } from '../src/shadow-embedding-worker.js';
import { createShadowResourceGuard, validateShadowHostPlan, type ShadowHostPlan } from '../src/shadow-embedding-resource-guard.js';
import { enableSteadyWorker, pauseSteadyWorker } from '../src/shadow-embedding-steady.js';

type Command = 'prepare' | 'inventory-page' | 'start' | 'pause' | 'resume' | 'requeue' | 'status' | 'audit-page' | 'worker'
  | 'steady-enable' | 'steady-pause' | 'steady-worker';
export interface ShadowCliArguments {
  command: Command; database: string; apply: boolean; runId?: string; manifestPath?: string; manifestSha256?: string;
  limit: number; cursor: string | null; parentType?: 'memory' | 'subscription'; parentIds: string[];
}

export function parseShadowEmbeddingArguments(argv: string[]): ShadowCliArguments {
  const command = argv.shift() as Command | undefined;
  if (!command || !['prepare', 'inventory-page', 'start', 'pause', 'resume', 'requeue', 'status', 'audit-page', 'worker',
    'steady-enable', 'steady-pause', 'steady-worker'].includes(command)) {
    throw new Error('embedding.command_required');
  }
  let database: string | undefined, apply = false, runId: string | undefined, manifestPath: string | undefined;
  let manifestSha256: string | undefined, limit = command === 'audit-page' ? 100 : 500, cursor: string | null = null;
  let parentType: 'memory' | 'subscription' | undefined;
  const parentIds: string[] = [], seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--parent-id') {
      const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error('embedding.argument_value_required');
      parentIds.push(value); continue;
    }
    if (seen.has(flag)) throw new Error('embedding.duplicate_argument');
    seen.add(flag);
    if (flag === '--apply') apply = true;
    else if (['--database', '--run-id', '--manifest', '--manifest-sha256', '--limit', '--cursor', '--parent-type'].includes(flag)) {
      const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error('embedding.argument_value_required');
      if (flag === '--database') database = value;
      else if (flag === '--run-id') runId = value;
      else if (flag === '--manifest') manifestPath = value;
      else if (flag === '--manifest-sha256') manifestSha256 = value;
      else if (flag === '--cursor') cursor = value;
      else if (flag === '--parent-type') {
        if (value !== 'memory' && value !== 'subscription') throw new Error('embedding.parent_type'); parentType = value;
      } else { if (!/^\d+$/u.test(value)) throw new Error('embedding.limit'); limit = Number(value); }
    } else throw new Error('embedding.unknown_argument');
  }
  if (!database?.trim()) throw new Error('embedding.expected_database_required');
  const mutating = !['status', 'audit-page'].includes(command);
  if (mutating && !apply) throw new Error('embedding.apply_required');
  if (mutating && (!manifestPath || !manifestSha256)) throw new Error('embedding.approved_manifest_required');
  if (!['prepare', 'status', 'audit-page'].includes(command) && !runId) throw new Error('embedding.run_id_required');
  if (command === 'requeue' && (!parentType || parentIds.length === 0)) throw new Error('embedding.requeue_ids');
  if (command !== 'requeue' && (parentType || parentIds.length)) throw new Error('embedding.requeue_arguments');
  if (command !== 'audit-page' && cursor !== null) throw new Error('embedding.audit_flag_required');
  if (['worker','steady-worker'].includes(command) && seen.has('--limit')) throw new Error('embedding.worker_manifest_limits_only');
  return { command, database, apply, runId, manifestPath, manifestSha256, limit, cursor, parentType, parentIds };
}

async function loadEnvelope(args: ShadowCliArguments): Promise<ManifestEnvelope> {
  const raw = await readFile(args.manifestPath!, 'utf8');
  return validateOperationalManifest(JSON.parse(raw), args.manifestSha256!);
}

function runtimeEnvironment(): { baseUrl: string; bearerToken: string; runtime: VerifiedLocalRuntime } {
  const baseUrl = process.env.SHADOW_EMBEDDING_URL;
  const bearerToken = process.env.SHADOW_EMBEDDING_API_KEY;
  const raw = process.env.SHADOW_EMBEDDING_RUNTIME_JSON;
  if (!baseUrl?.trim() || !bearerToken?.trim() || !raw) throw new Error('embedding.worker_runtime_environment');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('embedding.worker_runtime_environment'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('embedding.worker_runtime_environment');
  const record = parsed as Record<string, unknown>;
  const fields = ['contractId','artifactSha256','runtimeContract','acceptanceReceiptSha256'];
  if (Object.keys(record).some(key => ![...fields,'tls'].includes(key))
    || fields.some(key => typeof record[key] !== 'string')) throw new Error('embedding.worker_runtime_environment');
  if(record.tls!==undefined){if(!record.tls||typeof record.tls!=='object'||Array.isArray(record.tls))throw new Error('embedding.worker_runtime_environment');
    const tls=record.tls as Record<string,unknown>,tlsFields=['caPath','caSha256','spkiSha256'];
    if(Object.keys(tls).length!==tlsFields.length||tlsFields.some(key=>typeof tls[key]!=='string'))throw new Error('embedding.worker_runtime_environment');}
  const runtime = record as unknown as VerifiedLocalRuntime;
  return { baseUrl, bearerToken, runtime };
}

function openRouterApiKey(): string {
  const value = process.env.OPENROUTER_API_KEY;
  if (!value?.trim() || /[\r\n]/u.test(value)) throw new Error('embedding.openrouter_credential_required');
  return value;
}

export async function runWorkerCommand(pool: pg.Pool, args: ShadowCliArguments, envelope: ManifestEnvelope) {
  return runBoundedWorkerCommand(pool,args,envelope,'backfill');
}

export async function runSteadyWorkerCommand(pool: pg.Pool, args: ShadowCliArguments, envelope: ManifestEnvelope) {
  return runBoundedWorkerCommand(pool,args,envelope,'steady');
}

async function runBoundedWorkerCommand(pool: pg.Pool, args: ShadowCliArguments, envelope: ManifestEnvelope,
  mode: 'backfill'|'steady') {
  const identity = await pool.query(`SELECT r.status,r.release_sha,r.manifest,current_database() AS database,
    role.rolsuper OR role.rolbypassrls AS operator,s.contract_id AS serving_contract_id,
    s.cutover_attestation_run_id,s.steady_worker_enabled
    FROM embedding_runs r JOIN pg_roles role ON role.rolname=current_user
    LEFT JOIN embedding_serving_settings s ON s.singleton
    WHERE r.id=$1 AND r.contract_id=$2`, [args.runId, QWEN_CONTRACT_ID]);
  const run = identity.rows[0];
  if (!run || run.database !== args.database || run.operator !== true) throw new Error('embedding.database_identity');
  const allowedState=mode==='backfill'?run.status==='running':['paused','complete'].includes(run.status);
  if (!allowedState || run.release_sha !== envelope.manifest.source.releaseSha
    || hashOperationalManifest(run.manifest) !== envelope.manifestSha256) throw new Error('embedding.run_manifest_identity');
  if(mode==='steady'&&(run.serving_contract_id!==QWEN_CONTRACT_ID||run.cutover_attestation_run_id!==args.runId
    ||run.steady_worker_enabled!==true))throw new Error('embedding.steady_fence');
  const plan=mode==='steady'?envelope.manifest.steadyState:undefined;
  if(mode==='steady'&&(!plan||plan.runtime.expectedRuntimeMode!=='cpu'))throw new Error('embedding.steady_plan_required');
  const environment = runtimeEnvironment();
  const approvedRuntime=plan?.runtime??envelope.manifest.runtime;
  if (environment.runtime.acceptanceReceiptSha256 !== approvedRuntime.acceptanceReceiptSha256) {
    throw new Error('embedding.runtime_acceptance_receipt');
  }
  const approvedTls=approvedRuntime.tls,actualTls=environment.runtime.tls;
  if(Boolean(approvedTls)!==Boolean(actualTls)||approvedTls&&(approvedTls.caSha256!==actualTls!.caSha256||approvedTls.spkiSha256!==actualTls!.spkiSha256)) {
    throw new Error('embedding.runtime_tls_identity');
  }
  const resources = plan?.resources??envelope.manifest.resources;
  const hostPlan = validateShadowHostPlan(resources.host,
    resources.maxElapsedMsPerBatch, resources.maxParentsPerBatch);
  const guard = createShadowResourceGuard({ plan: hostPlan, ...environment,
    expectedRuntimeHost: approvedRuntime.expectedRuntimeHost,
    expectedRuntimeMode: approvedRuntime.expectedRuntimeMode });
  const local = new LocalEmbeddingClient({ ...environment, beforeInference: guard });
  const embedding = mode === 'backfill' && envelope.manifest.backfill?.provider === 'openrouter'
    ? new OpenRouterEmbeddingClient({
      apiKey: openRouterApiKey(),
      countFormattedTokens: local.countFormattedTokens.bind(local),
      beforeInference: guard,
    })
    : local;
  if (mode === 'backfill' && envelope.manifest.version === 2 && embedding === local) {
    throw new Error('embedding.backfill_provider_required');
  }
  const store = new ShadowEmbeddingStore(pool, args.runId!,120,mode);
  await store.verifyDatabase(args.database);
  return runShadowBatch(store, embedding, {
    maxParents: resources.maxParentsPerBatch, maxSourceBytes: resources.maxSourceBytesPerBatch,
    maxTokens: resources.maxTokensPerBatch, maxElapsedMs: resources.maxElapsedMsPerBatch, maxAttempts: resources.maxAttempts,
  }, guard);
}

async function main() {
  const args = parseShadowEmbeddingArguments(process.argv.slice(2));
  const connectionString = process.env.SHADOW_EMBEDDING_DATABASE_URL;
  if (!connectionString?.trim()) throw new Error('embedding.operator_url_required');
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 30_000,
    query_timeout: 35_000, application_name: 'total-recall-shadow-control' });
  try {
    if (args.command === 'worker' || args.command === 'steady-worker') {
      const envelope=await loadEnvelope(args);
      const receipt=args.command==='worker'?await runWorkerCommand(pool,args,envelope)
        :await runSteadyWorkerCommand(pool,args,envelope);
      console.log(JSON.stringify(receipt, null, 2));
      if(args.command==='steady-worker'&&receipt.state==='paused')process.exitCode=2;
      return;
    }
    const client = await pool.connect();
    try {
      let receipt: unknown;
      if (args.command === 'status') receipt = await readShadowEmbeddingStatus(client, args.database);
      else if (args.command === 'audit-page') receipt = await auditShadowPage(client, args.database, args.cursor, args.limit);
      else {
        const envelope = await loadEnvelope(args);
        if (args.command === 'prepare') receipt = await prepareShadowRun(client, args.database, envelope);
        else if (args.command === 'inventory-page') receipt = await inventoryShadowPage(client, args.database, args.runId!, envelope, args.limit);
        else if (args.command === 'requeue') receipt = await requeueShadowItems(client, args.database, args.runId!, envelope, args.parentType!, args.parentIds);
        else if (args.command === 'steady-enable') receipt = await enableSteadyWorker(client,args.database,args.runId!,envelope);
        else if (args.command === 'steady-pause') receipt = await pauseSteadyWorker(client,args.database,args.runId!,envelope);
        else receipt = await setShadowRunState(client, args.database, args.runId!, envelope, args.command);
      }
      console.log(JSON.stringify(receipt, null, 2));
    } finally { client.release(); }
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error && /^embedding\./u.test(error.message) ? error.message : 'shadow_embedding_control_failed'); process.exitCode = 1; });
}
