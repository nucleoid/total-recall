import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dbScopeFromAuth, queryScoped, withScopedClient } from '../db.js';
import { embed, embeddingDescriptorParams, serializeEmbeddingVector } from '../embedding.js';
import type { AuthContext } from '../types.js';
import { checkPermission, ensureAccessLevelAllowed, filterNamespaces } from '../auth.js';
import { resolveAgent } from '../agents.js';
import { TombstonedSourceKeyConflictError } from '../errors.js';
import { maybeReviseBelief } from '../contradictions.js';
import {
  MEMORY_CONTENT_MAX_CHARS,
  TAG_MAX_CHARS,
  TAG_MAX_COUNT,
  TEXT_FIELD_MAX_CHARS,
  metadataSchema,
} from '../http-limits.js';

export const storeSchema = z.object({
  content: z.string().min(1).max(MEMORY_CONTENT_MAX_CHARS),
  namespace: z.string().min(1).max(TEXT_FIELD_MAX_CHARS).default('shared'),
  source: z.string().max(TEXT_FIELD_MAX_CHARS).optional(),
  tags: z.array(z.string().max(TAG_MAX_CHARS)).max(TAG_MAX_COUNT).default([]),
  metadata: metadataSchema.default({}),
  access_level: z.enum(['normal', 'sensitive', 'secret']).default('normal'),
  agent_name: z.string().max(TEXT_FIELD_MAX_CHARS).optional(),
  agent_type: z.string().max(TEXT_FIELD_MAX_CHARS).optional(),
  agent_model: z.string().max(TEXT_FIELD_MAX_CHARS).optional(),
  agent_runtime: z.string().max(TEXT_FIELD_MAX_CHARS).optional(),
  session_id: z.string().max(TEXT_FIELD_MAX_CHARS).optional(),
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

  const source = params.source || auth.name;
  const values = [
    params.content,
    vecStr,
    source,
    ns,
    params.tags,
    JSON.stringify(params.metadata),
    params.access_level,
    auth.keyId,
    agentId,
    params.session_id ?? null,
    ...embeddingDescriptorParams(),
  ];

  const revised = await maybeReviseBelief({
    content: params.content,
    vector: vecStr,
    source,
    namespace: ns,
    tags: params.tags,
    metadata: params.metadata,
    accessLevel: params.access_level,
    clientId: auth.keyId,
    agentId,
    sessionId: params.session_id ?? null,
  }, auth, { allowMutation: !params.idempotency_key });
  if (revised) return revised;

  if (!params.idempotency_key) {
    try {
      const res = await queryScoped(
        dbScopeFromAuth(auth),
        `INSERT INTO memories (content, embedding, source, namespace, tags, metadata, access_level, client_id, agent_id, session_id, embedding_provider, embedding_model, embedding_dimensions, memory_kind, valid_from)
         VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'semantic', statement_timestamp())
         RETURNING id, namespace`,
        values
      );
      return res.rows[0];
    } catch (error) {
      // Preserve the repository's migration-by-migration integration harness.
      // Production rollout still requires migration 025 before this writer.
      if (!isMissingBeliefSchema(error)) throw error;
      const legacy = await queryScoped(
        dbScopeFromAuth(auth),
        `INSERT INTO memories (content, embedding, source, namespace, tags, metadata, access_level, client_id, agent_id, session_id, embedding_provider, embedding_model, embedding_dimensions)
         VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id, namespace`,
        values,
      );
      return legacy.rows[0];
    }
  }

  const digest = createHash('sha256')
    .update(auth.keyId)
    .update('\0')
    .update(params.idempotency_key)
    .digest('hex');
  const sourceKey = `discord-safe:v1:${digest}`;
  const executeKeyedStore = (beliefAware: boolean) => withScopedClient(dbScopeFromAuth(auth), async (client) => {
      const columns = beliefAware ? ', memory_kind, valid_from' : '';
      const insertedValues = beliefAware ? ", 'semantic', statement_timestamp()" : '';
      const kindUpdate = beliefAware ? '\n           memory_kind = EXCLUDED.memory_kind,' : '';
      const currentGuard = beliefAware ? '\n           AND memories.superseded_at IS NULL' : '';
      const upsert = await client.query(
        `INSERT INTO memories (content, embedding, source, namespace, tags, metadata, access_level, client_id, agent_id, session_id, embedding_provider, embedding_model, embedding_dimensions, source_key${columns})
         VALUES ($1, $2::vector, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14${insertedValues})
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
           session_id = EXCLUDED.session_id,${kindUpdate}
           updated_at = NOW()
         WHERE memories.deleted_at IS NULL${currentGuard}
           AND memories.namespace = ANY($15::text[])
           AND EXCLUDED.namespace = ANY($15::text[])
         RETURNING id, namespace`,
        [...values, sourceKey, auth.namespaces]
      );
      if (upsert.rows.length > 0) return upsert;

      // A tombstone remains SELECT-visible under the caller's RLS scope. Resolve
      // the zero-row conflict before leaving this transaction/client so a hidden
      // row stays indistinguishable from any other inaccessible conflict.
      const tombstone = await client.query(
        `SELECT 1
         FROM memories
         WHERE source_key = $1
           AND deleted_at IS NOT NULL
         LIMIT 1`,
        [sourceKey]
      );
      if (tombstone.rows.length > 0) {
        throw new TombstonedSourceKeyConflictError();
      }
      throw new Error('Access denied to existing idempotent memory');
    });

  let res;
  try {
    try {
      res = await executeKeyedStore(true);
    } catch (error) {
      if (!isMissingBeliefSchema(error)) throw error;
      res = await executeKeyedStore(false);
    }
  } catch (error) {
    // Under RLS, a hidden source_key conflict can surface as 23505 because the
    // conflicting row is not visible to ON CONFLICT. Do not leak its existence.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new Error('Access denied to existing idempotent memory');
    }
    throw error;
  }
  return { ...res.rows[0], idempotency_key_honored: true };
}

function isMissingBeliefSchema(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === '42703' &&
    'message' in error && typeof error.message === 'string' && error.message.includes('memory_kind');
}
