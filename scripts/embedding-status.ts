import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { withMaintenanceClient, type QueryClient } from './lib/maintenance-db.js';
import { resolveConfiguredTarget, type EmbeddingTarget } from './lib/embedding-target.js';

dotenv.config();

export interface EmbeddingStatusRow {
  namespace: string;
  embedding_provider: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  count: string;
}

export interface EmbeddingStatusReport {
  target: EmbeddingTarget;
  groups: EmbeddingStatusRow[];
  unknown_count: number;
  legacy_count: number;
  current_count: number;
  retirement_ready: boolean;
}

export async function embeddingStatus(
  client: QueryClient,
  target: EmbeddingTarget,
  namespaces: string[] = [],
): Promise<EmbeddingStatusReport> {
  const result = await client.query<EmbeddingStatusRow>(`
    SELECT namespace, embedding_provider, embedding_model, embedding_dimensions, count(*)::text AS count
    FROM public.memories
    WHERE deleted_at IS NULL
      AND (expires_at IS NULL OR expires_at > statement_timestamp())
      AND to_jsonb(memories)->>'superseded_at' IS NULL
      AND to_jsonb(memories)->>'consolidated_into_id' IS NULL
      AND (cardinality($1::text[]) = 0 OR namespace = ANY($1))
    GROUP BY namespace, embedding_provider, embedding_model, embedding_dimensions
    ORDER BY namespace, embedding_provider NULLS FIRST, embedding_model NULLS FIRST, embedding_dimensions NULLS FIRST
  `, [namespaces]);
  let unknown_count = 0;
  let legacy_count = 0;
  let current_count = 0;
  for (const row of result.rows) {
    const count = Number(row.count);
    if (!row.embedding_provider || !row.embedding_model || !row.embedding_dimensions) unknown_count += count;
    else if (row.embedding_provider === target.provider && row.embedding_model === target.model && row.embedding_dimensions === target.dimensions) current_count += count;
    else legacy_count += count;
  }
  return { target, groups: result.rows, unknown_count, legacy_count, current_count, retirement_ready: unknown_count === 0 && legacy_count === 0 };
}

function argumentsFrom(argv: string[]): { target?: string; namespaces: string[] } {
  const namespaces: string[] = [];
  let target: string | undefined;
  const required = (name: string, value: string | undefined) => {
    if (!value?.trim()) throw new Error(`${name} requires a nonblank value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') target = required(argv[i], argv[++i]);
    else if (argv[i] === '--namespace') namespaces.push(...required(argv[i], argv[++i]).split(',').map(value => value.trim()).filter(Boolean));
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  return { target, namespaces: [...new Set(namespaces)].sort() };
}

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2));
  const target = resolveConfiguredTarget(process.env, args.target);
  await withMaintenanceClient(process.env, async (client, identity, source) => {
    const report = await embeddingStatus(client, target, args.namespaces);
    console.log(JSON.stringify({ database: { ...identity, source }, ...report }, null, 2));
    if (!report.retirement_ready) process.exitCode = 2;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('[embedding-status] Failed:', error instanceof Error ? error.message : 'unknown error'); process.exitCode = 1; });
}
