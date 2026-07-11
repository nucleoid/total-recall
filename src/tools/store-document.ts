import { z } from 'zod';
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
});

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

export async function memoryStoreDocument(
  params: z.infer<typeof storeDocumentSchema>,
  auth: AuthContext
): Promise<{ document_id: string; chunks_stored: number; title: string }> {
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

  const embeddings: number[][] = [];
  for (const chunk of chunks) {
    embeddings.push(await embed(chunk));
  }

  const documentId = await withScopedClient(dbScopeFromAuth(auth), async (client) => {
    const docRes = await client.query(
      `INSERT INTO documents (title, source, namespace, tags)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [params.title, params.source, ns, params.tags]
    );
    const id = docRes.rows[0].id;

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

    await client.query(
      `UPDATE documents SET chunk_count = $1 WHERE id = $2`,
      [chunks.length, id]
    );

    return id;
  });

  return { document_id: documentId, chunks_stored: chunks.length, title: params.title };
}
