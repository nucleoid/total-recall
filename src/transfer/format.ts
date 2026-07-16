import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MEMORY_CONTENT_MAX_CHARS,
  TAG_MAX_CHARS,
  TAG_MAX_COUNT,
  TEXT_FIELD_MAX_CHARS,
  metadataSchema,
} from '../http-limits.js';

export const TRANSFER_FORMAT_NAME = 'total-recall-memory-feed';
export const TRANSFER_FORMAT_MAJOR = 1;
export const TRANSFER_FORMAT_MINOR = 0;
export const MAX_TRANSFER_LINE_BYTES = 1024 * 1024;
export const MAX_TRANSFER_RECORDS = 100_000;
export const MAX_TRANSFER_COMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_TRANSFER_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_TRANSFER_BATCH_RECORDS = 100;
export const MAX_SOURCE_KEY_CHARS = 1024;

const offsetDateTime = z.string().datetime({ offset: true });
const nullableDateTime = offsetDateTime.nullable();
const uuid = z.string().uuid();

export const transferManifestSchema = z.object({
  type: z.literal('manifest'),
  format: z.literal(TRANSFER_FORMAT_NAME),
  version: z.object({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
  }).passthrough(),
  source_instance_id: uuid,
  exported_at: offsetDateTime,
}).passthrough();

const FORBIDDEN_PORTABILITY_FIELDS = new Set([
  'embedding', 'vector', 'embedding_provider', 'embedding_model', 'embedding_dimensions',
  'document_id', 'chunk_index', 'document', 'documents', 'document_topology', 'chunk_count',
  'access_count', 'accessed_at', 'relevance_score', 'client_id', 'agent_id', 'session_id',
  'supersedes_id', 'superseded_by_id', 'consolidated_into_id', 'deleted_at',
]);

const provenanceSchema = z.object({
  trust: z.literal('untrusted'),
  instance_id: uuid,
  memory_id: uuid,
}).passthrough();

export const transferMemoryRecordSchema = z.object({
  type: z.literal('memory'),
  source_key: z.string().min(1).max(MAX_SOURCE_KEY_CHARS),
  content: z.string().min(1).max(MEMORY_CONTENT_MAX_CHARS),
  source: z.string().min(1).max(TEXT_FIELD_MAX_CHARS),
  namespace: z.string().min(1).max(TEXT_FIELD_MAX_CHARS),
  tags: z.array(z.string().min(1).max(TAG_MAX_CHARS)).max(TAG_MAX_COUNT).default([]),
  metadata: metadataSchema.default({}),
  access_level: z.enum(['normal', 'sensitive', 'secret']).default('normal'),
  created_at: offsetDateTime,
  updated_at: offsetDateTime,
  event_at: nullableDateTime.optional().default(null),
  memory_kind: z.enum([
    'unspecified', 'semantic', 'document_chunk', 'episode_chunk', 'synced',
    'media_rollup', 'consolidation', 'insight',
  ]).default('unspecified'),
  valid_from: nullableDateTime.optional().default(null),
  valid_to: nullableDateTime.optional().default(null),
  expires_at: nullableDateTime.optional().default(null),
  origin_namespace: z.string().min(1).max(TEXT_FIELD_MAX_CHARS).nullable().optional().default(null),
  insight_content_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional().default(null),
  provenance: provenanceSchema,
}).passthrough().superRefine((record, ctx) => {
  for (const field of FORBIDDEN_PORTABILITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} is not portable in transfer format v1`, path: [field] });
    }
  }
  if (record.memory_kind === 'insight') {
    if (record.namespace !== 'insights' || record.source !== 'memory-reflection' || !record.origin_namespace || !record.insight_content_hash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Insight records require their portable reflection identity' });
    }
  } else if (record.origin_namespace !== null || record.insight_content_hash !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Reflection identity is valid only for insight records' });
  }
  const badMetadataPath = prototypeLikePath(record.metadata);
  if (badMetadataPath) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Metadata contains a prototype-like key', path: ['metadata', ...badMetadataPath] });
  }
});

export type TransferManifest = z.infer<typeof transferManifestSchema>;
export type TransferMemoryRecord = z.infer<typeof transferMemoryRecordSchema>;

export function createTransferManifest(sourceInstanceId: string, exportedAt = new Date()): TransferManifest {
  return transferManifestSchema.parse({
    type: 'manifest',
    format: TRANSFER_FORMAT_NAME,
    version: { major: TRANSFER_FORMAT_MAJOR, minor: TRANSFER_FORMAT_MINOR },
    source_instance_id: sourceInstanceId,
    exported_at: exportedAt.toISOString(),
  });
}

export function parseTransferManifest(value: unknown): TransferManifest {
  const manifest = transferManifestSchema.parse(value);
  if (manifest.version.major !== TRANSFER_FORMAT_MAJOR) {
    throw new Error(`Unsupported transfer format major version ${manifest.version.major}`);
  }
  return manifest;
}

export function parseTransferMemoryRecord(value: unknown): TransferMemoryRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const badMetadataPath = prototypeLikePath((value as Record<string, unknown>).metadata);
    if (badMetadataPath) throw new Error('Metadata contains a prototype-like key');
  }
  return transferMemoryRecordSchema.parse(value);
}

/** A null local key gets a stable portable identity without mutating its source row. */
export function derivedTransferSourceKey(sourceInstanceId: string, sourceMemoryId: string): string {
  const instance = uuid.parse(sourceInstanceId).toLowerCase();
  const memory = uuid.parse(sourceMemoryId).toLowerCase();
  const digest = createHash('sha256').update(instance).update('\0').update(memory).digest('hex');
  return `total-recall-transfer:v1:${digest}`;
}

export function encodeJsonLine(value: unknown): string {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_TRANSFER_LINE_BYTES) {
    throw new Error(`Transfer record exceeds ${MAX_TRANSFER_LINE_BYTES} bytes`);
  }
  return line;
}

export function parseJsonLine(line: Buffer, lineNumber: number, firstLine = false): unknown {
  if (line.byteLength > MAX_TRANSFER_LINE_BYTES) throw new Error(`Line ${lineNumber} exceeds ${MAX_TRANSFER_LINE_BYTES} bytes`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(line);
  } catch {
    throw new Error(`Line ${lineNumber} is not valid UTF-8`);
  }
  if (firstLine && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim().length === 0) throw new Error(`Line ${lineNumber} is blank`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Line ${lineNumber} is not valid JSON`);
  }
}

