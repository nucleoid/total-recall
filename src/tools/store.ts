import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dbScopeFromAuth, queryScoped } from '../db.js';
import { embed, embeddingDescriptorParams, serializeEmbeddingVector } from '../embedding.js';
import type { AuthContext } from '../types.js';
import { checkPermission, ensureAccessLevelAllowed, filterNamespaces } from '../auth.js';
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
  idempotency_key: z.string().min(1).max(512).optional(),
});

export async function memoryStore(
  params: z.infer<typeof storeSchema>,
  auth: AuthContext
): Promise<{ id: string; namespace: string; idempotency_key_honored?: true }> {
  checkPermission(auth, 'write');

  const ns = params.namespace;
  const allowed = filterNamespaces([ns], auth.namespaces);
  if (allowed.length === 0) {
    throw new Error(`Access denied to namespace '${ns}'`);
  }
  ensureAccessLevelAllowed(params.access_level, auth.maxAccessLevel);

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
  const vecStr = serializeEmbeddingVector(embedding);

  const values = [
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
    ...embeddingDescriptorParams(),
  ];

  if (!params.idempotency_key) {
    const res = await queryScoped(
      dbScopeFromAuth(auth),
      `INSERT INTO memories (content, embedding, source, namespace, tags, metadata, access_level, client_id, agent_id, session_id, embedding_provider, embedding_model, embedding_dimensions)
       VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, namespace`,
      values
    );
    return res.rows[0];
  }

  const digest = createHash('sha256')
    .update(auth.keyId)
    .update('\0')
    .update(params.idempotency_key)
    .digest('hex');
  const sourceKey = `discord-safe:v1:${digest}`;
  let res;
  try {
    res = await queryScoped(
      dbScopeFromAuth(auth),
      `INSERT INTO memories (content, embedding, source, namespace, tags, metadata, access_level, client_id, agent_id, session_id, embedding_provider, embedding_model, embedding_dimensions, source_key)
       VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (source_key) DO UPDATE SET
         content = EXCLUDED.content,
         embedding = EXCLUDED.embedding,
         embedding_provider = EXCLUDED.embedding_provider,
         embedding_model = EXCLUDED.embedding_model,
         embedding_dimensions = EXCLUDED.embedding_dimensions,
         source = EXCLUDED.source,
         namespace = EXCLUDED.namespace,
         tags = EXCLUDED.tags,
         metadata = EXCLUDED.metadata,
         access_level = EXCLUDED.access_level,
         client_id = EXCLUDED.client_id,
         agent_id = EXCLUDED.agent_id,
         session_id = EXCLUDED.session_id,
         updated_at = NOW()
       WHERE memories.namespace = ANY($15::text[])
         AND EXCLUDED.namespace = ANY($15::text[])
       RETURNING id, namespace`,
      [...values, sourceKey, auth.namespaces]
    );
  } catch (error) {
    // Under RLS, a hidden source_key conflict can surface as 23505 because the
    // conflicting row is not visible to ON CONFLICT. Do not leak its existence.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new Error('Access denied to existing idempotent memory');
    }
    throw error;
  }
  if (res.rows.length === 0) {
    throw new Error('Access denied to existing idempotent memory');
  }
  return { ...res.rows[0], idempotency_key_honored: true };
}
