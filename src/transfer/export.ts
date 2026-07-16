import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { accessLevelSql, checkPermission } from '../auth.js';
import { dbScopeFromAuth, queryScoped, queryUnscoped } from '../db.js';
import type { AuthContext } from '../types.js';
import {
  deriveTransferSourceKey,
  parseTransferMemory,
  sanitizeTransferMetadata,
  TRANSFER_FORMAT_MAJOR,
  TRANSFER_FORMAT_MINOR,
  TRANSFER_MAX_PAGE_SIZE,
  TRANSFER_METADATA_KEY,
  type TransferManifest,
  type TransferMemoryRecord,
} from './format.js';

export interface ExportFilters {
  namespaces?: string[];
  includeProtected?: boolean;
  acknowledgePlaintext?: boolean;
  pageSize?: number;
  after?: { createdAt: string; id: string };
}

export interface ExportPage {
  records: TransferMemoryRecord[];
  next: { createdAt: string; id: string } | null;
}

type ExportRow = {
  id: string; source_key: string | null; content: string; source: string; namespace: string;
  tags: string[]; metadata: Record<string, unknown>; access_level: 'normal' | 'sensitive' | 'secret';
  created_at: Date | string; updated_at: Date | string; event_at: Date | string | null;
  memory_kind: TransferMemoryRecord['memory_kind']; valid_from: Date | string | null;
  valid_to: Date | string | null; expires_at: Date | string | null;
  origin_namespace: string | null; insight_content_hash: string | null;
  provenance: Record<string, unknown> | null;
};

let cursorSecret: string | undefined;
function getCursorSecret(): string {
  return cursorSecret ??= process.env.TRANSFER_CURSOR_SECRET?.trim() || randomBytes(32).toString('hex');
}

export async function getInstanceId(): Promise<string> {
  const result = await queryUnscoped<{ instance_id: string }>(
    'SELECT instance_id::text AS instance_id FROM instance_settings WHERE singleton = TRUE',
  );
  if (result.rows.length !== 1) throw new Error('Transfer instance identity is not initialized; apply migration 034');
  return result.rows[0].instance_id;
}

export async function createTransferManifest(): Promise<TransferManifest> {
  return {
    type: 'manifest', format: { major: TRANSFER_FORMAT_MAJOR, minor: TRANSFER_FORMAT_MINOR },
    source_instance_id: await getInstanceId(), exported_at: new Date().toISOString(),
  };
}

export async function exportMemoryPage(auth: AuthContext, filters: ExportFilters = {}): Promise<ExportPage> {
  checkPermission(auth, 'export');
  const namespaces = resolveExportNamespaces(auth, filters.namespaces);
  validateProtectedExport(filters);
  const pageSize = Math.min(Math.max(filters.pageSize ?? TRANSFER_MAX_PAGE_SIZE, 1), TRANSFER_MAX_PAGE_SIZE);
  if (namespaces.length === 0) return { records: [], next: null };

  const values: unknown[] = [namespaces, filters.includeProtected === true ? auth.maxAccessLevel : 'normal'];
  const conditions = [
    'm.namespace = ANY($1::text[])', accessLevelSql('m.access_level', '$2'),
    'm.deleted_at IS NULL', '(m.expires_at IS NULL OR m.expires_at > statement_timestamp())',
    "(to_jsonb(m)->>'consolidated_into_id') IS NULL",
  ];
  if (filters.after) {
    values.push(filters.after.createdAt, filters.after.id);
    conditions.push(`(m.created_at, m.id) > ($3::timestamptz, $4::uuid)`);
  }
  values.push(pageSize + 1);
  const limit = `$${values.length}`;
  const result = await queryScoped<ExportRow>(dbScopeFromAuth(auth), `
    SELECT m.id::text, m.source_key, m.content, m.source, m.namespace, m.tags,
      COALESCE(m.metadata, '{}'::jsonb) - '${TRANSFER_METADATA_KEY}' AS metadata,
      COALESCE(m.access_level, 'normal') AS access_level,
      m.created_at, m.updated_at, m.event_at, m.memory_kind, m.valid_from, m.valid_to, m.expires_at,
      m.origin_namespace, m.insight_content_hash,
      COALESCE(
        CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
          'untrusted', true, 'agent_name', a.name, 'agent_type', a.type,
          'agent_model', a.model, 'agent_runtime', a.runtime
        ) END,
        m.metadata->'${TRANSFER_METADATA_KEY}'->'remote_provenance'
      ) AS provenance
    FROM memories m
    LEFT JOIN agents a ON a.id = m.agent_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT ${limit}
  `, values);

  const hasMore = result.rows.length > pageSize;
  const rows = result.rows.slice(0, pageSize);
  const instanceId = await getInstanceId();
  const records = rows.map(row => rowToTransferRecord(row, instanceId));
  const last = rows.at(-1);
  return {
    records,
    next: hasMore && last ? { createdAt: toIso(last.created_at), id: last.id } : null,
  };
}

