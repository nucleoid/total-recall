import { createHash } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { dbScopeFromAuth, withScopedClient } from '../db.js';
import { embed } from '../embedding.js';
import type { AuthContext } from '../types.js';
import { checkPermission, filterNamespaces } from '../auth.js';

export const MAX_DOCUMENT_CONTENT_BYTES = 1024 * 1024;
export const MAX_DOCUMENT_CHUNK_BYTES = 2_000;
// Greedy packing can create at most two chunks per chunk-sized span, plus one.
const MAX_DOCUMENT_CHUNKS = Math.ceil((MAX_DOCUMENT_CONTENT_BYTES * 2) / MAX_DOCUMENT_CHUNK_BYTES) + 1;

export const storeDocumentSchema = z.object({
  title: z.string().min(1),
  content: z.string().superRefine((value, ctx) => {
    if (value.trim().length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Document content must contain non-whitespace text' });
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_DOCUMENT_CONTENT_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Document content must not exceed 1 MiB of decoded UTF-8',
      });
    }
  }),
  namespace: z.string().default('shared'),
  tags: z.array(z.string()).default([]),
  source: z.string().default('manual'),
  idempotency_key: z.string().min(1).max(200).optional(),
});

type StoreDocumentParams = z.infer<typeof storeDocumentSchema>;
type StoredDocumentResult = { document_id: string; chunks_stored: number; title: string };
type ExistingDocumentRow = {
  id: string;
  title: string;
  chunk_count: number | string;
  request_hash: string | null;
  actual_count: number | string;
};

export class StoreDocumentConflictError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'StoreDocumentConflictError';
  }
}

export function isStoreDocumentConflictError(err: unknown): err is StoreDocumentConflictError {
  return err instanceof StoreDocumentConflictError ||
    (typeof err === 'object' && err !== null && (err as { statusCode?: unknown }).statusCode === 409);
}

