import { withScopedClient, type DbScope } from './db.js';
import { ACTIVE_EMBEDDING_DESCRIPTOR, embed, serializeEmbeddingVector } from './embedding.js';
import { accessLevelSql } from './auth.js';
import {
  hnswEfSearchFromEnv,
  supersededScoreFactorFromEnv,
  supersededSearchDemotionEnabledFromEnv,
} from './config.js';
import type { AccessLevel, SearchParams, SearchResult } from './types.js';
import dotenv from 'dotenv';
dotenv.config();

const EF_SEARCH = hnswEfSearchFromEnv();
const SUPERSEDED_SEARCH_DEMOTION_ENABLED = supersededSearchDemotionEnabledFromEnv();
const SUPERSEDED_SCORE_FACTOR = SUPERSEDED_SEARCH_DEMOTION_ENABLED
  ? supersededScoreFactorFromEnv()
  : 1;

// Legacy vector queries are allowed only for truthfully labelled legacy rows.
// No legacy profile is configured after the verified Gemini-only cutover.
export const LEGACY_EMBEDDING_PROFILES: readonly never[] = Object.freeze([]);

type SearchSchemaCapabilities = {
  belief_schema: boolean;
  supersession_schema: boolean;
  revision_schema: boolean;
  validity_finalized: boolean;
};

