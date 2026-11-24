import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { isAccessLevel, validateKeyReadOnly } from '../src/auth.js';
import { dbScopeFromAuth, shutdown, withScopedClient } from '../src/db.js';
import {
  MAX_ENTITY_EXTRACTION_OUTPUT_BYTES,
  assertEntityBackfillApproved,
  parseEntityExtractionPolicy,
} from '../src/entity-extractor.js';
import { ENTITY_LEGACY_COVERAGE_CUTOFF, enqueueEntityBackfill, enqueueEntityRequeue, enqueueLegacyEntityCoverage,
  previewEntityBackfill, previewEntityRequeue, previewLegacyEntityCoverage } from '../src/entities.js';
import { assertEntityWorkerAuthority } from './entity-enrich.js';
import { isSubscriptionUsage } from '../src/synthesis-policy.js';
import type { AccessLevel } from '../src/types.js';

dotenv.config();

type Options = { namespace: string; accessLevel: AccessLevel; mode: 'preview' | 'execute'; limit: number;
  selection: 'missing' | 'completed-without-links' | 'legacy-uncovered'; memoryIds: string[];
  completedBefore: string | null; sourceBefore: string | null };

export function parseEntityBackfillCli(args: string[]): Options {
  let namespace = '';
  let accessLevel: AccessLevel = 'normal';
  let mode: Options['mode'] | undefined;
  let limit = 1_000;
  let selection: Options['selection'] = 'missing';
  const memoryIds: string[] = [];
  let completedBefore: string | null = null;
  let sourceBefore: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--namespace') namespace = requiredValue(args[++index], arg);
    else if (arg === '--completed-before') {
      const value = requiredValue(args[++index], arg);
      const parsed = new Date(value);
      if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.getTime() >= Date.now()) {
        throw new Error('--completed-before must be a valid UTC timestamp before the current time');
      }
      completedBefore = parsed.toISOString();
    } else if (arg === '--source-before') {
      const value=requiredValue(args[++index],arg),parsed=new Date(value);
      if(!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)||!Number.isFinite(parsed.getTime())||parsed.getTime()>=Date.now()){
        throw new Error('--source-before must be a valid fixed UTC timestamp before the current time');
      }
      sourceBefore=parsed.toISOString();
      if(sourceBefore!==ENTITY_LEGACY_COVERAGE_CUTOFF)throw new Error(`--source-before must equal ${ENTITY_LEGACY_COVERAGE_CUTOFF}`);
    } else if (arg === '--memory-id') {
      const value = requiredValue(args[++index], arg);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        throw new Error('--memory-id must be a UUID');
      }
      if (memoryIds.includes(value)) throw new Error('--memory-id values must be unique');
      if (memoryIds.length >= 100) throw new Error('--memory-id is limited to 100 values');
      memoryIds.push(value);
    } else if (arg === '--requeue-completed-without-links') selection = 'completed-without-links';
    else if(arg==='--requeue-legacy-uncovered')selection='legacy-uncovered';
    else if (arg === '--access-level') {
      const value = requiredValue(args[++index], arg);
      if (!isAccessLevel(value)) throw new Error('--access-level must be normal, sensitive, or secret');
      accessLevel = value;
    }
    else if (arg === '--preview' || arg === '--execute') {
      if (mode) throw new Error('Choose exactly one of --preview or --execute');
      mode = arg.slice(2) as Options['mode'];
    } else if (arg === '--limit') {
      const raw = requiredValue(args[++index], arg);
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 10_000) {
        throw new Error('--limit must be an integer from 1 to 10000');
      }
      limit = Number(raw);
    } else throw new Error(`Unknown entity backfill option: ${arg}`);
  }
  if (!namespace.trim() || namespace.includes(',')) throw new Error('--namespace must name exactly one namespace');
  if (!mode) throw new Error('Choose exactly one of --preview or --execute');
  if (selection === 'completed-without-links' && !completedBefore) {
    throw new Error('--completed-before is required for completed-without-links recovery');
  }
  if (selection === 'missing' && completedBefore) throw new Error('--completed-before is only valid with --requeue-completed-without-links');
  if(selection==='legacy-uncovered'&&!sourceBefore)throw new Error('--source-before is required for legacy-uncovered recovery');
  if(selection!=='legacy-uncovered'&&sourceBefore)throw new Error('--source-before is only valid with --requeue-legacy-uncovered');
  if(selection==='legacy-uncovered'&&completedBefore)throw new Error('--completed-before cannot be combined with legacy-uncovered recovery');
  return { namespace, accessLevel, mode, limit, selection, memoryIds, completedBefore, sourceBefore };
}

