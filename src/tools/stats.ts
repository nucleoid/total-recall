import { z } from 'zod';
import { dbScopeFromAuth, withScopedClient } from '../db.js';
import type { AuthContext } from '../types.js';
import { checkPermission } from '../auth.js';
import { logAudit } from '../audit.js';

export const statsSchema = z.object({});

const STATS_QUERY_STATEMENT_TIMEOUT_MS = 10_000;

function visibleAccessLevels(maxAccessLevel: AuthContext['maxAccessLevel']): string[] {
  switch (maxAccessLevel) {
    case 'normal': return ['normal'];
    case 'sensitive': return ['normal', 'sensitive'];
    case 'secret': return ['normal', 'sensitive', 'secret'];
  }
}

export async function memoryStats(
  _params: z.infer<typeof statsSchema>,
  auth: AuthContext
) {
  checkPermission(auth, 'admin');
  checkPermission(auth, 'read');

  const ns = auth.namespaces;
  const scope = dbScopeFromAuth(auth);
  const values = [ns, visibleAccessLevels(auth.maxAccessLevel)];

  return withScopedClient(scope, async (client) => {
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      String(STATS_QUERY_STATEMENT_TIMEOUT_MS),
    ]);
    // PostgreSQL heavily overprices the RLS-aware index-only path on the large,
    // vector-backed memories heap. Keep this transaction on the purpose-built
    // covering index; without it the statement timeout fails closed.
    await client.query("SELECT set_config('enable_seqscan', 'off', true)");
    await client.query("SELECT set_config('enable_bitmapscan', 'off', true)");
    const consolidationCapability = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_attribute
         WHERE attrelid = 'memories'::regclass
           AND attname = 'consolidated_into_id'
           AND NOT attisdropped
       ) AS present`
    );
    const consolidationWhere = consolidationCapability.rows[0]?.present
      ? 'consolidated_into_id IS NULL'
      : "to_jsonb(memories)->>'consolidated_into_id' IS NULL";
    const accessWhere = `deleted_at IS NULL
      AND (expires_at IS NULL OR expires_at > statement_timestamp())
      AND ${consolidationWhere}
      AND (access_level IS NULL OR access_level = ANY($2::text[]))`;
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
