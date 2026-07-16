import { checkPermission } from '../auth.js';
import { dbScopeFromAuth, queryScoped, withScopedClient, type ScopedClient } from '../db.js';
import { embedBatchWithProfile, serializeEmbeddingVector, type EmbeddingResult } from '../embedding.js';
import { logAudit } from '../audit.js';
import type { AuthContext } from '../types.js';
import { metadataSchema } from '../http-limits.js';
import {
  parseTransferManifest,
  parseTransferMemory,
  sanitizeTransferMetadata,
  TRANSFER_DEFAULT_BATCH_SIZE,
  TRANSFER_MAX_BATCH_SIZE,
  TRANSFER_METADATA_KEY,
  transferPayloadDigest,
  type TransferManifest,
  type TransferMemoryRecord,
} from './format.js';

export interface ImportCounts {
  inserted: number;
  updated: number;
  skipped: number;
  conflicted: number;
  denied: number;
  failed: number;
}

export interface ImportBatchResult extends ImportCounts {
  records: number;
  committed: boolean;
  nextRecord: number;
  embeddingCalls: number;
}

export interface ImportOptions {
  dryRun?: boolean;
  recordOffset?: number;
  signal?: AbortSignal;
  embedder?: (texts: string[], signal?: AbortSignal) => Promise<EmbeddingResult[]>;
}

type ExistingRow = {
  id: string; source_key: string | null; content: string; source: string; namespace: string;
  tags: string[]; metadata: Record<string, unknown>; access_level: TransferMemoryRecord['access_level'];
  created_at: Date | string; updated_at: Date | string; event_at: Date | string | null;
  memory_kind: TransferMemoryRecord['memory_kind']; valid_from: Date | string | null;
  valid_to: Date | string | null; expires_at: Date | string | null;
  origin_namespace: string | null; insight_content_hash: string | null;
  deleted_at: Date | string | null; superseded_at: Date | string | null;
  consolidated_into_id: string | null; transfer_identity: string;
};

type Classification = {
  inserts: TransferMemoryRecord[];
  skipped: TransferMemoryRecord[];
  conflicted: TransferMemoryRecord[];
};

export async function importMemoryBatch(
  auth: AuthContext,
  manifestInput: TransferManifest,
  recordInputs: unknown[],
  options: ImportOptions = {},
): Promise<ImportBatchResult> {
  checkPermission(auth, 'import');
  const manifest = parseTransferManifest(manifestInput);
  if (recordInputs.length > TRANSFER_MAX_BATCH_SIZE) throw new Error(`Import batch exceeds ${TRANSFER_MAX_BATCH_SIZE} records`);
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('Import cancelled');

  // Validate the complete batch and destination ACL before database access or
  // provider egress. Never silently narrow an import namespace selection.
  const records = recordInputs.map(record => {
    const parsed = parseTransferMemory(record);
    return parsed.valid_from == null ? { ...parsed, valid_from: parsed.created_at } : parsed;
  });
  // The destination provenance envelope is part of the metadata budget too.
  for (const record of records) metadataSchema.parse(destinationMetadata(manifest, record));
  const duplicate = firstDuplicate(records.map(record => record.source_key));
  if (duplicate) throw new Error('Duplicate source_key in import batch');
  if (records.some(record => !auth.namespaces.includes(record.namespace) ||
      (record.origin_namespace != null && !auth.namespaces.includes(record.origin_namespace)))) {
    throw new Error('Access denied to requested import namespace');
  }
  if (records.some(record => accessRank(record.access_level) > accessRank(auth.maxAccessLevel))) {
    throw new Error('Access denied to imported memory access level');
  }

  const sourceKeys = records.map(record => record.source_key);
  const hidden = await queryScoped<{ hidden: boolean }>(
    dbScopeFromAuth(auth),
    'SELECT app_transfer_has_hidden_identity($1::text[]) AS hidden',
    [sourceKeys],
  );
  if (hidden.rows[0]?.hidden) throw new Error('Access denied to existing import identity');

  const initial = await classify(auth, records);
  const base = options.recordOffset ?? 0;
  if (options.dryRun) {
    return resultFor(initial, records.length, false, base + records.length, initial.inserts.length);
  }

  const embedder = options.embedder ?? ((texts, signal) => embedBatchWithProfile(texts, undefined, signal));
  const embeddings = initial.inserts.length === 0
    ? []
    : await embedder(initial.inserts.map(record => record.content), options.signal);
  if (embeddings.length !== initial.inserts.length) throw new Error('Destination embedding count mismatch');
  for (const embedding of embeddings) {
    if (embedding.dimensions !== 768 || !embedding.provider?.trim() || !embedding.model?.trim()) {
      throw new Error('Destination embedding descriptor is invalid');
    }
    serializeEmbeddingVector(embedding.vector);
  }
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('Import cancelled');
  const prepared = new Map(initial.inserts.map((record, index) => [record.source_key, embeddings[index]]));

  const committed = await withScopedClient(dbScopeFromAuth(auth), async client => {
    // Serialize absent-key races as well as existing rows. Sorted transaction
    // advisory locks avoid deadlocks across overlapping batches.
    for (const sourceKey of [...sourceKeys].sort()) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Import cancelled');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`memory-transfer:${auth.keyId}\0${sourceKey}`]);
    }
    // Reclassify under row locks after embedding. Concurrent equal writes become
    // skips; concurrent divergence becomes a conflict and is never overwritten.
    const current = await classifyOnClient(client, auth, records, true);
    let inserted = 0;
    for (const record of current.inserts) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Import cancelled');
      const embedding = prepared.get(record.source_key);
      if (!embedding) throw new Error('Import classification changed unexpectedly');
      await insertRecord(client, auth, manifest, record, embedding);
      inserted += 1;
    }
    const counts: ImportCounts = {
      inserted, updated: 0, skipped: current.skipped.length,
      conflicted: current.conflicted.length, denied: 0, failed: 0,
    };
    await logAudit({
      clientId: auth.keyId, action: 'memory.import.batch', resourceType: 'system',
      resultCount: inserted, details: {
        inserted: counts.inserted, updated: 0, skipped: counts.skipped,
        conflicted: counts.conflicted, denied: 0, failed: 0,
      },
    }, dbScopeFromAuth(auth), client);
    return counts;
  });

  return {
    ...committed, records: records.length, committed: true,
    nextRecord: base + records.length, embeddingCalls: initial.inserts.length,
  };
}

