import { z } from 'zod';
import { query } from '../db.js';
import type { AuthContext } from '../types.js';
import { checkPermission } from '../auth.js';

const ALL_NAMESPACES = ['personal', 'work', 'projects', 'financial', 'shared'];

export const statsSchema = z.object({});

export async function memoryStats(
  _params: z.infer<typeof statsSchema>,
  auth: AuthContext
) {
  checkPermission(auth, 'read');

  const hasAll = ALL_NAMESPACES.every((ns) => auth.namespaces.includes(ns));
  if (!hasAll) {
    throw new Error('memory_stats is admin-only');
  }

  const ns = auth.namespaces;

  const [totalRes, byNsRes, bySrcRes, docsRes, oldestRes, newestRes] = await Promise.all([
    query('SELECT COUNT(*) as total FROM memories WHERE namespace = ANY($1)', [ns]),
    query(
      'SELECT namespace, COUNT(*) as count FROM memories WHERE namespace = ANY($1) GROUP BY namespace ORDER BY count DESC',
      [ns]
    ),
    query(
      'SELECT source, COUNT(*) as count FROM memories WHERE namespace = ANY($1) GROUP BY source ORDER BY count DESC',
      [ns]
    ),
    query(
      'SELECT COUNT(DISTINCT document_id) as total FROM memories WHERE namespace = ANY($1) AND document_id IS NOT NULL',
      [ns]
    ),
    query(
      'SELECT MIN(created_at) as oldest FROM memories WHERE namespace = ANY($1)',
      [ns]
    ),
    query(
      'SELECT MAX(created_at) as newest FROM memories WHERE namespace = ANY($1)',
      [ns]
    ),
  ]);

  return {
    total_memories: parseInt(totalRes.rows[0].total, 10),
    by_namespace: byNsRes.rows.map((r: any) => ({ namespace: r.namespace, count: parseInt(r.count, 10) })),
    by_source: bySrcRes.rows.map((r: any) => ({ source: r.source, count: parseInt(r.count, 10) })),
    total_documents: parseInt(docsRes.rows[0].total, 10),
    oldest_memory: oldestRes.rows[0].oldest,
    newest_memory: newestRes.rows[0].newest,
  };
}
