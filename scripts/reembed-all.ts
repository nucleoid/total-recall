import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import {
  createMaintenanceEmbedder,
  validateMaintenanceEmbeddingProfile,
  type MaintenanceEmbeddingProfile,
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
  updated_at: string;
  revision: number;
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
  provider?: string;
  model?: string;
  namespaces?: string[];
  fullRepair?: boolean;
  maxErrors?: number;
  onProgress?: (progress: ReembedProgress) => void;
}

export interface RunReembedOptions extends ReembedOptions {
  onIdentity?: (identity: MaintenanceIdentity, source: MaintenanceDatabaseSource) => void;
}

export interface ReembedError {
  id: string;
  namespace: string;
  category: 'provider_error' | 'response_count_mismatch' | 'dimension_mismatch' | 'database_error' | 'concurrent_change';
}

export interface VerifyCounts {
  unknown_count: string;
  legacy_count: string;
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
  verification: VerifyCounts;
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

function eligiblePredicate(fullRepairParam: number, providerParam: number, modelParam: number, dimensionsParam: number): string {
  return `(
    $${fullRepairParam}::boolean
    OR embedding IS NULL
    OR embedding_provider IS NULL
    OR embedding_model IS NULL
    OR embedding_dimensions IS NULL
    OR embedding_provider <> $${providerParam}
    OR embedding_model <> $${modelParam}
    OR embedding_dimensions <> $${dimensionsParam}
  )`;
}

function vectorText(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

async function selectBatch(
  client: QueryClient,
  namespaces: string[],
  profile: Pick<MaintenanceEmbeddingProfile, 'provider' | 'model' | 'dimensions'>,
  fullRepair: boolean,
  lastId: string | null,
  batchSize: number,
): Promise<MemoryRow[]> {
  await client.query('BEGIN');
  try {
    const result = await client.query<MemoryRow>(`
      SELECT id, content, namespace, updated_at::text AS updated_at, revision
      FROM public.memories
      WHERE deleted_at IS NULL
        AND (cardinality($1::text[]) = 0 OR namespace = ANY($1))
        AND ${eligiblePredicate(6, 2, 3, 4)}
        AND ($5::uuid IS NULL OR id > $5::uuid)
      ORDER BY id
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `, [namespaces, profile.provider, profile.model, profile.dimensions, lastId, fullRepair]);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function updateEmbedding(
  client: QueryClient,
  row: MemoryRow,
  embedding: number[],
  namespaces: string[],
  profile: Pick<MaintenanceEmbeddingProfile, 'provider' | 'model' | 'dimensions'>,
  fullRepair: boolean,
): Promise<'updated' | 'concurrent_change'> {
  const result = await client.query(`
    UPDATE public.memories
    SET embedding = $1::vector,
        embedding_provider = $2,
        embedding_model = $3,
        embedding_dimensions = $4,
        updated_at = NOW()
    WHERE id = $5::uuid
      AND deleted_at IS NULL
      AND updated_at = $6::timestamptz
      AND content = $7
      AND revision = $8
      AND (cardinality($9::text[]) = 0 OR namespace = ANY($9))
      AND ${eligiblePredicate(10, 2, 3, 4)}
  `, [vectorText(embedding), profile.provider, profile.model, profile.dimensions, row.id, row.updated_at, row.content, row.revision, namespaces, fullRepair]);
  return result.rowCount === 1 ? 'updated' : 'concurrent_change';
}

export async function verifyEmbeddingMigrationComplete(
  client: QueryClient,
  namespaces: string[],
  profile: Pick<MaintenanceEmbeddingProfile, 'provider' | 'model' | 'dimensions'>,
): Promise<VerifyCounts> {
  const result = await client.query<VerifyCounts>(`
    SELECT
      COUNT(*) FILTER (
        WHERE embedding IS NULL
           OR embedding_provider IS NULL
           OR embedding_model IS NULL
           OR embedding_dimensions IS NULL
      )::text AS unknown_count,
      COUNT(*) FILTER (
        WHERE embedding_provider IS NOT NULL
          AND (
            embedding_provider <> $2
            OR embedding_model <> $3
            OR embedding_dimensions <> $4
          )
      )::text AS legacy_count
    FROM public.memories
    WHERE deleted_at IS NULL
      AND (cardinality($1::text[]) = 0 OR namespace = ANY($1))
  `, [namespaces, profile.provider, profile.model, profile.dimensions]);
  return result.rows[0] ?? { unknown_count: '0', legacy_count: '0' };
}

export async function reembedWithClient(
  client: QueryClient,
  embedder: Embedder,
  options: ReembedOptions = {},
): Promise<ReembedSummary> {
  const batchSize = options.batchSize ?? 10;
  const delayMs = options.delayMs ?? 50;
  const profile = {
    provider: options.provider ?? 'gemini',
    model: options.model ?? 'gemini-embedding-2-preview',
    dimensions: options.dimensions ?? 768,
  } as Pick<MaintenanceEmbeddingProfile, 'provider' | 'model' | 'dimensions'>;
  const namespaces = [...new Set(options.namespaces ?? [])].sort();
  const fullRepair = options.fullRepair ?? false;
  const maxErrors = options.maxErrors ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be a positive integer');
  if (!Number.isInteger(profile.dimensions) || profile.dimensions < 1) throw new Error('dimensions must be a positive integer');
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('delayMs must be nonnegative');
  if (!(maxErrors === Number.POSITIVE_INFINITY || (Number.isInteger(maxErrors) && maxErrors >= 0))) {
    throw new Error('maxErrors must be a nonnegative integer');
  }

  const initialInventory = await inventoryNamespaces(client);
  const selectedByNamespace: Record<string, number> = {};
  const succeededByNamespace: Record<string, number> = {};
  const failedByNamespace: Record<string, number> = {};
  const errors: ReembedError[] = [];
  let selected = 0;
  let lastId: string | null = null;

  const recordFailure = (row: MemoryRow, category: ReembedError['category']) => {
    increment(failedByNamespace, row.namespace);
    errors.push({ id: row.id, namespace: row.namespace, category });
  };
  const writeOne = async (row: MemoryRow, embedding: number[]) => {
    try {
      await client.query('BEGIN');
      const result = await updateEmbedding(client, row, embedding, namespaces, profile, fullRepair);
      await client.query('COMMIT');
      if (result === 'updated') increment(succeededByNamespace, row.namespace);
      else recordFailure(row, 'concurrent_change');
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      recordFailure(row, 'database_error');
    }
  };

  for (;;) {
    const batch = await selectBatch(client, namespaces, profile, fullRepair, lastId, batchSize);
    if (batch.length === 0) break;
    lastId = batch.at(-1)!.id;
    selected += batch.length;
    for (const row of batch) increment(selectedByNamespace, row.namespace);

    let embeddings: number[][] | undefined;
    let batchFailure: ReembedError['category'] | undefined;
    try {
      embeddings = await embedder(batch.map(row => row.content));
      batchFailure = embeddingCategory(embeddings, batch.length, profile.dimensions);
    } catch {
      batchFailure = 'provider_error';
    }

    if (!batchFailure && embeddings) {
      for (let index = 0; index < batch.length; index++) await writeOne(batch[index], embeddings[index]);
    } else {
      for (const row of batch) {
        try {
          const individual = await embedder([row.content]);
          const category = embeddingCategory(individual, 1, profile.dimensions);
          if (category) recordFailure(row, category);
          else await writeOne(row, individual[0]);
        } catch {
          recordFailure(row, 'provider_error');
        }
      }
    }

    const hardErrors = errors.filter(error => error.category !== 'concurrent_change').length;
    if (hardErrors > maxErrors) throw new Error(`Reembed hard error limit exceeded (${hardErrors} > ${maxErrors})`);
    options.onProgress?.({
      processed: selected,
      selected,
      succeeded: Object.values(succeededByNamespace).reduce((total, count) => total + count, 0),
      failed: Object.values(failedByNamespace).reduce((total, count) => total + count, 0),
    });
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  const verification = await verifyEmbeddingMigrationComplete(client, namespaces, profile);
  const finalInventory = await inventoryNamespaces(client);
  const succeeded = Object.values(succeededByNamespace).reduce((total, count) => total + count, 0);
  const failed = Object.values(failedByNamespace).reduce((total, count) => total + count, 0);
  return {
    selected,
    succeeded,
    failed,
    selectedByNamespace: sortedCounts(selectedByNamespace),
    succeededByNamespace: sortedCounts(succeededByNamespace),
    failedByNamespace: sortedCounts(failedByNamespace),
    initialInventory,
    finalInventory,
    concurrentInventoryDelta: inventoryTotal(finalInventory) - inventoryTotal(initialInventory),
    verification,
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
  }, createClient, { allowReembedOverride: true });
}

function integerEnvironment(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

function booleanEnvironment(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

async function main(): Promise<void> {
  const profile = validateMaintenanceEmbeddingProfile(process.env);
  const embedder = createMaintenanceEmbedder(profile);
  const namespaces = (process.env.REEMBED_NAMESPACES ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const { summary } = await runReembedAgainstEnvironment(process.env, embedder, {
    provider: profile.provider,
    model: profile.model,
    dimensions: profile.dimensions,
    namespaces,
    fullRepair: booleanEnvironment('REEMBED_FULL_REPAIR'),
    batchSize: integerEnvironment('REEMBED_BATCH_SIZE', 10, 1),
    delayMs: integerEnvironment('REEMBED_DELAY_MS', 50, 0),
    maxErrors: integerEnvironment('REEMBED_MAX_ERRORS', 0, 0),
    onIdentity: (identity, source) => {
      console.log('[reembed] Maintenance database', { ...identity, source });
      console.log('[reembed] All-row capability preflight passed; provider work starts now.');
    },
    onProgress: progress => console.log('[reembed] Progress checkpoint', progress),
  });
  console.log('[reembed] Result', {
    selected: summary.selected,
    succeeded: summary.succeeded,
    failed: summary.failed,
    selectedByNamespace: summary.selectedByNamespace,
    succeededByNamespace: summary.succeededByNamespace,
    failedByNamespace: summary.failedByNamespace,
    concurrentInventoryDelta: summary.concurrentInventoryDelta,
    verification: summary.verification,
  });
  if (summary.errors.length > 0) console.log('[reembed] Sanitized errors', summary.errors);
  if (summary.failed > 0 || Number(summary.verification.unknown_count) !== 0 || Number(summary.verification.legacy_count) !== 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[reembed] Failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
