import { z } from 'zod';
import { query } from '../db.js';
import type { AuthContext } from '../types.js';
import { checkPermission } from '../auth.js';

export const recallSchema = z.object({
  id: z.string().uuid().optional(),
  document_id: z.string().uuid().optional(),
}).refine(
  (d) => d.id || d.document_id,
  { message: 'At least one of id or document_id is required' }
);

export async function memoryRecall(
  params: z.infer<typeof recallSchema>,
  auth: AuthContext
) {
  checkPermission(auth, 'read');
  const namespaces = auth.namespaces;

  if (params.id) {
    const res = await query(
      `SELECT id, content, source, namespace, tags, metadata, access_level, created_at, updated_at, document_id, chunk_index
       FROM memories WHERE id = $1 AND namespace = ANY($2)`,
      [params.id, namespaces]
    );
    if (res.rows.length === 0) throw new Error('Memory not found or access denied');
    return res.rows[0];
  }

  const res = await query(
    `SELECT id, content, source, namespace, tags, metadata, access_level, created_at, updated_at, document_id, chunk_index
     FROM memories WHERE document_id = $1 AND namespace = ANY($2)
     ORDER BY chunk_index ASC`,
    [params.document_id, namespaces]
  );
  if (res.rows.length === 0) throw new Error('Document not found or access denied');
  return res.rows;
}
