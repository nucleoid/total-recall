import { getPool, type ScopedClient } from './db.js';
import type { AccessLevel } from './types.js';
import { getLocalServingClient, localServingEnabled } from './local-embedding-runtime.js';
import { planEmbeddingChunks, type ParentChunkPlan } from './embedding-chunks.js';
import { QWEN_CONTRACT_ID, sha256, validateLocalStoredVector } from './local-embedding-contract.js';

export interface PreparedLocalDocument { plan: ParentChunkPlan; vectors: number[][] }
export interface PreparedLocalQuery { sourceSha256: string; tokens: number; vector: number[] }

export async function assertLocalServingSelection(): Promise<void> {
  const row = (await getPool().query('SELECT contract_id FROM embedding_serving_settings WHERE singleton=true')).rows[0];
  if (row?.contract_id !== QWEN_CONTRACT_ID) throw new Error('shadow_embedding.serving_contract_mismatch');
}

/** All inference happens before the caller acquires parent/advisory locks. */
export async function prepareLocalDocument(text: string, signal?: AbortSignal): Promise<PreparedLocalDocument | undefined> {
  if (!localServingEnabled()) return undefined;
  await assertLocalServingSelection();
  const client = getLocalServingClient();
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  const plan = await planEmbeddingChunks(text, value => client.countFormattedTokens(value, bounded));
  if (plan.chunks.length > 4096) throw new Error('shadow_embedding.parent_chunk_limit');
  const vectors: number[][] = [];
  for (let i = 0; i < plan.chunks.length; i += 4) {
    const result = await client.embed(plan.chunks.slice(i, i + 4).map(c => c.text), 'document', bounded);
    if (result.tokens.some((n, j) => n !== plan.chunks[i + j].tokens)) throw new Error('shadow_embedding.unstable_tokenizer');
    vectors.push(...result.vectors);
  }
  return { plan, vectors };
}

export async function prepareLocalQuery(text: string, signal?: AbortSignal): Promise<PreparedLocalQuery | undefined> {
  if (!localServingEnabled()) return undefined;
  await assertLocalServingSelection();
  const result = await getLocalServingClient().embed([text], 'query', signal);
  return { sourceSha256: sha256(text), tokens: result.tokens[0], vector: result.vectors[0] };
}

export async function publishPreparedLocalDocument(client: ScopedClient, parentId: string, prepared?: PreparedLocalDocument): Promise<void> {
  if (!prepared) return;
  const chunks = prepared.plan.chunks.map((c, i) => {
    validateLocalStoredVector(prepared.vectors[i]);
    return { ordinal: c.ordinal, core_start: c.coreStart, core_end: c.coreEnd, sha256: c.sha256, tokens: c.tokens,
      vector: `[${prepared.vectors[i].join(',')}]` };
  });
  const result = await client.query('SELECT public.publish_local_memory_embedding($1::uuid,$2,$3,$4::jsonb) AS published',
    [parentId, QWEN_CONTRACT_ID, prepared.plan.sourceSha256, JSON.stringify(chunks)]);
  if (result.rows[0]?.published !== true) throw new Error('shadow_embedding.publish_source_changed');
}

export async function publishPreparedLocalQuery(client: ScopedClient, subscriptionId: string, prepared?: PreparedLocalQuery): Promise<void> {
  if (!prepared) return;
  validateLocalStoredVector(prepared.vector);
  const result = await client.query('SELECT public.publish_local_subscription_embedding($1::uuid,$2,$3,$4::integer,$5) AS published',
    [subscriptionId, QWEN_CONTRACT_ID, prepared.sourceSha256, prepared.tokens, `[${prepared.vector.join(',')}]`]);
  if (result.rows[0]?.published !== true) throw new Error('shadow_embedding.publish_source_changed');
}

