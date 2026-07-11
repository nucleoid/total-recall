import { z } from 'zod';
import { query } from '../db.js';
import type { AuthContext } from '../types.js';
import { accessLevelSql, checkPermission } from '../auth.js';

export const listNamespacesSchema = z.object({});

export async function memoryListNamespaces(
  _params: z.infer<typeof listNamespacesSchema>,
  auth: AuthContext
): Promise<{ namespace: string; count: number }[]> {
  checkPermission(auth, 'read');

  const res = await query(
    `SELECT namespace, COUNT(*)::int as count FROM memories
     WHERE namespace = ANY($1) AND ${accessLevelSql('access_level', '$2')}
     GROUP BY namespace`,
    [auth.namespaces, auth.maxAccessLevel]
  );
  return res.rows;
}
