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
      `SELECT m.id, m.content, m.source, m.namespace, m.tags, m.metadata, m.access_level,
              m.created_at, m.updated_at, m.document_id, m.chunk_index, m.memory_kind,
              m.valid_from, m.valid_to, m.superseded_at, m.revision, m.expires_at,
              (to_jsonb(m)->>'consolidated_into_id')::uuid AS consolidated_into_id,
              (to_jsonb(m)->>'consolidated_at')::timestamptz AS consolidated_at,
              (SELECT predecessor.id FROM memories predecessor
               WHERE predecessor.id = m.supersedes_id
                 AND predecessor.deleted_at IS NULL
                 AND (predecessor.expires_at IS NULL OR predecessor.expires_at > statement_timestamp())
                 AND predecessor.namespace = m.namespace
                 AND predecessor.namespace = ANY($2)
                 AND ${accessLevelSql('predecessor.access_level', '$3')}
               LIMIT 1) AS supersedes_id,
              m.superseded_at IS NOT NULL AS is_superseded,
              (SELECT successor.id FROM memories successor
               WHERE successor.supersedes_id = m.id
                 AND successor.deleted_at IS NULL
                 AND (successor.expires_at IS NULL OR successor.expires_at > statement_timestamp())
                 AND successor.namespace = m.namespace
                 AND successor.namespace = ANY($2)
                 AND ${accessLevelSql('successor.access_level', '$3')}
               LIMIT 1) AS superseded_by_id
       FROM memories m WHERE m.id = $1 AND m.deleted_at IS NULL
         AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
         AND m.namespace = ANY($2) AND ${accessLevelSql('m.access_level', '$3')}`,
      [params.id, namespaces, auth.maxAccessLevel]
    );
    if (res.rows.length === 0) throw new Error('Memory not found or access denied');
    return res.rows[0];
  }

  const res = await queryScoped(
    dbScopeFromAuth(auth),
    `SELECT m.id, m.content, m.source, m.namespace, m.tags, m.metadata, m.access_level,
            m.created_at, m.updated_at, m.document_id, m.chunk_index, m.memory_kind,
            m.valid_from, m.valid_to, m.superseded_at, m.revision, m.expires_at,
            (to_jsonb(m)->>'consolidated_into_id')::uuid AS consolidated_into_id,
            (to_jsonb(m)->>'consolidated_at')::timestamptz AS consolidated_at,
            (SELECT predecessor.id FROM memories predecessor
             WHERE predecessor.id = m.supersedes_id
               AND predecessor.deleted_at IS NULL
               AND (predecessor.expires_at IS NULL OR predecessor.expires_at > statement_timestamp())
               AND predecessor.namespace = m.namespace
               AND predecessor.namespace = ANY($2)
               AND ${accessLevelSql('predecessor.access_level', '$3')}
             LIMIT 1) AS supersedes_id,
            m.superseded_at IS NOT NULL AS is_superseded,
            (SELECT successor.id FROM memories successor
             WHERE successor.supersedes_id = m.id
               AND successor.deleted_at IS NULL
               AND (successor.expires_at IS NULL OR successor.expires_at > statement_timestamp())
               AND successor.namespace = m.namespace
               AND successor.namespace = ANY($2)
               AND ${accessLevelSql('successor.access_level', '$3')}
             LIMIT 1) AS superseded_by_id
     FROM memories m WHERE m.document_id = $1 AND m.deleted_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
       AND to_jsonb(m)->>'consolidated_into_id' IS NULL AND m.namespace = ANY($2) AND ${accessLevelSql('m.access_level', '$3')}
     ORDER BY m.chunk_index ASC`,
    [params.document_id, namespaces, auth.maxAccessLevel]
  );
  if (res.rows.length === 0) throw new Error('Document not found or access denied');
  return res.rows;
}
