import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canAccessLevel, checkPermission } from '../auth.js';
import { logAudit } from '../audit.js';
import { dbScopeFromAuth, withScopedClient } from '../db.js';
import {
  ACTIVE_EMBEDDING_PROFILE,
  embedBatchWithProfile,
  serializeEmbeddingVector,
  type EmbeddingResult,
} from '../embedding.js';
import type { AuthContext } from '../types.js';
import {
  MAX_TRANSFER_BATCH_RECORDS,
  metadataWithTransferProvenance,
  metadataWithoutTransferProvenance,
  parseTransferManifest,
  parseTransferMemoryRecord,
  transferRecordFingerprint,
  type TransferManifest,
  type TransferMemoryRecord,
} from './format.js';

export const importBatchSchema = z.object({
  manifest: z.unknown(),
  records: z.array(z.unknown()).min(1).max(MAX_TRANSFER_BATCH_RECORDS),
  dry_run: z.boolean().default(false),
}).strict();

export interface ImportBatchParams {
  manifest: unknown;
  records: unknown[];
  dry_run?: boolean;
}

export interface ImportBatchResult {
  inserted: number;
  updated: number;
  skipped: number;
  conflicted: number;
  denied: number;
  failed: number;
  embedding_calls: number;
  committed: boolean;
}

export type TransferEmbedder = (texts: string[], signal?: AbortSignal) => Promise<EmbeddingResult[]>;

type ExistingRow = {
  source_key: string | null;
  content: string;
  source: string;
  namespace: string;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  access_level: TransferMemoryRecord['access_level'] | null;
  created_at: Date | string;
  event_at: Date | string | null;
  memory_kind: TransferMemoryRecord['memory_kind'] | null;
  valid_from: Date | string | null;
  valid_to: Date | string | null;
  expires_at: Date | string | null;
  origin_namespace: string | null;
  insight_content_hash: string | null;
};

export async function importMemoryBatch(
  rawParams: ImportBatchParams,
  auth: AuthContext,
  options: { signal?: AbortSignal; embedder?: TransferEmbedder } = {},
): Promise<ImportBatchResult> {
  checkPermission(auth, 'import');
  const envelope = importBatchSchema.parse(rawParams);
  const manifest = parseTransferManifest(envelope.manifest);
  const records = envelope.records.map(parseTransferMemoryRecord);
  assertUniqueSourceKeys(records);
  for (const record of records) {
    if (!auth.namespaces.includes(record.namespace) || !canAccessLevel(record.access_level, auth.maxAccessLevel)) {
      // Continue classification without opening a database transaction and do
      // not reveal whether the same key already exists at the destination.
      continue;
    }
  }

  const embedder = options.embedder ?? defaultEmbedder;
  return withScopedClient(dbScopeFromAuth(auth), async client => {
    const counts: ImportBatchResult = {
      inserted: 0, updated: 0, skipped: 0, conflicted: 0, denied: 0, failed: 0,
      embedding_calls: 0, committed: !envelope.dry_run,
    };
    const pending: TransferMemoryRecord[] = [];

    // Locks are acquired in a stable order so overlapping batches cannot
    // deadlock or both classify the same tenant-local identity as absent.
    const authorized = records.filter(record =>
      auth.namespaces.includes(record.namespace) && canAccessLevel(record.access_level, auth.maxAccessLevel)
    );
    for (const sourceKey of [...authorized.map(record => record.source_key)].sort()) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`memory-transfer:${auth.keyId}:${sourceKey}`]);
    }

    for (const record of records) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Import cancelled');
      if (!auth.namespaces.includes(record.namespace) || !canAccessLevel(record.access_level, auth.maxAccessLevel)) {
        counts.denied++;
        continue;
      }

      const visibility = await sourceKeyVisibility(client, auth, record);
      if (visibility === 'denied') {
        counts.denied++;
        continue;
      }
      if (visibility === 'none') {
        pending.push(record);
        continue;
      }

      const existing = await client.query<ExistingRow>(`
        SELECT source_key, content, source, namespace, tags, metadata, access_level,
               created_at, event_at, memory_kind, valid_from, valid_to, expires_at,
               origin_namespace, insight_content_hash
        FROM memories
        WHERE ${visibility === 'origin' ? 'id = $1::uuid' : 'client_id = $1 AND source_key = $2'}
        LIMIT 1
      `, visibility === 'origin' ? [record.provenance.memory_id] : [auth.keyId, record.source_key]);
      const row = existing.rows[0];
      if (!row) {
        // A same-key row that RLS does not expose must remain content-free.
        counts.denied++;
        continue;
      }
      if (transferRecordFingerprint(existingToRecord(row, record, manifest)) === transferRecordFingerprint(record)) {
        counts.skipped++;
      } else {
        // V1 never overwrites divergent destination data.
        counts.conflicted++;
      }
    }

    counts.embedding_calls = pending.length;
    if (envelope.dry_run) {
      counts.inserted = pending.length;
      counts.committed = false;
      return counts;
    }

    const embeddings = pending.length > 0
      ? await embedder(pending.map(record => record.content), options.signal)
      : [];
    if (embeddings.length !== pending.length) throw new Error('Transfer embedder returned an unexpected result count');
    const serializedEmbeddings = embeddings.map(embedding => {
      if (embedding.provider !== ACTIVE_EMBEDDING_PROFILE.provider ||
          embedding.model !== ACTIVE_EMBEDDING_PROFILE.model ||
          embedding.dimensions !== ACTIVE_EMBEDDING_PROFILE.dimensions) {
        throw new Error('Transfer embedder returned an invalid destination identity');
      }
      return serializeEmbeddingVector(embedding.vector);
    });

    for (let index = 0; index < pending.length; index++) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Import cancelled');
      const record = pending[index];
      const embedding = embeddings[index];
      const result = await client.query(`
        INSERT INTO memories (
          content, embedding, source, namespace, tags, metadata, access_level,
          client_id, source_key, created_at, updated_at, event_at, memory_kind,
          valid_from, valid_to, expires_at, origin_namespace, insight_content_hash,
          embedding_provider, embedding_model, embedding_dimensions
        ) VALUES (
          $1, $2::vector, $3, $4, $5, $6::jsonb, $7,
          $8, $9, $10::timestamptz, $11::timestamptz, $12::timestamptz, $13,
          $14::timestamptz, $15::timestamptz, $16::timestamptz, $17, $18, $19, $20, $21
        )
        ON CONFLICT (client_id, source_key) DO NOTHING
        RETURNING id
      `, [
        record.content,
        serializedEmbeddings[index],
        record.source,
        record.namespace,
        record.tags,
        JSON.stringify(metadataWithTransferProvenance(record.metadata, record.provenance)),
        record.access_level,
        auth.keyId,
        record.source_key,
        record.created_at,
        record.updated_at,
        record.event_at,
        record.memory_kind,
        record.valid_from,
        record.valid_to,
        record.expires_at,
        record.origin_namespace,
        record.insight_content_hash,
        embedding.provider,
        embedding.model,
        embedding.dimensions,
      ]);
      if (result.rows.length !== 1) {
        // This should only be possible if a non-transfer writer ignored the
        // advisory-lock convention. Fail the whole transaction; replay is safe.
        throw new Error('Concurrent source-key conflict during transfer import');
      }
      counts.inserted++;
    }

    await logAudit({
      clientId: auth.keyId,
      action: 'memory.import',
      resourceType: 'transfer',
      resultCount: counts.inserted,
      details: {
        inserted: counts.inserted,
        updated: counts.updated,
        skipped: counts.skipped,
        conflicted: counts.conflicted,
        denied: counts.denied,
        failed: counts.failed,
      },
    }, dbScopeFromAuth(auth), client);
    return counts;
  });
}

