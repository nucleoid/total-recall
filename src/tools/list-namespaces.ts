import { z } from 'zod';
import { dbScopeFromAuth, queryScoped } from '../db.js';
import type { AuthContext } from '../types.js';
import { accessLevelSql, checkPermission } from '../auth.js';

export const listNamespacesSchema = z.object({});

export async function memoryListNamespaces(
  _params: z.infer<typeof listNamespacesSchema>,
  auth: AuthContext
): Promise<{ namespace: string; count: number }[]> {
  checkPermission(auth, 'read');

  const res = await queryScoped(
    dbScopeFromAuth(auth),
    `SELECT namespace, COUNT(*)::int as count FROM memories
     WHERE deleted_at IS NULL
       AND (expires_at IS NULL OR expires_at > statement_timestamp())
       AND to_jsonb(memories)->>'consolidated_into_id' IS NULL AND namespace = ANY($1) AND ${accessLevelSql('access_level', '$2')}
     GROUP BY namespace`,
    [auth.namespaces, auth.maxAccessLevel]
  );
  return res.rows;
}
