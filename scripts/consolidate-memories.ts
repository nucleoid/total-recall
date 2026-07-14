import { randomBytes } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import {
  HARD_CONSOLIDATION_ANCHOR_LIMIT,
  HARD_CONSOLIDATION_CLUSTER_LIMIT,
  parseConsolidationPolicy,
  runConsolidation,
  type ConsolidationCursor,
  type ConsolidationMode,
  type ConsolidationPolicy,
} from '../src/consolidation.js';
import { shutdown } from '../src/db.js';
import { validateKeyReadOnly } from '../src/auth.js';

dotenv.config();

interface CliOptions {
  namespace: string;
  mode: ConsolidationMode;
  anchorLimit?: number;
  clusterLimit?: number;
  cursor?: ConsolidationCursor;
  previewOutput?: string;
}

export function parseConsolidationCli(args: string[]): CliOptions {
  let namespace = '';
  let mode: ConsolidationMode | undefined;
  let anchorLimit: number | undefined;
  let clusterLimit: number | undefined;
  let cursorCreatedAt: string | undefined;
  let cursorId: string | undefined;
  let previewOutput: string | undefined;
  const value = (index: number, option: string): string => {
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${option} requires a value`);
    return next;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--namespace') namespace = value(index++, arg);
    else if (arg === '--access-level') {
      if (value(index++, arg) !== 'normal') throw new Error('Initial consolidation supports only --access-level normal');
    } else if (arg === '--selection-only') mode = setMode(mode, 'selection-only');
    else if (arg === '--dry-run') mode = setMode(mode, 'dry-run');
    else if (arg === '--apply') mode = setMode(mode, 'apply');
    else if (arg === '--max-anchors') anchorLimit = integer(value(index++, arg), arg, HARD_CONSOLIDATION_ANCHOR_LIMIT);
    else if (arg === '--max-clusters') clusterLimit = integer(value(index++, arg), arg, HARD_CONSOLIDATION_CLUSTER_LIMIT);
    else if (arg === '--cursor-created-at') cursorCreatedAt = value(index++, arg);
    else if (arg === '--cursor-id') cursorId = value(index++, arg).toLowerCase();
    else if (arg === '--preview-output') previewOutput = value(index++, arg);
    else throw new Error(`Unknown consolidation option: ${arg}`);
  }
  if (!namespace.trim() || namespace.includes(',')) throw new Error('--namespace must name exactly one namespace');
  if (!mode) throw new Error('Choose exactly one of --selection-only, --dry-run, or --apply');
  if ((cursorCreatedAt === undefined) !== (cursorId === undefined)) throw new Error('Both cursor fields must be supplied together');
  if (cursorCreatedAt && !Number.isFinite(new Date(cursorCreatedAt).getTime())) throw new Error('Invalid --cursor-created-at');
  if (cursorId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cursorId)) {
    throw new Error('Invalid --cursor-id');
  }
  if (mode === 'dry-run' && !previewOutput) throw new Error('--dry-run requires --preview-output <owner-only-file>');
  if (mode !== 'dry-run' && previewOutput) throw new Error('--preview-output is valid only with --dry-run');
  return { namespace, mode, anchorLimit, clusterLimit, previewOutput,
    cursor: cursorCreatedAt && cursorId ? { createdAt: cursorCreatedAt, id: cursorId } : undefined };
}

function setMode(current: ConsolidationMode | undefined, next: ConsolidationMode): ConsolidationMode {
  if (current) throw new Error('Consolidation modes are mutually exclusive');
  return next;
}
function integer(raw: string, option: string, maximum: number): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${option} must be an integer from 1 to ${maximum}`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${option} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

async function loadPolicy(options: CliOptions): Promise<ConsolidationPolicy | undefined> {
  if (options.mode === 'selection-only') return undefined;
  const path = process.env.CONSOLIDATION_POLICY_FILE?.trim();
  const environment = process.env.DEPLOYMENT_ENVIRONMENT?.trim();
  if (!path || !environment) throw new Error('Generation requires CONSOLIDATION_POLICY_FILE and DEPLOYMENT_ENVIRONMENT');
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw new Error(`Unable to load consolidation policy: ${error instanceof Error ? error.message : String(error)}`); }
  const policy = parseConsolidationPolicy(value, environment);
  if (policy.scope.namespaces[0] !== options.namespace) throw new Error('Policy does not approve the exact requested namespace');
  if (options.mode === 'apply' && !policy.writeApproval) throw new Error('Apply is disabled without a separate write approval');
  return policy;
}

/** Atomically publish a new owner-only file without replacing an existing approval artifact. */
export async function writeOwnerOnlyJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try { await link(temporary, path); }
  finally { await unlink(temporary).catch(() => undefined); }
}

async function main(): Promise<void> {
  const options = parseConsolidationCli(process.argv.slice(2));
  const rawKey = process.env.CONSOLIDATION_API_KEY?.trim();
  if (!rawKey) throw new Error('CONSOLIDATION_API_KEY is required');
  const auth = await validateKeyReadOnly(rawKey);
  if (!auth) throw new Error('Invalid or disabled consolidation API key');
  const policy = await loadPolicy(options);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const result = await runConsolidation({
      auth, namespace: options.namespace, mode: options.mode,
      environment: process.env.DEPLOYMENT_ENVIRONMENT?.trim() ?? '', policy,
      anchorLimit: options.anchorLimit, clusterLimit: options.clusterLimit,
      cursor: options.cursor, signal: controller.signal,
    });
    if (options.mode === 'dry-run') {
      await writeOwnerOnlyJson(options.previewOutput!, {
        version: 1, feature: 'memory-consolidation', namespace: options.namespace,
        policyHash: result.policyHash, createdAt: new Date().toISOString(), previews: result.previews,
      });
      console.log('[consolidation] Sensitive preview written', { file: options.previewOutput, clusters: result.previews.length });
    } else if (options.mode === 'selection-only') {
      console.log(JSON.stringify({ namespace: options.namespace, anchorsExamined: result.selection.anchorsExamined,
        readiness: result.selection.readiness, clusters: result.selection.clusters.map(cluster => ({
          members: cluster.members.map(member => ({ id: member.id, revision: member.revision,
            similarityToAnchor: member.similarityToAnchor })), oversized: cluster.oversized,
        })) }));
    } else {
      console.log('[consolidation] Apply complete', { selected: result.selection.clusters.length,
        merged: result.mergedCanonicalIds.length, canonicalIds: result.mergedCanonicalIds });
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('[consolidation] Failed:', error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
