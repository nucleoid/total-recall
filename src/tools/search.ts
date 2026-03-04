import { z } from 'zod';
import { hybridSearch } from '../search.js';
import type { AuthContext } from '../types.js';
import { checkPermission, filterNamespaces } from '../auth.js';

export const searchSchema = z.object({
  query: z.string().min(1),
  namespaces: z.array(z.string()).optional(),
  limit: z.number().min(1).max(50).default(10),
  threshold: z.number().min(0).max(1).default(0.3),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
});

export async function memorySearch(
  params: z.infer<typeof searchSchema>,
  auth: AuthContext
) {
  checkPermission(auth, 'read');
  const namespaces = filterNamespaces(params.namespaces, auth.namespaces);
  if (namespaces.length === 0) {
    return [];
  }
  return hybridSearch(params, namespaces);
}