export function transferRecordFingerprint(record: TransferMemoryRecord): string {
  return createHash('sha256').update(stableJson({
    content: record.content,
    source: record.source,
    namespace: record.namespace,
    tags: record.tags,
    metadata: record.metadata,
    access_level: record.access_level,
    created_at: normalizeInstant(record.created_at),
    event_at: normalizeOptionalInstant(record.event_at),
    memory_kind: record.memory_kind,
    valid_from: normalizeOptionalInstant(record.valid_from),
    valid_to: normalizeOptionalInstant(record.valid_to),
    expires_at: normalizeOptionalInstant(record.expires_at),
    origin_namespace: record.origin_namespace,
    insight_content_hash: record.insight_content_hash,
  })).digest('hex');
}

export function metadataWithoutTransferProvenance(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const copy = { ...(value as Record<string, unknown>) };
  delete copy._total_recall_transfer;
  return copy;
}

export function metadataWithTransferProvenance(
  metadata: Record<string, unknown>,
  provenance: TransferMemoryRecord['provenance'],
): Record<string, unknown> {
  // This destination-only marker is stripped before the next export. It may
  // make the stored object slightly larger than the public request budget, but
  // dropping it would break origin resolution on a return trip.
  return { ...metadata, _total_recall_transfer: provenance };
}

export function provenanceFromStoredMetadata(
  metadata: unknown,
  fallback: TransferMemoryRecord['provenance'],
): TransferMemoryRecord['provenance'] {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const parsed = provenanceSchema.safeParse((metadata as Record<string, unknown>)._total_recall_transfer);
    if (parsed.success) return parsed.data;
  }
  return fallback;
}

function normalizeInstant(value: string): string {
  return new Date(value).toISOString();
}

function normalizeOptionalInstant(value: string | null | undefined): string | null {
  return value ? normalizeInstant(value) : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key =>
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function prototypeLikePath(value: unknown, path: string[] = []): string[] | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const result = prototypeLikePath(value[index], [...path, String(index)]);
      if (result) return result;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return [...path, key];
    const result = prototypeLikePath(child, [...path, key]);
    if (result) return result;
  }
  return null;
}