/** Exact bounded target-space dedupe; an incomplete scope must never silently create duplicates. */
export async function findLocalDocumentDuplicate(client: ScopedClient, prepared: PreparedLocalDocument,
  namespace: string, accessLevel: AccessLevel): Promise<{ id: string; namespace: string; similarity: number } | undefined> {
  // This exact cross-chunk comparison must stay bounded while the caller holds
  // the semantic identity lock. Transaction-local configuration expires at commit.
  await client.query("SELECT set_config('statement_timeout','5000',true)");
  const eligibility = `m.namespace=$1 AND COALESCE(m.access_level,'normal')=$2
    AND m.source_key IS NULL AND m.document_id IS NULL AND m.deleted_at IS NULL AND m.expires_at IS NULL
    AND m.superseded_at IS NULL AND m.valid_to IS NULL AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp())
    AND m.consolidated_into_id IS NULL AND m.memory_kind NOT IN ('document_chunk','episode_chunk')`;
  const bounds = (await client.query(`SELECT count(*)::integer AS parents,
    count(*) FILTER (WHERE f.parent_id IS NULL OR NOT f.is_current OR f.source_revision<>m.revision
      OR f.source_sha256<>encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex')
      OR f.source_bytes<>octet_length(convert_to(m.content,'UTF8'))
      OR f.chunk_count<>(SELECT count(*) FROM memory_embedding_chunks c
        WHERE c.parent_id=m.id AND c.contract_id=$3)
      OR NOT COALESCE((SELECT min(c.ordinal)=0 AND max(c.ordinal)=f.chunk_count-1
        FROM memory_embedding_chunks c WHERE c.parent_id=m.id AND c.contract_id=$3),false))::integer AS missing
    FROM (SELECT * FROM memories m WHERE ${eligibility} LIMIT 10001) m
    LEFT JOIN memory_embedding_manifests f ON f.parent_id=m.id AND f.contract_id=$3`,
  [namespace, accessLevel, QWEN_CONTRACT_ID])).rows[0];
  if (bounds.parents > 10_000) throw new Error('shadow_embedding.dedupe_scope_limit');
  if (bounds.missing > 0) throw new Error('shadow_embedding.dedupe_scope_incomplete');
  if (!bounds.parents) return undefined;
  const vectors = prepared.vectors.map(vector => { validateLocalStoredVector(vector); return `[${vector.join(',')}]`; });
  const candidate = (await client.query(`SELECT m.id,m.namespace,m.revision,
    max(1-(c.embedding<=>q.vector))::double precision AS similarity
    FROM memories m JOIN memory_embedding_manifests f ON f.parent_id=m.id AND f.contract_id=$3
      AND f.is_current AND f.source_revision=m.revision
      AND f.source_sha256=encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex')
      AND f.source_bytes=octet_length(convert_to(m.content,'UTF8'))
      AND f.chunk_count=(SELECT count(*) FROM memory_embedding_chunks valid_chunk
        WHERE valid_chunk.parent_id=m.id AND valid_chunk.contract_id=$3)
      AND COALESCE((SELECT min(valid_chunk.ordinal)=0 AND max(valid_chunk.ordinal)=f.chunk_count-1
        FROM memory_embedding_chunks valid_chunk WHERE valid_chunk.parent_id=m.id AND valid_chunk.contract_id=$3),false)
    JOIN memory_embedding_chunks c ON c.parent_id=m.id AND c.contract_id=f.contract_id
    CROSS JOIN unnest($4::vector[]) q(vector)
    WHERE ${eligibility} GROUP BY m.id,m.namespace
    ORDER BY similarity DESC,calculate_relevance(m.relevance_base_score,m.decay_rate,m.accessed_at,m.access_count) DESC,
      m.created_at,m.id LIMIT 1`, [namespace, accessLevel, QWEN_CONTRACT_ID, vectors])).rows[0];
  if (!candidate) return undefined;
  const locked = await client.query(`SELECT m.id,m.revision FROM memories m
    JOIN memory_embedding_manifests f ON f.parent_id=m.id AND f.contract_id=$3 AND f.is_current AND f.source_revision=m.revision
      AND f.source_sha256=encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex')
      AND f.source_bytes=octet_length(convert_to(m.content,'UTF8'))
      AND f.chunk_count=(SELECT count(*) FROM memory_embedding_chunks valid_chunk
        WHERE valid_chunk.parent_id=m.id AND valid_chunk.contract_id=$3)
      AND COALESCE((SELECT min(valid_chunk.ordinal)=0 AND max(valid_chunk.ordinal)=f.chunk_count-1
        FROM memory_embedding_chunks valid_chunk WHERE valid_chunk.parent_id=m.id AND valid_chunk.contract_id=$3),false)
    WHERE ${eligibility} AND m.id=$4::uuid FOR UPDATE OF m`, [namespace, accessLevel, QWEN_CONTRACT_ID, candidate.id]);
  if (locked.rows[0]?.revision !== candidate.revision) throw new Error('shadow_embedding.dedupe_candidate_changed');
  return { id: candidate.id, namespace: candidate.namespace, similarity: Number(candidate.similarity) };
}

/** Mutation consumers must not reason over a partial target-space candidate set. */
export async function assertLocalContradictionScopeComplete(
  client: ScopedClient, namespace: string, maxAccessLevel: AccessLevel,
): Promise<void> {
  const eligibility = `m.namespace=$1 AND ${accessLevelSqlForConsumer('m.access_level','$2')}
    AND m.access_level='normal' AND m.memory_kind='semantic' AND m.deleted_at IS NULL
    AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) AND m.superseded_at IS NULL
    AND m.valid_to IS NULL AND m.valid_from<=statement_timestamp() AND m.consolidated_into_id IS NULL`;
  const coverage = (await client.query(`SELECT count(*)::integer AS parents,
    count(*) FILTER (WHERE f.parent_id IS NULL OR NOT f.is_current OR f.source_revision<>m.revision
      OR f.source_sha256<>encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex')
      OR f.source_bytes<>octet_length(convert_to(m.content,'UTF8'))
      OR f.chunk_count<>(SELECT count(*) FROM memory_embedding_chunks c WHERE c.contract_id=$3 AND c.parent_id=m.id)
      OR NOT COALESCE((SELECT min(c.ordinal)=0 AND max(c.ordinal)=f.chunk_count-1
        FROM memory_embedding_chunks c WHERE c.contract_id=$3 AND c.parent_id=m.id),false))::integer AS missing
    FROM (SELECT * FROM memories m WHERE ${eligibility} LIMIT 10001) m
    LEFT JOIN memory_embedding_manifests f ON f.contract_id=$3 AND f.parent_id=m.id`,
  [namespace,maxAccessLevel,QWEN_CONTRACT_ID])).rows[0];
  if (coverage.parents>10_000) throw new Error('shadow_embedding.contradiction_scope_limit');
  if (coverage.missing>0) throw new Error('shadow_embedding.contradiction_scope_incomplete');
}

function accessLevelSqlForConsumer(column: string, parameter: string): string {
  return `CASE COALESCE(${column},'normal') WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 3 END
    <= CASE ${parameter} WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END`;
}
