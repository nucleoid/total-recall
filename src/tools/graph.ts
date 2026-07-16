import { z } from 'zod';
import { checkPermission, filterNamespaces } from '../auth.js';
import { dbScopeFromAuth } from '../db.js';
import { ENTITY_TYPES } from '../entity-extractor.js';
import { GRAPH_MAX_DEPTH, traverseMemoryGraph, type MemoryGraphResult } from '../entities.js';
import type { AuthContext } from '../types.js';
import { TEXT_FIELD_MAX_CHARS } from '../http-limits.js';

export const graphSchema = z.object({
  entity: z.string().trim().min(1).max(256),
  type: z.enum(ENTITY_TYPES).optional(),
  namespaces: z.array(z.string().trim().min(1).max(TEXT_FIELD_MAX_CHARS)).max(100).optional(),
  depth: z.number().int().min(0).max(GRAPH_MAX_DEPTH).default(1),
}).strict();

export async function memoryGraph(
  params: z.infer<typeof graphSchema>,
  auth: AuthContext,
): Promise<MemoryGraphResult> {
  checkPermission(auth, 'read');
  const namespaces = filterNamespaces(params.namespaces, auth.namespaces);
  return traverseMemoryGraph(dbScopeFromAuth(auth), {
    entity: params.entity,
    type: params.type,
    namespaces,
    depth: params.depth,
    maxAccessLevel: auth.maxAccessLevel,
  });
}
