import { z } from 'zod';
import { dbScopeFromAuth, queryScoped } from '../db.js';
import type { AuthContext } from '../types.js';
import { accessLevelSql, checkPermission } from '../auth.js';

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
    const res = await queryScoped(
      dbScopeFromAuth(auth),
      `SELECT id, content, source, namespace, tags, metadata, access_level, created_at, updated_at, document_id, chunk_index
       FROM memories WHERE id = $1 AND deleted_at IS NULL AND namespace = ANY($2) AND ${accessLevelSql('access_level', '$3')}`,
      [params.id, namespaces, auth.maxAccessLevel]
    );
    if (res.rows.length === 0) throw new Error('Memory not found or access denied');
    return res.rows[0];
  }

  const res = await queryScoped(
    dbScopeFromAuth(auth),
    `SELECT id, content, source, namespace, tags, metadata, access_level, created_at, updated_at, document_id, chunk_index
     FROM memories WHERE document_id = $1 AND deleted_at IS NULL AND namespace = ANY($2) AND ${accessLevelSql('access_level', '$3')}
     ORDER BY chunk_index ASC`,
    [params.document_id, namespaces, auth.maxAccessLevel]
  );
  if (res.rows.length === 0) throw new Error('Document not found or access denied');
  return res.rows;
}