async function main(): Promise<void> {
  const options = parseEntityBackfillCli(process.argv.slice(2));
  const environment = process.env.DEPLOYMENT_ENVIRONMENT?.trim();
  const policyFile = process.env.ENTITY_EXTRACTION_POLICY_FILE?.trim();
  if (!environment || !policyFile) throw new Error('ENTITY_EXTRACTION_POLICY_FILE and DEPLOYMENT_ENVIRONMENT are required');
  const policy = parseEntityExtractionPolicy(JSON.parse(await readFile(policyFile, 'utf8')), environment);
  if (policy.scope.namespaces[0] !== options.namespace || policy.scope.accessLevel !== options.accessLevel) {
    throw new Error('Entity extraction policy does not approve the exact backfill scope');
  }
  if (options.mode === 'execute') assertEntityBackfillApproved(policy);

  const rawKey = process.env.ENTITY_ENRICH_API_KEY?.trim();
  if (!rawKey) throw new Error('ENTITY_ENRICH_API_KEY is required');
  const auth = await validateKeyReadOnly(rawKey);
  if (!auth) throw new Error('Backfill requires a valid entity worker key');
  assertEntityWorkerAuthority(auth, policy);
  const scope = dbScopeFromAuth(auth);
  if (options.mode === 'preview') {
    const preview = await withScopedClient(scope, client => options.selection === 'completed-without-links'
      ? previewEntityRequeue(client, options.namespace, options.accessLevel, options.completedBefore!, options.memoryIds)
      : options.selection==='legacy-uncovered'
        ? previewLegacyEntityCoverage(client,options.namespace,options.accessLevel,options.sourceBefore!,options.memoryIds)
        : previewEntityBackfill(client, options.namespace, options.accessLevel, options.memoryIds));
    const estimatedCostUsd = isSubscriptionUsage(policy.budget) ? null : preview.rows * policy.budget.estimatedRequestCostUsd +
      preview.inputBytes * policy.budget.estimatedInputCostUsdPerMillionBytes / 1_000_000 +
      preview.rows * MAX_ENTITY_EXTRACTION_OUTPUT_BYTES *
        policy.budget.estimatedOutputCostUsdPerMillionBytes / 1_000_000;
    console.log(JSON.stringify({ version: 1, feature: 'memory-entity-extraction-backfill',
      namespace: options.namespace, accessLevel: options.accessLevel, selection: options.selection,
      completedBefore: options.completedBefore, sourceBefore: options.sourceBefore,
      memoryIds: options.memoryIds, ...preview, estimatedProviderCalls: preview.rows,
      estimatedMaxOutputBytes: preview.rows * MAX_ENTITY_EXTRACTION_OUTPUT_BYTES, estimatedCostUsd }));
  } else {
    const result = await withScopedClient(scope, client => options.selection === 'completed-without-links'
      ? enqueueEntityRequeue(client, options.namespace, options.accessLevel, options.completedBefore!, options.limit, options.memoryIds)
      : options.selection==='legacy-uncovered'
        ? enqueueLegacyEntityCoverage(client,options.namespace,options.accessLevel,options.sourceBefore!,options.limit,options.memoryIds)
        : enqueueEntityBackfill(client, options.namespace, options.accessLevel, options.limit, options.memoryIds));
    console.log(JSON.stringify({ version: 1, namespace: options.namespace, accessLevel: options.accessLevel,
      selection: options.selection, completedBefore: options.completedBefore, sourceBefore: options.sourceBefore,
      memoryIds: options.memoryIds, ...result }));
  }
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[entity-backfill] failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }).finally(() => shutdown());
}
