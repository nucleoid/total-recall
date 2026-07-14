import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { validateKeyReadOnly } from '../src/auth.js';
import { applyDeconsolidation, previewDeconsolidation, type DeconsolidationManifest } from '../src/consolidation.js';
import { dbScopeFromAuth, shutdown, withScopedClient } from '../src/db.js';
import { writeOwnerOnlyJson } from './consolidate-memories.js';

dotenv.config();

interface Options {
  mode: 'preview' | 'apply';
  namespace: string;
  manifest: string;
  canonicalIds: string[];
  approvePolicyHash?: string;
}

/** Preview is the safe default; apply needs the separately copied exact hash. */
export function parseDeconsolidationCli(args: string[]): Options {
  let apply = false; let namespace = ''; let manifest = ''; let canonicalIds: string[] = [];
  let approvePolicyHash: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const next = () => {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${args[index - 1]} requires a value`);
      return value;
    };
    if (args[index] === '--apply') apply = true;
    else if (args[index] === '--namespace') namespace = next();
    else if (args[index] === '--manifest') manifest = next();
    else if (args[index] === '--canonical-id') canonicalIds.push(next().toLowerCase());
    else if (args[index] === '--approve-policy-hash') approvePolicyHash = next().toLowerCase();
    else throw new Error(`Unknown deconsolidation option: ${args[index]}`);
  }
  if (!manifest || !namespace || namespace.includes(',')) {
    throw new Error('Usage: --namespace <exact> --manifest <file> [--canonical-id <uuid> ...] | --apply --approve-policy-hash <sha256>');
  }
  if (!apply && canonicalIds.length === 0) throw new Error('Preview requires at least one --canonical-id');
  if (apply && canonicalIds.length > 0) throw new Error('Apply canonical IDs come only from the manifest');
  if (apply && !/^[0-9a-f]{64}$/.test(approvePolicyHash ?? '')) {
    throw new Error('Apply requires --approve-policy-hash with the exact manifest hash');
  }
  if (!apply && approvePolicyHash) throw new Error('--approve-policy-hash is valid only with --apply');
  return { mode: apply ? 'apply' : 'preview', namespace, manifest, canonicalIds, approvePolicyHash };
}

async function main(): Promise<void> {
  const options = parseDeconsolidationCli(process.argv.slice(2));
  const rawKey = process.env.CONSOLIDATION_API_KEY?.trim();
  if (!rawKey) throw new Error('CONSOLIDATION_API_KEY is required');
  const auth = await validateKeyReadOnly(rawKey);
  if (!auth) throw new Error('Invalid or disabled consolidation API key');
  try {
    if (options.mode === 'preview') {
      const manifest = await withScopedClient(dbScopeFromAuth(auth), client =>
        previewDeconsolidation(client, auth, options.namespace, options.canonicalIds));
      await writeOwnerOnlyJson(options.manifest, manifest);
      console.log('[deconsolidation] Approval manifest written', { file: options.manifest,
        policyHash: manifest.policyHash, canonicals: manifest.canonicals.length,
        members: manifest.canonicals.reduce((count, item) => count + item.members.length, 0) });
    } else {
      const manifest = JSON.parse(await readFile(options.manifest, 'utf8')) as DeconsolidationManifest;
      if (manifest.namespace !== options.namespace) throw new Error('Manifest namespace does not match --namespace');
      if (manifest.policyHash !== options.approvePolicyHash) throw new Error('Manifest does not match --approve-policy-hash');
      const result = await withScopedClient(dbScopeFromAuth(auth), client => applyDeconsolidation(client, auth, manifest));
      console.log('[deconsolidation] Apply complete', result);
    }
  } finally { await shutdown(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('[deconsolidation] Failed:', error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
