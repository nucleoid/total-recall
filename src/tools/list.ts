import { z } from 'zod';
import { dbScopeFromAuth, queryScoped } from '../db.js';
import type { AuthContext } from '../types.js';
import { checkPermission, filterNamespaces } from '../auth.js';

export const listSchema = z.object({
  namespace: z.string().optional(),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().min(1).max(100).default(20),
  offset: z.number().min(0).default(0),
});

export async function memoryList(
  params: z.infer<typeof listSchema>,
  auth: AuthContext
) {
  checkPermission(auth, 'read');

  const allowedNamespaces = filterNamespaces(
    params.namespace ? [params.namespace] : undefined,
    auth.namespaces
  );

  if (allowedNamespaces.length === 0) {
    return { memories: [], total: 0 };
  }

  const conditions: string[] = ['namespace = ANY($1)'];
  const values: any[] = [allowedNamespaces];
  let idx = 2;

  if (params.source) {
    conditions.push(`source = $${idx}`);
    values.push(params.source);
    idx++;
  }

  if (params.tags && params.tags.length > 0) {
    conditions.push(`tags @> $${idx}`);
    values.push(params.tags);
    idx++;
  }

  const where = conditions.join(' AND ');

  const scope = dbScopeFromAuth(auth);
  const countRes = await queryScoped(
    scope,
    `SELECT COUNT(*) as total FROM memories WHERE ${where}`,
    values
  );

  const limitIdx = idx++;
  const offsetIdx = idx++;
  values.push(params.limit);
  values.push(params.offset);

  const res = await queryScoped(
    scope,
    `SELECT id, content, source, namespace, tags, metadata, document_id, chunk_index, created_at
     FROM memories WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    values
  );

  return {
    memories: res.rows,
    total: parseInt(countRes.rows[0].total, 10),
    limit: params.limit,
    offset: params.offset,
  };
}
