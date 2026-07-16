import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { validateKeyReadOnly } from '../src/auth.js';
import { dbScopeFromAuth, shutdown, withScopedClient } from '../src/db.js';
import {
  MAX_ENTITY_EXTRACTION_OUTPUT_BYTES,
  assertEntityBackfillApproved,
  parseEntityExtractionPolicy,
} from '../src/entity-extractor.js';
import { enqueueEntityBackfill, previewEntityBackfill } from '../src/entities.js';

dotenv.config();

type Options = { namespace: string; mode: 'preview' | 'execute'; limit: number };

export function parseEntityBackfillCli(args: string[]): Options {
  let namespace = '';
  let mode: Options['mode'] | undefined;
  let limit = 1_000;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--namespace') namespace = requiredValue(args[++index], arg);
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
  return { namespace, mode, limit };
}

async function main(): Promise<void> {
  const options = parseEntityBackfillCli(process.argv.slice(2));
  const environment = process.env.DEPLOYMENT_ENVIRONMENT?.trim();
  const policyFile = process.env.ENTITY_EXTRACTION_POLICY_FILE?.trim();
  if (!environment || !policyFile) throw new Error('ENTITY_EXTRACTION_POLICY_FILE and DEPLOYMENT_ENVIRONMENT are required');
  const policy = parseEntityExtractionPolicy(JSON.parse(await readFile(policyFile, 'utf8')), environment);
  if (policy.scope.namespaces[0] !== options.namespace || policy.scope.accessLevel !== 'normal') {
    throw new Error('Entity extraction policy does not approve the exact backfill scope');
  }
  if (options.mode === 'execute') assertEntityBackfillApproved(policy);

  const rawKey = process.env.ENTITY_ENRICH_API_KEY?.trim();
  if (!rawKey) throw new Error('ENTITY_ENRICH_API_KEY is required');
  const auth = await validateKeyReadOnly(rawKey);
  if (!auth || auth.namespaces.length !== 1 || auth.namespaces[0] !== options.namespace ||
      auth.maxAccessLevel !== 'normal' || !auth.permissions.includes('read') ||
      (options.mode === 'execute' && !auth.permissions.includes('write'))) {
    throw new Error('Backfill requires a dedicated authorized normal-only key for the exact namespace');
  }
  const scope = dbScopeFromAuth(auth);
  if (options.mode === 'preview') {
    const preview = await withScopedClient(scope, client => previewEntityBackfill(client, options.namespace));
    const estimatedCostUsd = preview.rows * policy.budget.estimatedRequestCostUsd +
      preview.inputBytes * policy.budget.estimatedInputCostUsdPerMillionBytes / 1_000_000 +
      preview.rows * MAX_ENTITY_EXTRACTION_OUTPUT_BYTES *
        policy.budget.estimatedOutputCostUsdPerMillionBytes / 1_000_000;
    console.log(JSON.stringify({ version: 1, feature: 'memory-entity-extraction-backfill',
      namespace: options.namespace, accessLevel: 'normal', ...preview, estimatedProviderCalls: preview.rows,
      estimatedMaxOutputBytes: preview.rows * MAX_ENTITY_EXTRACTION_OUTPUT_BYTES, estimatedCostUsd }));
  } else {
    const result = await withScopedClient(scope, client => enqueueEntityBackfill(client, options.namespace, options.limit));
    console.log(JSON.stringify({ version: 1, namespace: options.namespace, ...result }));
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
