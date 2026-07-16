import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { accessLevelSql, checkPermission, filterNamespaces } from '../auth.js';
import { logAudit } from '../audit.js';
import { dbScopeFromAuth, queryScoped } from '../db.js';
import { TEXT_FIELD_MAX_CHARS } from '../http-limits.js';
import type { AuthContext } from '../types.js';
import {
  createTransferManifest,
  derivedTransferSourceKey,
  metadataWithoutTransferProvenance,
  provenanceFromStoredMetadata,
  transferMemoryRecordSchema,
  type TransferManifest,
  type TransferMemoryRecord,
} from './format.js';

export const MAX_EXPORT_PAGE_RECORDS = 100;

export const exportPageSchema = z.object({
  namespaces: z.array(z.string().min(1).max(TEXT_FIELD_MAX_CHARS)).max(100).optional(),
  include_sensitive: z.boolean().default(false),
  acknowledge_plaintext_sensitive: z.boolean().default(false),
  limit: z.number().int().min(1).max(MAX_EXPORT_PAGE_RECORDS).default(100),
  cursor: z.string().min(1).max(4096).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.include_sensitive && !value.acknowledge_plaintext_sensitive) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Sensitive export requires plaintext acknowledgement', path: ['acknowledge_plaintext_sensitive'] });
  }
});

export type ExportPageParams = z.infer<typeof exportPageSchema>;

export interface ExportPageResult {
  manifest: TransferManifest;
  records: TransferMemoryRecord[];
  next_cursor: string | null;
}

type ExportRow = {
  instance_id: string;
  id: string;
  source_key: string | null;
  content: string;
  source: string;
  namespace: string;
  tags: string[] | null;
  metadata: Record<string, unknown> | null;
  access_level: 'normal' | 'sensitive' | 'secret' | null;
  created_at: Date | string;
  updated_at: Date | string;
  event_at: Date | string | null;
  memory_kind: TransferMemoryRecord['memory_kind'] | null;
  valid_from: Date | string | null;
  valid_to: Date | string | null;
  expires_at: Date | string | null;
  origin_namespace: string | null;
  insight_content_hash: string | null;
};

type CursorPayload = { v: 1; key: string; filter: string; created_at: string; id: string };
const cursorSecret = randomBytes(32);

