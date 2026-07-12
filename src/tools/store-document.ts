import { createHash } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { dbScopeFromAuth, withScopedClient } from '../db.js';
import { embed } from '../embedding.js';
import type { AuthContext } from '../types.js';
import { checkPermission, filterNamespaces } from '../auth.js';

const MAX_DOCUMENT_CONTENT_LENGTH = 1_000_000;
const MAX_DOCUMENT_CHUNKS = 500;

export const storeDocumentSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1).max(MAX_DOCUMENT_CONTENT_LENGTH),
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

function chunkMarkdown(content: string): string[] {
  const lines = content.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const text = current.join('\n').trim();
    if (text) chunks.push(text);
    current = [];
  };

  for (const line of lines) {
    if (/^## /.test(line) && current.length > 0) {
      flush();
    }
    current.push(line);

    // If chunk getting too large, split on ### too
    const currentText = current.join('\n');
    if (currentText.length > 2000 && /^### /.test(line) && current.length > 1) {
      current.pop();
      flush();
      current.push(line);
    }
  }
  flush();

  // Split any remaining oversized chunks
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= 2000) {
      result.push(chunk);
    } else {
      const paras = chunk.split(/\n\n+/);
      let buf = '';
      for (const p of paras) {
        if (buf && (buf.length + p.length) > 2000) {
          result.push(buf.trim());
          buf = '';
        }
        buf += (buf ? '\n\n' : '') + p;
      }
      if (buf.trim()) result.push(buf.trim());
    }
  }
  return result;
}

function chunkPlainText(content: string): string[] {
  const paras = content.split(/\n\n+/);
  const chunks: string[] = [];
  let buf = '';

  for (const p of paras) {
    if (buf && (buf.length + p.length) > 2000) {
      chunks.push(buf.trim());
      buf = '';
    }
    buf += (buf ? '\n\n' : '') + p;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

function chunkContent(content: string): string[] {
  const isMarkdown = /^#{1,3} /m.test(content);
  const chunks = isMarkdown ? chunkMarkdown(content) : chunkPlainText(content);
  return chunks.length > 0 ? chunks : [content];
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
  checkPermission(auth, 'write');

  const ns = params.namespace;
  const allowed = filterNamespaces([ns], auth.namespaces);
  if (allowed.length === 0) {
    throw new Error(`Access denied to namespace '${ns}'`);
  }

  const chunks = chunkContent(params.content);
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
