import { createHash } from 'node:crypto';
import { z } from 'zod';
import { metadataSchema, MEMORY_CONTENT_MAX_CHARS, TAG_MAX_CHARS, TAG_MAX_COUNT, TEXT_FIELD_MAX_CHARS } from '../http-limits.js';

export const TRANSFER_FORMAT_MAJOR = 1;
export const TRANSFER_FORMAT_MINOR = 0;
export const TRANSFER_MEDIA_TYPE = 'application/x-ndjson';
export const TRANSFER_MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
export const TRANSFER_MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
export const TRANSFER_MAX_LINE_BYTES = 512 * 1024;
export const TRANSFER_MAX_RECORDS = 100_000;
export const TRANSFER_DEFAULT_BATCH_SIZE = 25;
export const TRANSFER_MAX_BATCH_SIZE = 100;
export const TRANSFER_MAX_PAGE_SIZE = 100;
export const TRANSFER_SOURCE_KEY_MAX_CHARS = 512;
export const TRANSFER_METADATA_KEY = '_total_recall_transfer';

const instantSchema = z.string().datetime({ offset: true });
const nullableInstantSchema = instantSchema.nullable().optional();
const accessLevelSchema = z.enum(['normal', 'sensitive', 'secret']);
const memoryKindSchema = z.enum([
  'unspecified', 'semantic', 'document_chunk', 'episode_chunk', 'synced',
  'media_rollup', 'consolidation', 'insight',
]);

export const transferManifestSchema = z.object({
  type: z.literal('manifest'),
  format: z.object({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
  }),
  source_instance_id: z.string().uuid(),
  exported_at: instantSchema,
});

export const remoteProvenanceSchema = z.object({
  untrusted: z.literal(true),
  agent_name: z.string().min(1).max(TEXT_FIELD_MAX_CHARS),
  agent_type: z.string().min(1).max(TEXT_FIELD_MAX_CHARS),
  agent_model: z.string().max(TEXT_FIELD_MAX_CHARS).nullable().optional(),
  agent_runtime: z.string().max(TEXT_FIELD_MAX_CHARS).nullable().optional(),
}).optional();

export const transferMemorySchema = z.object({
  type: z.literal('memory'),
  source_key: z.string().min(1).max(TRANSFER_SOURCE_KEY_MAX_CHARS),
  content: z.string().min(1).max(MEMORY_CONTENT_MAX_CHARS),
  source: z.string().min(1).max(TEXT_FIELD_MAX_CHARS),
  namespace: z.string().min(1).max(TEXT_FIELD_MAX_CHARS),
  tags: z.array(z.string().max(TAG_MAX_CHARS)).max(TAG_MAX_COUNT).default([]),
  metadata: metadataSchema.default({}),
  access_level: accessLevelSchema.default('normal'),
  created_at: instantSchema,
  updated_at: instantSchema,
  event_at: nullableInstantSchema,
  memory_kind: memoryKindSchema.default('unspecified'),
  valid_from: nullableInstantSchema,
  valid_to: nullableInstantSchema,
  expires_at: nullableInstantSchema,
  origin_namespace: z.string().min(1).max(TEXT_FIELD_MAX_CHARS).nullable().optional(),
  insight_content_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  remote_provenance: remoteProvenanceSchema,
}).superRefine((record, context) => {
  const insightShape = record.namespace === 'insights' && record.memory_kind === 'insight' &&
    record.source === 'memory-reflection' && record.origin_namespace != null && record.insight_content_hash != null;
  const ordinaryShape = record.namespace !== 'insights' && record.memory_kind !== 'insight' &&
    record.origin_namespace == null && record.insight_content_hash == null;
  if (!insightShape && !ordinaryShape) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid portable insight shape' });
  }
});

export type TransferManifest = z.infer<typeof transferManifestSchema>;
export type TransferMemoryRecord = z.infer<typeof transferMemorySchema>;

const FORBIDDEN_V1_FIELDS = new Set([
  'id', 'embedding', 'vector', 'embedding_provider', 'embedding_model', 'embedding_dimensions',
  'client_id', 'agent_id', 'document_id', 'chunk_index', 'document', 'documents',
  'accessed_at', 'access_count', 'supersedes_id', 'superseded_by_id',
  'consolidated_into_id', 'consolidated_at',
]);
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const NONPORTABLE_METADATA_KEYS = new Set([
  TRANSFER_METADATA_KEY, 'document_id', 'chunk_index', 'chunk_count',
  'agent_id', 'client_id', 'api_key_id', 'owner_key_id', 'memory_id', 'memory_ids',
  'source_memory_id', 'member_ids', 'member_fingerprints', 'evidence_ids', 'episode_id', 'run_id',
  'api_key', 'authorization', 'bearer', 'password', 'token', 'access_token', 'refresh_token',
]);