async function defaultEmbedder(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult[]> {
  return embedBatchWithProfile(texts, ACTIVE_EMBEDDING_PROFILE, signal);
}

async function sourceKeyVisibility(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> },
  auth: AuthContext,
  record: TransferMemoryRecord,
): Promise<'none' | 'visible' | 'origin' | 'denied'> {
  try {
    const result = await client.query(
      'SELECT app_transfer_source_key_access($1, $2::text[], $3, $4::uuid, $5::uuid) AS access',
      [record.source_key, auth.namespaces, auth.maxAccessLevel, record.provenance.instance_id, record.provenance.memory_id],
    );
    const access = result.rows[0]?.access;
    if (access === 'none' || access === 'visible' || access === 'origin' || access === 'denied') return access;
    throw new Error('Invalid transfer source-key access result');
  } catch (error) {
    // A useful error for partially migrated deployments; do not silently use a
    // leaky or embedding-before-conflict fallback.
    if (isUndefinedFunction(error)) {
      throw new Error('Transfer schema is not initialized; apply the latest migration');
    }
    throw error;
  }
}

function existingToRecord(
  row: ExistingRow,
  incoming: TransferMemoryRecord,
  _manifest: TransferManifest,
): TransferMemoryRecord {
  return parseTransferMemoryRecord({
    type: 'memory',
    source_key: row.source_key ?? incoming.source_key,
    content: row.content,
    source: row.source,
    namespace: row.namespace,
    tags: row.tags ?? [],
    metadata: metadataWithoutTransferProvenance(row.metadata),
    access_level: row.access_level ?? 'normal',
    created_at: instant(row.created_at),
    // updated_at is deliberately not part of the fingerprint: maintenance-only
    // updates and clock differences must not create destructive conflicts.
    updated_at: incoming.updated_at,
    event_at: optionalInstant(row.event_at),
    memory_kind: row.memory_kind ?? 'unspecified',
    valid_from: optionalInstant(row.valid_from),
    valid_to: optionalInstant(row.valid_to),
    expires_at: optionalInstant(row.expires_at),
    origin_namespace: row.origin_namespace,
    insight_content_hash: row.insight_content_hash,
    provenance: incoming.provenance,
  });
}

function assertUniqueSourceKeys(records: TransferMemoryRecord[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.source_key)) throw new Error('Duplicate source_key in import batch');
    seen.add(record.source_key);
  }
}

function instant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Database returned an invalid transfer timestamp');
  return date.toISOString();
}

function optionalInstant(value: Date | string | null): string | null {
  return value === null ? null : instant(value);
}

function isUndefinedFunction(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '42883';
}

export function importBatchIdentity(manifest: TransferManifest, records: TransferMemoryRecord[]): string {
  return createHash('sha256').update(manifest.source_instance_id).update('\0')
    .update(records.map(record => record.source_key).join('\0')).digest('hex');
}
