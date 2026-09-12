import { z } from 'zod';
import { dbScopeFromAuth, withScopedClient } from '../db.js';
import type { AuthContext } from '../types.js';
import { accessLevelSql, checkPermission } from '../auth.js';
import { logAudit } from '../audit.js';

export const statsSchema = z.object({});

export async function memoryStats(
  _params: z.infer<typeof statsSchema>,
  auth: AuthContext
) {
  checkPermission(auth, 'admin');
  checkPermission(auth, 'read');

  const ns = auth.namespaces;
  const scope = dbScopeFromAuth(auth);
  const accessWhere = `deleted_at IS NULL
    AND (expires_at IS NULL OR expires_at > statement_timestamp())
    AND to_jsonb(memories)->>'consolidated_into_id' IS NULL AND ${accessLevelSql('access_level', '$2')}`;
  const values = [ns, auth.maxAccessLevel];

  return withScopedClient(scope, async (client) => {
    const result = await client.query<{
      total: string;
      by_namespace: Array<{ namespace: string; count: number }>;
      by_source: Array<{ source: string | null; count: number }>;
      total_documents: string;
      oldest_memory: Date | null;
      newest_memory: Date | null;
    }>(
      `WITH grouped AS (
         SELECT namespace,
                source,
                document_id,
                GROUPING(namespace) AS namespace_grouped,
                GROUPING(source) AS source_grouped,
                GROUPING(document_id) AS document_grouped,
                COUNT(*) AS memory_count,
                MIN(created_at) AS oldest_memory,
                MAX(created_at) AS newest_memory
         FROM memories
         WHERE namespace = ANY($1) AND ${accessWhere}
         GROUP BY GROUPING SETS ((), (namespace), (source), (document_id))
       )
       SELECT COALESCE(MAX(memory_count) FILTER (
                WHERE namespace_grouped = 1 AND source_grouped = 1 AND document_grouped = 1
              ), 0)::text AS total,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object('namespace', namespace, 'count', memory_count)
                  ORDER BY memory_count DESC
                ) FILTER (
                  WHERE namespace_grouped = 0 AND source_grouped = 1 AND document_grouped = 1
                ),
                '[]'::jsonb
              ) AS by_namespace,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object('source', source, 'count', memory_count)
                  ORDER BY memory_count DESC
                ) FILTER (
                  WHERE namespace_grouped = 1 AND source_grouped = 0 AND document_grouped = 1
                ),
                '[]'::jsonb
              ) AS by_source,
              COUNT(*) FILTER (
                WHERE namespace_grouped = 1 AND source_grouped = 1
                  AND document_grouped = 0 AND document_id IS NOT NULL
              )::text AS total_documents,
              MAX(oldest_memory) FILTER (
                WHERE namespace_grouped = 1 AND source_grouped = 1 AND document_grouped = 1
              ) AS oldest_memory,
              MAX(newest_memory) FILTER (
                WHERE namespace_grouped = 1 AND source_grouped = 1 AND document_grouped = 1
              ) AS newest_memory
       FROM grouped`,
      values
    );
    const stats = result.rows[0];

    await logAudit({
      clientId: auth.keyId, action: 'memory.stats', resourceType: 'system',
      resultCount: parseInt(stats.total, 10),
    }, scope, client);

    return {
      total_memories: parseInt(stats.total, 10),
      by_namespace: stats.by_namespace,
      by_source: stats.by_source,
      total_documents: parseInt(stats.total_documents, 10),
      oldest_memory: stats.oldest_memory,
      newest_memory: stats.newest_memory,
    };
  });
}
