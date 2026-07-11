import { z } from 'zod';
import { dbScopeFromAuth, queryScoped } from '../db.js';
import type { AuthContext } from '../types.js';
import { checkPermission } from '../auth.js';

export const listNamespacesSchema = z.object({});

export async function memoryListNamespaces(
  _params: z.infer<typeof listNamespacesSchema>,
  auth: AuthContext
): Promise<{ namespace: string; count: number }[]> {
  checkPermission(auth, 'read');

  const res = await queryScoped(
    dbScopeFromAuth(auth),
    `SELECT namespace, COUNT(*)::int as count FROM memories WHERE namespace = ANY($1) GROUP BY namespace`,
    [auth.namespaces]
  );
  return res.rows;
}