export async function exportMemoryPage(
  rawParams: ExportPageParams,
  auth: AuthContext,
): Promise<ExportPageResult> {
  checkPermission(auth, 'export');
  const params = exportPageSchema.parse(rawParams);
  const namespaces = filterNamespaces(params.namespaces, auth.namespaces);
  if (params.namespaces && namespaces.length !== params.namespaces.length) {
    throw new Error('Access denied to one or more requested namespaces');
  }
  const filter = exportFilterFingerprint(auth, namespaces, params.include_sensitive);
  const after = params.cursor ? decodeCursor(params.cursor, auth.keyId, filter) : null;

  const values: unknown[] = [namespaces, params.include_sensitive ? auth.maxAccessLevel : 'normal'];
  const conditions = [
    'm.namespace = ANY($1::text[])',
    accessLevelSql('m.access_level', '$2'),
    'm.deleted_at IS NULL',
    '(m.expires_at IS NULL OR m.expires_at > statement_timestamp())',
    'm.superseded_at IS NULL',
    'm.consolidated_into_id IS NULL',
  ];
  if (after) {
    values.push(after.created_at, after.id);
    conditions.push(`(m.created_at, m.id) > ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(params.limit + 1);

  const result = await queryScoped<ExportRow>(dbScopeFromAuth(auth), `
    SELECT s.instance_id, m.id, m.source_key, m.content, m.source, m.namespace, m.tags, m.metadata,
           m.access_level, m.created_at, m.updated_at, m.event_at, m.memory_kind,
           m.valid_from, m.valid_to, m.expires_at, m.origin_namespace, m.insight_content_hash
    FROM memories m
    CROSS JOIN instance_settings s
    WHERE s.singleton = true AND ${conditions.join(' AND ')}
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT $${values.length}
  `, values);

  const instanceId = result.rows[0]?.instance_id ?? await getInstanceId(auth);
  const hasMore = result.rows.length > params.limit;
  const selected = result.rows.slice(0, params.limit);
  const records = selected.map(row => rowToTransferRecord(row, instanceId));
  const last = selected.at(-1);
  return {
    manifest: createTransferManifest(instanceId),
    records,
    next_cursor: hasMore && last ? encodeCursor({
      v: 1,
      key: auth.keyId,
      filter,
      created_at: instant(last.created_at),
      id: last.id,
    }) : null,
  };
}

export async function auditTransferExport(auth: AuthContext, resultCount: number): Promise<void> {
  await logAudit({
    clientId: auth.keyId,
    action: 'memory.export',
    resourceType: 'transfer',
    resultCount,
    details: { records: resultCount },
  }, dbScopeFromAuth(auth));
}

async function getInstanceId(auth: AuthContext): Promise<string> {
  const result = await queryScoped<{ instance_id: string }>(
    dbScopeFromAuth(auth),
    'SELECT instance_id FROM instance_settings WHERE singleton = true',
  );
  const instanceId = result.rows[0]?.instance_id;
  if (!instanceId) throw new Error('Transfer instance identity is not initialized; apply the latest migration');
  return instanceId;
}

function rowToTransferRecord(row: ExportRow, instanceId: string): TransferMemoryRecord {
  const storedMetadata = row.metadata ?? {};
  const fallbackProvenance = {
    trust: 'untrusted' as const,
    instance_id: instanceId,
    memory_id: row.id,
  };
  return transferMemoryRecordSchema.parse({
    type: 'memory',
    source_key: row.source_key ?? derivedTransferSourceKey(instanceId, row.id),
    content: row.content,
    source: row.source,
    namespace: row.namespace,
    tags: row.tags ?? [],
    metadata: metadataWithoutTransferProvenance(storedMetadata),
    access_level: row.access_level ?? 'normal',
    created_at: instant(row.created_at),
    updated_at: instant(row.updated_at),
    event_at: optionalInstant(row.event_at),
    memory_kind: row.memory_kind ?? 'unspecified',
    valid_from: optionalInstant(row.valid_from),
    valid_to: optionalInstant(row.valid_to),
    expires_at: optionalInstant(row.expires_at),
    origin_namespace: row.origin_namespace,
    insight_content_hash: row.insight_content_hash,
    provenance: provenanceFromStoredMetadata(storedMetadata, fallbackProvenance),
  });
}

function exportFilterFingerprint(auth: AuthContext, namespaces: string[], includeSensitive: boolean): string {
  return createHash('sha256').update(JSON.stringify({
    key: auth.keyId,
    namespaces: [...namespaces].sort(),
    includeSensitive,
    maxAccessLevel: auth.maxAccessLevel,
  })).digest('hex');
}

function encodeCursor(payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', cursorSecret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function decodeCursor(cursor: string, keyId: string, filter: string): CursorPayload {
  const [body, signature, extra] = cursor.split('.');
  if (!body || !signature || extra) throw new Error('Invalid export cursor');
  const expected = createHmac('sha256', cursorSecret).update(body).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { throw new Error('Invalid export cursor'); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Invalid export cursor');
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new Error('Invalid export cursor'); }
  const parsed = z.object({
    v: z.literal(1), key: z.string(), filter: z.string().length(64),
    created_at: z.string().datetime({ offset: true }), id: z.string().uuid(),
  }).strict().safeParse(payload);
  if (!parsed.success || parsed.data.key !== keyId || parsed.data.filter !== filter) throw new Error('Invalid export cursor');
  return parsed.data;
}

function instant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Database returned an invalid transfer timestamp');
  return date.toISOString();
}

function optionalInstant(value: Date | string | null): string | null {
  return value === null ? null : instant(value);
}