export async function streamMemoryExport(
  response: ServerResponse,
  auth: AuthContext,
  filters: Omit<ExportFilters, 'after'>,
  signal?: AbortSignal,
): Promise<number> {
  const manifest = await createTransferManifest();
  await writeLine(response, manifest, signal);
  let after: ExportFilters['after'];
  let count = 0;
  do {
    if (signal?.aborted) throw signal.reason ?? new Error('Export cancelled');
    const page = await exportMemoryPage(auth, { ...filters, after });
    for (const record of page.records) {
      await writeLine(response, record, signal);
      count += 1;
    }
    after = page.next ?? undefined;
  } while (after);
  return count;
}

export function encodeExportCursor(auth: AuthContext, position: NonNullable<ExportPage['next']>): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, key: auth.keyId, ...position })).toString('base64url');
  const signature = createHmac('sha256', getCursorSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function decodeExportCursor(auth: AuthContext, cursor: string): NonNullable<ExportPage['next']> {
  const [payload, signature, extra] = cursor.split('.');
  if (!payload || !signature || extra) throw new Error('Invalid transfer cursor');
  const expected = createHmac('sha256', getCursorSecret()).update(payload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { throw new Error('Invalid transfer cursor'); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Invalid transfer cursor');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new Error('Invalid transfer cursor'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid transfer cursor');
  const value = parsed as Record<string, unknown>;
  if (value.v !== 1 || value.key !== auth.keyId || typeof value.createdAt !== 'string' ||
      typeof value.id !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)) {
    throw new Error('Invalid transfer cursor');
  }
  return { createdAt: value.createdAt, id: value.id };
}

function resolveExportNamespaces(auth: AuthContext, requested?: string[]): string[] {
  const unique = requested ? [...new Set(requested)] : [...auth.namespaces];
  const denied = unique.filter(namespace => !auth.namespaces.includes(namespace));
  if (denied.length) throw new Error('Access denied to requested export namespace');
  return unique;
}

function validateProtectedExport(filters: ExportFilters): void {
  if (filters.includeProtected && !filters.acknowledgePlaintext) {
    throw new Error('Sensitive/secret export requires acknowledgement that the feed contains plaintext');
  }
}

function rowToTransferRecord(row: ExportRow, instanceId: string): TransferMemoryRecord {
  const candidate = {
    type: 'memory' as const,
    source_key: row.source_key ?? deriveTransferSourceKey(instanceId, row.id),
    content: row.content, source: row.source, namespace: row.namespace, tags: row.tags ?? [],
    metadata: sanitizeTransferMetadata(row.metadata ?? {}), access_level: row.access_level,
    created_at: toIso(row.created_at), updated_at: toIso(row.updated_at),
    event_at: toNullableIso(row.event_at), memory_kind: row.memory_kind ?? 'unspecified',
    valid_from: toNullableIso(row.valid_from), valid_to: toNullableIso(row.valid_to),
    expires_at: toNullableIso(row.expires_at),
    origin_namespace: row.origin_namespace, insight_content_hash: row.insight_content_hash,
    ...(row.provenance ? { remote_provenance: row.provenance } : {}),
  };
  return parseTransferMemory(candidate);
}

async function writeLine(response: ServerResponse, value: unknown, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error('Export cancelled');
  if (response.destroyed || response.writableEnded) throw new Error('Export response closed');
  if (response.write(`${JSON.stringify(value)}\n`)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain); response.off('close', onClose); response.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('Export response closed')); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onAbort = () => { cleanup(); reject(signal?.reason ?? new Error('Export cancelled')); };
    response.once('drain', onDrain); response.once('close', onClose); response.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toIso(value: Date | string): string { return new Date(value).toISOString(); }
function toNullableIso(value: Date | string | null): string | null { return value == null ? null : toIso(value); }
