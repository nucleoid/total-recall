import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { withMaintenanceClient, type QueryClient } from './lib/maintenance-db.js';
import { resolveConfiguredTarget, type EmbeddingTarget } from './lib/embedding-target.js';

dotenv.config();

export interface LabelOptions {
  label: EmbeddingTarget | 'unknown';
  namespaces: string[];
  whereProvider?: string;
  whereModel?: string;
  dryRun: boolean;
  confirmed: boolean;
  evidence?: string;
}

export async function labelEmbeddings(client: QueryClient, options: LabelOptions): Promise<number> {
  if (options.label !== 'unknown' && !options.evidence?.trim()) {
    throw new Error('--evidence is required and must identify the inventory or deployment proof for this legacy vector space');
  }
  if (options.namespaces.length === 0 && !options.whereProvider && !options.whereModel) {
    throw new Error('Labelling requires --namespace or an explicit --where-provider/--where-model filter');
  }
  if (!options.dryRun && !options.confirmed) throw new Error('Mutation requires --confirm "LABEL EMBEDDINGS"; run --dry-run first');
  const values: unknown[] = [options.namespaces];
  const conditions = [
    'deleted_at IS NULL',
    'embedding IS NOT NULL',
    "to_jsonb(memories)->>'superseded_at' IS NULL",
    "to_jsonb(memories)->>'consolidated_into_id' IS NULL",
    '(cardinality($1::text[]) = 0 OR namespace = ANY($1))',
  ];
  if (options.whereProvider) { values.push(options.whereProvider); conditions.push(`embedding_provider = $${values.length}`); }
  if (options.whereModel) { values.push(options.whereModel); conditions.push(`embedding_model = $${values.length}`); }

  if (options.dryRun) {
    const result = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.memories WHERE ${conditions.join(' AND ')}`, values);
    return Number(result.rows[0]?.count ?? 0);
  }

  let assignments: string;
  if (options.label === 'unknown') {
    assignments = 'embedding_provider = NULL, embedding_model = NULL, embedding_dimensions = NULL';
  } else {
    values.push(options.label.provider, options.label.model, options.label.dimensions);
    assignments = `embedding_provider = $${values.length - 2}, embedding_model = $${values.length - 1}, embedding_dimensions = $${values.length}`;
  }
  const result = await client.query(`UPDATE public.memories SET ${assignments}, updated_at = NOW() WHERE ${conditions.join(' AND ')}`, values);
  return result.rowCount ?? 0;
}

function parseArguments(argv: string[]): Omit<LabelOptions, 'label'> & { profile?: string; unknown: boolean } {
  const result = { namespaces: [] as string[], dryRun: false, confirmed: false, unknown: false } as Omit<LabelOptions, 'label'> & { profile?: string; unknown: boolean };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--profile') result.profile = argv[++i];
    else if (arg === '--unknown') result.unknown = true;
    else if (arg === '--namespace') result.namespaces.push(...(argv[++i] ?? '').split(',').filter(Boolean));
    else if (arg === '--where-provider') result.whereProvider = argv[++i];
    else if (arg === '--where-model') result.whereModel = argv[++i];
    else if (arg === '--evidence') result.evidence = argv[++i];
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--confirm') result.confirmed = argv[++i] === 'LABEL EMBEDDINGS';
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (result.unknown === Boolean(result.profile)) throw new Error('Choose exactly one of --profile <legacy-name> or --unknown');
  result.namespaces = [...new Set(result.namespaces)].sort();
  return result;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const current = resolveConfiguredTarget(process.env);
  const label = args.unknown ? 'unknown' : resolveConfiguredTarget(process.env, args.profile);
  if (label !== 'unknown' && label.provider === current.provider && label.model === current.model && label.dimensions === current.dimensions) {
    throw new Error('Metadata-only labelling as the current target is forbidden; freshly re-embed uncertain rows instead');
  }
  await withMaintenanceClient(process.env, async (client, identity, source) => {
    const count = await labelEmbeddings(client, { ...args, label });
    console.log(JSON.stringify({ database: { ...identity, source }, dry_run: args.dryRun, matched: count, label: label === 'unknown' ? null : label }, null, 2));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('[embedding-label] Failed:', error instanceof Error ? error.message : 'unknown error'); process.exitCode = 1; });
}