function preferredBoundaryOffsets(content: string): number[] {
  const offsets = new Set<number>([0, content.length]);

  // Keep paragraph separators with the paragraph before them.
  for (const match of content.matchAll(/(?:\r?\n[\t ]*){2,}/g)) {
    offsets.add(match.index + match[0].length);
  }

  // A heading starts a preferred segment; its preceding newline stays untouched.
  for (const match of content.matchAll(/(?:^|\r?\n)(?=#{1,6}[\t ])/gm)) {
    offsets.add(match.index + match[0].length);
  }

  return [...offsets].sort((a, b) => a - b);
}

function hardSplitByUtf8Bytes(value: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (current && currentBytes + codePointBytes > maxBytes) {
      pieces.push(current);
      current = '';
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += codePointBytes;
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Losslessly chunks content, preferring markdown/paragraph boundaries. */
export function chunkDocumentContent(content: string): string[] {
  if (content.length === 0) return [];

  const offsets = preferredBoundaryOffsets(content);
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  const flush = () => {
    if (current) chunks.push(current);
    current = '';
    currentBytes = 0;
  };

  for (let i = 1; i < offsets.length; i++) {
    const segment = content.slice(offsets[i - 1], offsets[i]);
    const segmentBytes = Buffer.byteLength(segment, 'utf8');

    if (currentBytes + segmentBytes <= MAX_DOCUMENT_CHUNK_BYTES) {
      current += segment;
      currentBytes += segmentBytes;
      continue;
    }

    flush();
    const pieces = hardSplitByUtf8Bytes(segment, MAX_DOCUMENT_CHUNK_BYTES);
    for (let j = 0; j < pieces.length; j++) {
      const piece = pieces[j];
      if (j < pieces.length - 1) {
        chunks.push(piece);
      } else {
        current = piece;
        currentBytes = Buffer.byteLength(piece, 'utf8');
      }
    }
  }
  flush();

  if (chunks.some((chunk) => chunk.length === 0 || Buffer.byteLength(chunk, 'utf8') > MAX_DOCUMENT_CHUNK_BYTES)) {
    throw new Error('Document chunking produced an invalid embedding chunk');
  }
  return chunks;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags)].sort();
}

function canonicalRequestHash(params: StoreDocumentParams): string {
  const canonical = JSON.stringify({
    version: 1,
    title: params.title,
    content: params.content,
    namespace: params.namespace,
    source: params.source,
    tags: normalizeTags(params.tags),
  });
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:v1:${digest}`;
}

function validateEmbedding(embedding: number[], index: number): void {
  if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every(Number.isFinite)) {
    throw new Error(`Embedding provider returned an invalid vector for chunk ${index}`);
  }
}

async function findExistingDocument(
  client: pg.PoolClient,
  auth: AuthContext,
  namespace: string,
  idempotencyKey: string
): Promise<ExistingDocumentRow | null> {
  const res = await client.query<ExistingDocumentRow>(
    `SELECT d.id,
            d.title,
            d.chunk_count,
            d.request_hash,
            COUNT(m.id)::int AS actual_count
     FROM documents d
     LEFT JOIN memories m
       ON m.document_id = d.id
      AND m.client_id = $1
     WHERE d.client_id = $1::uuid
       AND d.namespace = $2
       AND d.idempotency_key = $3
     GROUP BY d.id, d.title, d.chunk_count, d.request_hash`,
    [auth.keyId, namespace, idempotencyKey]
  );
  return res.rows[0] ?? null;
}

function completedExistingResult(
  row: ExistingDocumentRow,
  requestHash: string
): StoredDocumentResult {
  if (row.request_hash !== requestHash) {
    throw new StoreDocumentConflictError('Idempotency key already used for a different document request');
  }

  const chunkCount = Number(row.chunk_count);
  const actualCount = Number(row.actual_count);
  if (!Number.isInteger(chunkCount) || chunkCount <= 0 || actualCount !== chunkCount) {
    throw new StoreDocumentConflictError('Idempotency key points to an incomplete document write');
  }

  return { document_id: row.id, chunks_stored: chunkCount, title: row.title };
}

export async function memoryStoreDocument(
  params: StoreDocumentParams,
  auth: AuthContext
): Promise<StoredDocumentResult> {
  // Keep direct callers on the same decoded-content contract as MCP and REST.
  params = storeDocumentSchema.parse(params);
  checkPermission(auth, 'write');

  const ns = params.namespace;
  const allowed = filterNamespaces([ns], auth.namespaces);
  if (allowed.length === 0) {
    throw new Error(`Access denied to namespace '${ns}'`);
  }

  const chunks = chunkDocumentContent(params.content);
  if (chunks.length > MAX_DOCUMENT_CHUNKS) {
    throw new Error(`Document has too many chunks (${chunks.length}); maximum is ${MAX_DOCUMENT_CHUNKS}`);
  }

  const requestHash = canonicalRequestHash(params);
  if (params.idempotency_key) {
    const existing = await withScopedClient(dbScopeFromAuth(auth), async (client) =>
      findExistingDocument(client, auth, ns, params.idempotency_key!)
    );
    if (existing) {
      return completedExistingResult(existing, requestHash);
    }
  }

  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embed(chunks[i]);
    validateEmbedding(embedding, i);
    embeddings.push(embedding);
  }

  const result = await withScopedClient(dbScopeFromAuth(auth), async (client) => {
    const docRes = await client.query(
      `INSERT INTO documents (title, source, namespace, tags, client_id, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5::uuid, $6, $7)
       ON CONFLICT (client_id, namespace, idempotency_key)
         WHERE client_id IS NOT NULL AND idempotency_key IS NOT NULL
         DO NOTHING
       RETURNING id`,
      [params.title, params.source, ns, params.tags, auth.keyId, params.idempotency_key ?? null, requestHash]
    );

    if (docRes.rows.length === 0) {
      if (!params.idempotency_key) {
        throw new Error('Document insert failed without an idempotency conflict');
      }
      const existing = await findExistingDocument(client, auth, ns, params.idempotency_key);
      if (!existing) {
        throw new StoreDocumentConflictError('Document idempotency conflict could not be resolved');
      }
      return completedExistingResult(existing, requestHash);
    }

    const id = docRes.rows[0].id as string;

    for (let i = 0; i < chunks.length; i++) {
      const vecStr = `[${embeddings[i].join(',')}]`;

      await client.query(
        `INSERT INTO memories (content, embedding, source, namespace, tags, metadata, access_level, client_id, document_id, chunk_index)
         VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          chunks[i],
          vecStr,
          params.source,
          ns,
          params.tags,
          '{}',
          'normal',
          auth.keyId,
          id,
          i,
        ]
      );
    }

    const countRes = await client.query(
      `UPDATE documents SET chunk_count = $1 WHERE id = $2 AND client_id = $3::uuid AND namespace = $4`,
      [chunks.length, id, auth.keyId, ns]
    );
    if (countRes.rowCount !== 1) {
      throw new Error('Document chunk count update failed');
    }

    return { document_id: id, chunks_stored: chunks.length, title: params.title };
  });

  return result;
}