export function emptyImportCounts(): ImportCounts {
  return { inserted: 0, updated: 0, skipped: 0, conflicted: 0, denied: 0, failed: 0 };
}

export function addImportCounts(target: ImportCounts, addition: ImportCounts): ImportCounts {
  for (const key of Object.keys(target) as Array<keyof ImportCounts>) target[key] += addition[key];
  return target;
}

export const DEFAULT_IMPORT_BATCH_SIZE = TRANSFER_DEFAULT_BATCH_SIZE;

async function classify(auth: AuthContext, records: TransferMemoryRecord[]): Promise<Classification> {
  return withScopedClient(dbScopeFromAuth(auth), client => classifyOnClient(client, auth, records, false));
}

async function classifyOnClient(
  client: ScopedClient,
  auth: AuthContext,
  records: TransferMemoryRecord[],
  lock: boolean,
): Promise<Classification> {
  if (records.length === 0) return { inserts: [], skipped: [], conflicted: [] };
  const sourceKeys = records.map(record => record.source_key);
  const result = await client.query<ExistingRow>(`
    SELECT m.id::text, m.source_key, m.content, m.source, m.namespace, m.tags,
      COALESCE(m.metadata, '{}'::jsonb) - '${TRANSFER_METADATA_KEY}' AS metadata,
      COALESCE(m.access_level, 'normal') AS access_level,
      m.created_at, m.updated_at, m.event_at, m.memory_kind, m.valid_from, m.valid_to, m.expires_at,
      m.origin_namespace, m.insight_content_hash, m.deleted_at, m.superseded_at, (to_jsonb(m)->>'consolidated_into_id') AS consolidated_into_id,
      CASE WHEN m.source_key = ANY($1::text[]) THEN m.source_key
        ELSE 'total-recall:v1:' || settings.instance_id::text || ':' || m.id::text
      END AS transfer_identity
    FROM memories m
    CROSS JOIN instance_settings settings
    WHERE m.client_id = $2::text
      AND (m.source_key = ANY($1::text[])
        OR ('total-recall:v1:' || settings.instance_id::text || ':' || m.id::text) = ANY($1::text[]))
    ${lock ? 'FOR UPDATE OF m' : ''}
  `, [sourceKeys, auth.keyId]);
  const grouped = new Map<string, ExistingRow[]>();
  for (const row of result.rows) {
    const group = grouped.get(row.transfer_identity) ?? [];
    group.push(row);
    grouped.set(row.transfer_identity, group);
  }
  const classification: Classification = { inserts: [], skipped: [], conflicted: [] };
  for (const record of records) {
    const matches = grouped.get(record.source_key) ?? [];
    if (matches.length === 0) classification.inserts.push(record);
    else if (matches.length === 1 && matches[0].deleted_at == null &&
        matches[0].consolidated_into_id == null &&
        transferPayloadDigest(existingToRecord(matches[0], record.source_key)) === transferPayloadDigest(record)) {
      classification.skipped.push(record);
    } else classification.conflicted.push(record);
  }
  return classification;
}