export async function hybridSearch(
  params: SearchParams,
  namespaces: string[],
  scope: DbScope,
  maxAccessLevel: AccessLevel
): Promise<SearchResult[]> {
  let vecStr: string | null = null;
  let vectorAvailable = true;
  try {
    const embedding = await embed(params.query);
    vecStr = serializeEmbeddingVector(embedding);
  } catch (error) {
    vectorAvailable = false;
    console.warn('[search] Embedding provider unavailable; using text-only search fallback');
  }
  const limit = Math.min(params.limit ?? 10, 50);
  const threshold = params.threshold ?? 0.3;

  return withScopedClient(scope, async (client) => {
    await client.query("SELECT set_config('hnsw.ef_search', $1, true)", [String(EF_SEARCH)]);

    // Probe catalogs before constructing the query. This supports rolling a new
    // reader onto #52 (or an older schema) without executing and then masking a
    // failed SQL statement in the scoped transaction.
    const capabilityResult = await client.query<SearchSchemaCapabilities>(`
      SELECT
        (SELECT count(*) = 5
         FROM pg_attribute
         WHERE attrelid = 'public.memories'::regclass
           AND attname::text = ANY(ARRAY['memory_kind', 'valid_from', 'valid_to', 'supersedes_id', 'superseded_at']::text[])
           AND NOT attisdropped) AS belief_schema,
        (SELECT count(*) = 2
         FROM pg_attribute
         WHERE attrelid = 'public.memories'::regclass
           AND attname::text = ANY(ARRAY['supersedes_id', 'superseded_at']::text[])
           AND NOT attisdropped) AS supersession_schema,
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = 'public.memories'::regclass
            AND attname = 'revision' AND NOT attisdropped
        ) AS revision_schema,
        EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = 'public.memories'::regclass
            AND a.attname = 'valid_from' AND a.attnotnull AND NOT a.attisdropped
        ) AND EXISTS (
          SELECT 1 FROM pg_constraint c
          WHERE c.conrelid = 'public.memories'::regclass
            AND c.conname = 'memories_validity_interval_check'
            AND c.convalidated
        ) AS validity_finalized
    `);
    const capabilities: SearchSchemaCapabilities = capabilityResult.rows[0] ?? {
      belief_schema: false,
      supersession_schema: false,
      revision_schema: false,
      validity_finalized: false,
    };

    if (params.valid_at && !capabilities.validity_finalized) {
      throw new Error('Invalid valid_at: temporal search is unavailable until memory validity finalization completes');
    }

    const values: unknown[] = [];
    let idx = 0;
    const p = (v: unknown) => { values.push(v); return `$${++idx}`; };

    const pVec = p(vecStr);
    const pNs = p(namespaces);
    const pQuery = p(params.query);
    const pLimit = p(limit);
    const pThreshold = p(threshold);
    const pMaxAccessLevel = p(maxAccessLevel);
    const pProvider = p(ACTIVE_EMBEDDING_DESCRIPTOR.provider);
    const pModel = p(ACTIVE_EMBEDDING_DESCRIPTOR.model);
    const pDimensions = p(ACTIVE_EMBEDDING_DESCRIPTOR.dimensions);
    const pValidAt = p(params.valid_at ?? null);
    const pSupersededFactor = p(SUPERSEDED_SCORE_FACTOR);
    const accessWhere = `AND ${accessLevelSql('m.access_level', pMaxAccessLevel)}`;

    const conditions: string[] = [];
    if (params.tags && params.tags.length > 0) {
      conditions.push(`m.tags @> ${p(params.tags)}`);
    }
    if (params.mediaFilters?.services && params.mediaFilters.services.length > 0) {
      conditions.push(`m.metadata->>'service' = ANY(${p(params.mediaFilters.services)}::text[])`);
    }
    if (params.mediaFilters?.eventTypes && params.mediaFilters.eventTypes.length > 0) {
      conditions.push(`m.metadata->>'event_type' = ANY(${p(params.mediaFilters.eventTypes)}::text[])`);
    }
    if (params.mediaFilters?.eventAfter) {
      conditions.push(`m.event_at >= ${p(params.mediaFilters.eventAfter)}::timestamptz`);
    }
    if (params.mediaFilters?.eventBefore) {
      const operator = params.mediaFilters.eventBeforeExclusive ? '<' : '<=';
      conditions.push(`m.event_at ${operator} ${p(params.mediaFilters.eventBefore)}::timestamptz`);
    }
    if (params.source) conditions.push(`m.source = ${p(params.source)}`);
    if (params.after) conditions.push(`m.created_at >= ${p(params.after)}`);
    if (params.before) conditions.push(`m.created_at <= ${p(params.before)}`);
    if (params.valid_at) {
      conditions.push(`m.valid_from <= ${pValidAt}::timestamptz`);
      conditions.push(`(m.valid_to IS NULL OR ${pValidAt}::timestamptz < m.valid_to)`);
    }
    const extraWhere = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';

    const beliefColumns = capabilities.belief_schema
      ? 'm.memory_kind, m.valid_from, m.valid_to'
      : "'unspecified'::text AS memory_kind, NULL::timestamptz AS valid_from, NULL::timestamptz AS valid_to";
    const supersessionColumns = capabilities.supersession_schema
      ? 'm.supersedes_id, m.superseded_at'
      : 'NULL::uuid AS supersedes_id, NULL::timestamptz AS superseded_at';
    const revisionColumn = capabilities.revision_schema ? 'm.revision' : '0::integer AS revision';
    const selectedColumns = `id, content, metadata, tags, source, namespace, created_at, event_at,
      relevance_score, relevance_base_score, decay_rate, updated_at, accessed_at, access_count,
      access_level, client_id, ${beliefColumns}, ${supersessionColumns}, ${revisionColumn}`;

    const lifecyclePredicates = capabilities.supersession_schema
      ? ['m.superseded_at IS NULL', 'm.superseded_at IS NOT NULL']
      : ['TRUE'];
    const vectorPredicate = vectorAvailable ? `embedding IS NOT NULL
      AND embedding_provider = ${pProvider}
      AND embedding_model = ${pModel}
      AND embedding_dimensions = ${pDimensions}` : 'FALSE';

    const vectorBranches = lifecyclePredicates.map(lifecycle => `
      (SELECT ${selectedColumns},
        1 - (embedding <=> ${pVec}::vector) AS vec_score
       FROM memories m
       WHERE namespace = ANY(${pNs}) ${accessWhere} ${extraWhere}
         AND m.deleted_at IS NULL AND ${lifecycle}
         AND ${vectorPredicate}
       ORDER BY embedding <=> ${pVec}::vector, id
       LIMIT 50)`).join('\nUNION ALL\n');

    const textBranches = lifecyclePredicates.map(lifecycle => `
      (SELECT ${selectedColumns}, NULL::double precision AS vec_score
       FROM memories m
       WHERE namespace = ANY(${pNs}) ${accessWhere} ${extraWhere}
         AND m.deleted_at IS NULL AND ${lifecycle}
         AND to_tsvector('english', content) @@ plainto_tsquery(${pQuery})
         AND NOT EXISTS (SELECT 1 FROM vector_results v WHERE v.id = m.id)
       ORDER BY ts_rank_cd(to_tsvector('english', content), plainto_tsquery(${pQuery})) DESC, id
       LIMIT 20)`).join('\nUNION ALL\n');

    const demotionMultiplier = capabilities.supersession_schema &&
      SUPERSEDED_SEARCH_DEMOTION_ENABLED && !params.valid_at
      ? `CASE WHEN s.superseded_at IS NOT NULL THEN ${pSupersededFactor}::double precision ELSE 1.0 END`
      : '1.0';
    const successorSelect = capabilities.supersession_schema
      ? `(SELECT successor.id FROM memories successor
         WHERE successor.supersedes_id = r.id
           AND successor.namespace = r.namespace
           AND successor.deleted_at IS NULL
           AND ${accessLevelSql('successor.access_level', pMaxAccessLevel)}
         LIMIT 1)`
      : 'NULL::uuid';

    const sql = `
      WITH vector_results AS (
        ${vectorBranches}
      ),
      text_only_results AS (
        ${textBranches}
      ),
      combined AS (
        SELECT * FROM vector_results
        UNION ALL
        SELECT * FROM text_only_results
      ),
      text_scores AS (
        SELECT id,
          ts_rank_cd(to_tsvector('english', content), plainto_tsquery(${pQuery})) AS text_score
        FROM memories m
        WHERE namespace = ANY(${pNs}) ${accessWhere} ${extraWhere}
          AND m.deleted_at IS NULL
          AND to_tsvector('english', content) @@ plainto_tsquery(${pQuery})
      ),
      scored AS MATERIALIZED (
        SELECT c.*,
          COALESCE(t.text_score, 0) AS text_score,
          (COALESCE(c.vec_score, 0) * 0.3 + COALESCE(t.text_score, 0) * 0.7 + CASE WHEN COALESCE(t.text_score, 0) > 0 THEN 0.5 ELSE 0 END) AS base_score,
          calculate_relevance(c.relevance_base_score, c.decay_rate, c.accessed_at, c.access_count) AS relevance
        FROM combined c
        LEFT JOIN text_scores t ON c.id = t.id
        WHERE COALESCE(c.vec_score, 0) >= ${pThreshold} OR t.text_score > 0
      ),
      ranked AS (
        SELECT s.*,
          (COALESCE(s.vec_score, 0) * 0.3 + s.text_score * 0.7 + CASE WHEN s.text_score > 0 THEN 2.0 ELSE 0 END)
            * LEAST(s.relevance, 2.0)
            * ${demotionMultiplier} AS final_score
        FROM scored s
      )
      SELECT r.*,
        (r.superseded_at IS NOT NULL) AS is_superseded,
        ${successorSelect} AS superseded_by_id
      FROM ranked r
      ORDER BY final_score DESC, id
      LIMIT ${pLimit};
    `;

    const res = await client.query(sql, values);

    if (res.rows.length > 0) {
      const ids = res.rows.map((r: any) => r.id);
      await client.query(
        `UPDATE memories SET accessed_at = NOW(), access_count = access_count + 1, last_boosted_at = NOW() WHERE id = ANY($1) AND deleted_at IS NULL`,
        [ids]
      );
    }

    return res.rows as SearchResult[];
  });
}
