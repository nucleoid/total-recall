import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import {
  createMaintenanceEmbedder,
  validateMaintenanceEmbeddingProfile,
} from './lib/maintenance-embedding.js';
import {
  inventoryNamespaces,
  withMaintenanceClient,
  type MaintenanceClientFactory,
  type MaintenanceDatabaseSource,
  type MaintenanceEnvironment,
  type MaintenanceIdentity,
  type NamespaceCount,
  type QueryClient,
} from './lib/maintenance-db.js';

dotenv.config();

interface MemoryRow {
  id: string;
  content: string;
  namespace: string;
}

export interface ReembedProgress {
  processed: number;
  selected: number;
  succeeded: number;
  failed: number;
}

export interface ReembedOptions {
  batchSize?: number;
  delayMs?: number;
  dimensions?: number;
  onProgress?: (progress: ReembedProgress) => void;
}

export interface RunReembedOptions extends ReembedOptions {
  onIdentity?: (identity: MaintenanceIdentity, source: MaintenanceDatabaseSource) => void;
}

export interface ReembedError {
  id: string;
  namespace: string;
  category: 'provider_error' | 'response_count_mismatch' | 'dimension_mismatch' | 'database_error';
}

export interface ReembedSummary {
  selected: number;
  succeeded: number;
  failed: number;
  selectedByNamespace: Record<string, number>;
  succeededByNamespace: Record<string, number>;
  failedByNamespace: Record<string, number>;
  initialInventory: NamespaceCount[];
  finalInventory: NamespaceCount[];
  concurrentInventoryDelta: number;
  errors: ReembedError[];
}

type Embedder = (texts: string[]) => Promise<number[][]>;

function increment(counts: Record<string, number>, namespace: string): void {
  counts[namespace] = (counts[namespace] ?? 0) + 1;
}

function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function inventoryTotal(inventory: NamespaceCount[]): number {
  return inventory.reduce((total, row) => total + row.count, 0);
}

function embeddingCategory(embeddings: number[][], expectedCount: number, dimensions: number): ReembedError['category'] | undefined {
  if (embeddings.length !== expectedCount) return 'response_count_mismatch';
  if (embeddings.some(vector => vector.length !== dimensions || vector.some(value => !Number.isFinite(value)))) {
    return 'dimension_mismatch';
  }
  return undefined;
}

async function updateEmbedding(client: QueryClient, row: MemoryRow, embedding: number[]): Promise<void> {
  const result = await client.query(
    'UPDATE public.memories SET embedding = $1 WHERE id = $2',
    [`[${embedding.join(',')}]`, row.id],
  );
  if (result.rowCount !== undefined && result.rowCount !== null && result.rowCount !== 1) {
    throw new Error('memory row was not updated');
  }
}