export class TransferFormatError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line === undefined ? message : `Line ${line}: ${message}`);
    this.name = 'TransferFormatError';
  }
}

export class TransferLimitError extends TransferFormatError {
  constructor(message: string, line?: number) {
    super(message, line);
    this.name = 'TransferLimitError';
  }
}

export function parseTransferManifest(value: unknown, line = 1): TransferManifest {
  const result = transferManifestSchema.safeParse(value);
  if (!result.success) throw new TransferFormatError(result.error.issues[0]?.message ?? 'invalid manifest', line);
  if (result.data.format.major !== TRANSFER_FORMAT_MAJOR) {
    throw new TransferFormatError(`unsupported transfer format major ${result.data.format.major}`, line);
  }
  assertSafeJson(result.data, line);
  return result.data;
}

export function parseTransferMemory(value: unknown, line?: number): TransferMemoryRecord {
  if (!isPlainObject(value)) throw new TransferFormatError('memory record must be an object', line);
  const forbidden = Object.keys(value).find(key => FORBIDDEN_V1_FIELDS.has(key));
  if (forbidden) throw new TransferFormatError(`field '${forbidden}' is not portable in transfer format V1`, line);
  assertSafeJson(value, line);
  const result = transferMemorySchema.safeParse(value);
  if (!result.success) throw new TransferFormatError(result.error.issues[0]?.message ?? 'invalid memory record', line);
  const forbiddenMetadataKey = findNonportableMetadataKey(result.data.metadata);
  if (forbiddenMetadataKey) {
    throw new TransferFormatError(`metadata key '${forbiddenMetadataKey}' is not portable`, line);
  }
  return result.data;
}

export function deriveTransferSourceKey(instanceId: string, memoryId: string): string {
  const instance = z.string().uuid().parse(instanceId).toLowerCase();
  const memory = z.string().uuid().parse(memoryId).toLowerCase();
  return `total-recall:v1:${instance}:${memory}`;
}

export function parseDerivedTransferSourceKey(sourceKey: string): { instanceId: string; memoryId: string } | null {
  const match = /^total-recall:v1:([0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(sourceKey);
  if (!match || !z.string().uuid().safeParse(match[1]).success || !z.string().uuid().safeParse(match[2]).success) return null;
  return { instanceId: match[1].toLowerCase(), memoryId: match[2].toLowerCase() };
}

/** Payload identity deliberately excludes traversal/maintenance updated_at. */
export function transferPayloadDigest(record: TransferMemoryRecord): string {
  const payload = {
    content: record.content, source: record.source, namespace: record.namespace,
    tags: record.tags, metadata: record.metadata, access_level: record.access_level,
    created_at: canonicalInstant(record.created_at), event_at: canonicalNullableInstant(record.event_at),
    memory_kind: record.memory_kind, valid_from: canonicalNullableInstant(record.valid_from),
    valid_to: canonicalNullableInstant(record.valid_to), expires_at: canonicalNullableInstant(record.expires_at),
    origin_namespace: record.origin_namespace ?? null,
    insight_content_hash: record.insight_content_hash ?? null,
  };
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

/** Remove application-local identities and credential-shaped metadata from exports. */
export function sanitizeTransferMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return sanitizeObject(metadata) as Record<string, unknown>;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function canonicalInstant(value: string): string { return new Date(value).toISOString(); }
function canonicalNullableInstant(value: string | null | undefined): string | null {
  return value == null ? null : canonicalInstant(value);
}

function findNonportableMetadataKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const child of value) { const found = findNonportableMetadataKey(child); if (found) return found; }
    return null;
  }
  if (!isPlainObject(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (NONPORTABLE_METADATA_KEYS.has(key.toLowerCase())) return key;
    const found = findNonportableMetadataKey(child);
    if (found) return found;
  }
  return null;
}

function sanitizeObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeObject);
  if (!isPlainObject(value)) return value;
  const clean: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!NONPORTABLE_METADATA_KEYS.has(key.toLowerCase()) && !DANGEROUS_JSON_KEYS.has(key)) clean[key] = sanitizeObject(child);
  }
  return clean;
}

function assertSafeJson(value: unknown, line?: number, depth = 0): void {
  if (depth > 16) throw new TransferFormatError('record exceeds maximum nesting depth', line);
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeJson(entry, line, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_JSON_KEYS.has(key)) throw new TransferFormatError(`unsafe object key '${key}'`, line);
    assertSafeJson(child, line, depth + 1);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
