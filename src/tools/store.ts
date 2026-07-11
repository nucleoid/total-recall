import { z } from 'zod';
import { dbScopeFromAuth, queryScoped } from '../db.js';
import { embed } from '../embedding.js';
import type { AuthContext } from '../types.js';
import { checkPermission, filterNamespaces } from '../auth.js';
import { resolveAgent } from '../agents.js';

export const storeSchema = z.object({
  content: z.string().min(1).max(100000),
  namespace: z.string().default('shared'),
  source: z.string().optional(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
  access_level: z.enum(['normal', 'sensitive', 'secret']).default('normal'),
  agent_name: z.string().optional(),
  agent_type: z.string().optional(),
  agent_model: z.string().optional(),
  agent_runtime: z.string().optional(),
  session_id: z.string().optional(),
});

export async function memoryStore(
  params: z.infer<typeof storeSchema>,
  auth: AuthContext
): Promise<{ id: string; namespace: string }> {
  checkPermission(auth, 'write');

  const ns = params.namespace;
  const allowed = filterNamespaces([ns], auth.namespaces);
  if (allowed.length === 0) {
    throw new Error(`Access denied to namespace '${ns}'`);
  }

  const explicitAgent = !!params.agent_name;
  const agentName = params.agent_name || auth.name;
  const agentType = params.agent_type || (explicitAgent ? 'llm' : 'system');
  if (!explicitAgent) {
    console.warn(
      `[total-recall] memory_store called without agent_name; defaulting to api_key name "${auth.name}". ` +
      `Pass agent_name explicitly for accurate provenance.`
    );
  }
  const agentId = await resolveAgent(
    agentName,
    agentType,
    params.agent_model,
    params.agent_runtime,
    undefined,
    auth.keyId,
    dbScopeFromAuth(auth)
  );

  const embedding = await embed(params.content);
  const vecStr = `[${embedding.join(',')}]`;

  const res = await queryScoped(
    dbScopeFromAuth(auth),
    `INSERT INTO memories (content, embedding, source, namespace, tags, metadata, access_level, client_id, agent_id, session_id)
     VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, namespace`,
    [
      params.content,
      vecStr,
      params.source || auth.name,
      ns,
      params.tags,
      JSON.stringify(params.metadata),
      params.access_level,
      auth.keyId,
      agentId,
      params.session_id ?? null,
    ]
  );

  return res.rows[0];
}
