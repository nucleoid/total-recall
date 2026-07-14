import { z } from 'zod';
import { dbScopeFromAuth, queryScoped } from '../db.js';
import type { AuthContext } from '../types.js';
import { accessLevelSql, checkPermission, filterNamespaces } from '../auth.js';

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

  const conditions: string[] = ['m.namespace = ANY($1)', 'm.deleted_at IS NULL', "to_jsonb(m)->>'consolidated_into_id' IS NULL"];
  const values: any[] = [allowedNamespaces];
  let idx = 2;

  conditions.push(accessLevelSql('m.access_level', `$${idx}`));
  values.push(auth.maxAccessLevel);
  idx++;

  if (params.source) {
    conditions.push(`m.source = $${idx}`);
    values.push(params.source);
    idx++;
  }

  if (params.tags && params.tags.length > 0) {
    conditions.push(`m.tags @> $${idx}`);
    values.push(params.tags);
    idx++;
  }

  const where = conditions.join(' AND ');

  const scope = dbScopeFromAuth(auth);
  const countRes = await queryScoped(
    scope,
    `SELECT COUNT(*) as total FROM memories m WHERE ${where}`,
    values
  );

  const limitIdx = idx++;
  const offsetIdx = idx++;
  values.push(params.limit);
  values.push(params.offset);

  const res = await queryScoped(
    scope,
    `SELECT m.id, m.content, m.source, m.namespace, m.tags, m.metadata, m.document_id,
            m.chunk_index, m.created_at, m.updated_at, m.memory_kind, m.valid_from, m.valid_to,
            m.superseded_at, m.revision,
            (to_jsonb(m)->>'consolidated_into_id')::uuid AS consolidated_into_id,
            (to_jsonb(m)->>'consolidated_at')::timestamptz AS consolidated_at,
            (SELECT predecessor.id FROM memories predecessor
             WHERE predecessor.id = m.supersedes_id
               AND predecessor.deleted_at IS NULL
               AND predecessor.namespace = m.namespace
               AND predecessor.namespace = ANY($1)
               AND ${accessLevelSql('predecessor.access_level', '$2')}
             LIMIT 1) AS supersedes_id,
            m.superseded_at IS NOT NULL AS is_superseded,
            (SELECT successor.id FROM memories successor
             WHERE successor.supersedes_id = m.id
               AND successor.deleted_at IS NULL
               AND successor.namespace = m.namespace
               AND successor.namespace = ANY($1)
               AND ${accessLevelSql('successor.access_level', '$2')}
             LIMIT 1) AS superseded_by_id
     FROM memories m WHERE ${where}
     ORDER BY m.created_at DESC
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