export async function reembedWithClient(
  client: QueryClient,
  embedder: Embedder,
  options: ReembedOptions = {},
): Promise<ReembedSummary> {
  const batchSize = options.batchSize ?? 10;
  const delayMs = options.delayMs ?? 50;
  const dimensions = options.dimensions ?? 768;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be a positive integer');
  if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error('dimensions must be a positive integer');
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('delayMs must be nonnegative');

  const initialInventory = await inventoryNamespaces(client);
  const selected = await client.query<MemoryRow>(
    'SELECT id, content, namespace FROM public.memories ORDER BY id',
  );
  const selectedByNamespace: Record<string, number> = {};
  for (const row of selected.rows) increment(selectedByNamespace, row.namespace);

  const succeededByNamespace: Record<string, number> = {};
  const failedByNamespace: Record<string, number> = {};
  const errors: ReembedError[] = [];

  const recordSuccess = (row: MemoryRow) => increment(succeededByNamespace, row.namespace);
  const recordFailure = (row: MemoryRow, category: ReembedError['category']) => {
    increment(failedByNamespace, row.namespace);
    errors.push({ id: row.id, namespace: row.namespace, category });
  };

  for (let offset = 0; offset < selected.rows.length; offset += batchSize) {
    const batch = selected.rows.slice(offset, offset + batchSize);
    let embeddings: number[][] | undefined;
    let batchFailure: ReembedError['category'] | undefined;
    try {
      embeddings = await embedder(batch.map(row => row.content));
      batchFailure = embeddingCategory(embeddings, batch.length, dimensions);
    } catch {
      batchFailure = 'provider_error';
    }

    if (batchFailure === undefined && embeddings) {
      for (let index = 0; index < batch.length; index++) {
        try {
          await updateEmbedding(client, batch[index], embeddings[index]);
          recordSuccess(batch[index]);
        } catch {
          recordFailure(batch[index], 'database_error');
        }
      }
    } else {
      for (const row of batch) {
        try {
          const individual = await embedder([row.content]);
          const category = embeddingCategory(individual, 1, dimensions);
          if (category) {
            recordFailure(row, category);
            continue;
          }
          try {
            await updateEmbedding(client, row, individual[0]);
            recordSuccess(row);
          } catch {
            recordFailure(row, 'database_error');
          }
        } catch {
          recordFailure(row, 'provider_error');
        }
      }
    }

    options.onProgress?.({
      processed: Math.min(offset + batch.length, selected.rows.length),
      selected: selected.rows.length,
      succeeded: Object.values(succeededByNamespace).reduce((total, count) => total + count, 0),
      failed: Object.values(failedByNamespace).reduce((total, count) => total + count, 0),
    });

    if (delayMs > 0 && offset + batchSize < selected.rows.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  const finalInventory = await inventoryNamespaces(client);
  const succeeded = Object.values(succeededByNamespace).reduce((total, count) => total + count, 0);
  const failed = Object.values(failedByNamespace).reduce((total, count) => total + count, 0);
  return {
    selected: selected.rows.length,
    succeeded,
    failed,
    selectedByNamespace: sortedCounts(selectedByNamespace),
    succeededByNamespace: sortedCounts(succeededByNamespace),
    failedByNamespace: sortedCounts(failedByNamespace),
    initialInventory,
    finalInventory,
    concurrentInventoryDelta: inventoryTotal(finalInventory) - inventoryTotal(initialInventory),
    errors,
  };
}

export async function runReembedAgainstEnvironment(
  env: MaintenanceEnvironment,
  embedder: Embedder,
  options: RunReembedOptions = {},
  createClient?: MaintenanceClientFactory,
): Promise<{ identity: MaintenanceIdentity; source: MaintenanceDatabaseSource; summary: ReembedSummary }> {
  return withMaintenanceClient(env, async (client, identity, source) => {
    options.onIdentity?.(identity, source);
    const summary = await reembedWithClient(client, embedder, options);
    return { identity, source, summary };
  }, createClient);
}

async function main(): Promise<void> {
  const profile = validateMaintenanceEmbeddingProfile(process.env);
  const embedder = createMaintenanceEmbedder(profile);
  console.log('[reembed] Validated embedding profile', {
    provider: profile.provider,
    model: profile.model,
    dimensions: profile.dimensions,
  });
  const { summary } = await runReembedAgainstEnvironment(process.env, embedder, {
    dimensions: profile.dimensions,
    onIdentity: (identity, source) => {
      console.log('[reembed] Maintenance database', { ...identity, source });
      console.log('[reembed] All-row capability preflight passed; re-embedding starts immediately and is noninteractive.');
    },
    onProgress: progress => console.log('[reembed] Progress checkpoint', progress),
  });
  console.log('[reembed] Selected totals', {
    total: summary.selected,
    byNamespace: summary.selectedByNamespace,
  });
  console.log('[reembed] Actual result totals', {
    succeeded: summary.succeeded,
    failed: summary.failed,
    succeededByNamespace: summary.succeededByNamespace,
    failedByNamespace: summary.failedByNamespace,
    concurrentInventoryDelta: summary.concurrentInventoryDelta,
  });
  if (summary.errors.length > 0) console.log('[reembed] Sanitized errors', summary.errors);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[reembed] Failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