async function insertRecord(
  client: ScopedClient,
  auth: AuthContext,
  manifest: TransferManifest,
  record: TransferMemoryRecord,
  embedding: EmbeddingResult,
): Promise<void> {
  const metadata = destinationMetadata(manifest, record);
  try {
    await client.query(`
      INSERT INTO memories (
        content, embedding, source, namespace, tags, metadata, access_level, client_id,
        source_key, created_at, updated_at, event_at, embedding_provider, embedding_model,
        embedding_dimensions, memory_kind, valid_from, valid_to, superseded_at, expires_at,
        origin_namespace, insight_content_hash
      ) VALUES (
        $1, $2::vector, $3, $4, $5::text[], $6::jsonb, $7, $8::text,
        $9, $10::timestamptz, $11::timestamptz, $12::timestamptz, $13, $14,
        $15, $16, $17::timestamptz, $18::timestamptz, $18::timestamptz, $19::timestamptz,
        $20, $21
      )
    `, [
      record.content, serializeEmbeddingVector(embedding.vector), record.source, record.namespace,
      record.tags, JSON.stringify(metadata), record.access_level, auth.keyId, record.source_key,
      record.created_at, record.updated_at, record.event_at ?? null, embedding.provider,
      embedding.model, embedding.dimensions, record.memory_kind, record.valid_from ?? null,
      record.valid_to ?? null, record.expires_at ?? null,
      record.origin_namespace ?? null, record.insight_content_hash ?? null,
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error('Concurrent import identity conflict');
    throw error;
  }
}

function existingToRecord(row: ExistingRow, sourceKey: string): TransferMemoryRecord {
  return parseTransferMemory({
    type: 'memory', source_key: sourceKey, content: row.content, source: row.source,
    namespace: row.namespace, tags: row.tags ?? [], metadata: sanitizeTransferMetadata(row.metadata ?? {}),
    access_level: row.access_level, created_at: toIso(row.created_at), updated_at: toIso(row.updated_at),
    event_at: nullableIso(row.event_at), memory_kind: row.memory_kind ?? 'unspecified',
    valid_from: nullableIso(row.valid_from), valid_to: nullableIso(row.valid_to),
    expires_at: nullableIso(row.expires_at), origin_namespace: row.origin_namespace,
    insight_content_hash: row.insight_content_hash,
  });
}

function destinationMetadata(manifest: TransferManifest, record: TransferMemoryRecord): Record<string, unknown> {
  return {
    ...record.metadata,
    [TRANSFER_METADATA_KEY]: {
      untrusted: true,
      source_instance_id: manifest.source_instance_id,
      ...(record.remote_provenance ? { remote_provenance: record.remote_provenance } : {}),
    },
  };
}

function resultFor(classification: Classification, records: number, committed: boolean, nextRecord: number, embeddingCalls: number): ImportBatchResult {
  return {
    inserted: classification.inserts.length, updated: 0,
    skipped: classification.skipped.length, conflicted: classification.conflicted.length,
    denied: 0, failed: 0, records, committed, nextRecord, embeddingCalls,
  };
}

function firstDuplicate(values: string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) { if (seen.has(value)) return value; seen.add(value); }
  return null;
}
function accessRank(level: string): number { return level === 'secret' ? 2 : level === 'sensitive' ? 1 : 0; }
function isUniqueViolation(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === '23505'; }
function toIso(value: Date | string): string { return new Date(value).toISOString(); }
function nullableIso(value: Date | string | null): string | null { return value == null ? null : toIso(value); }
