import { getPoolGeneration, withScopedClient, type DbScope, type ScopedClient } from './db.js';
import {
  ACTIVE_EMBEDDING_PROFILE,
  EMBEDDING_PROFILES,
  embedWithProfile,
  embeddingIdentity,
  serializeEmbeddingVector,
  type EmbeddingProfile,
} from './embedding.js';
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
const SEARCH_SCHEMA_CAPABILITY_TTL_MS = boundedSchemaTtl(process.env.SEARCH_SCHEMA_CAPABILITY_TTL_MS);

// A truthfully labelled legacy row is required: providers are queried only after an eligible row
// has been proven inside the caller's scoped transaction.
export const LEGACY_EMBEDDING_PROFILES = Object.freeze(
  EMBEDDING_PROFILES.filter(profile => profile.name !== ACTIVE_EMBEDDING_PROFILE.name),
);

type SearchSchemaCapabilities = {
  belief_schema: boolean;
  supersession_schema: boolean;
  revision_schema: boolean;
  validity_finalized: boolean;
  consolidation_schema: boolean;
};

type CapabilityCache = {
  generation: number;
  expiresAt: number;
  capabilities: SearchSchemaCapabilities;
};

let capabilityCache: CapabilityCache | null = null;

/** Explicit hook for an in-process migration/finalizer or operational test. */
export function invalidateSearchSchemaCapabilities(): void {
  capabilityCache = null;
}

async function searchSchemaCapabilities(
  client: ScopedClient,
  forceRefresh: boolean,
): Promise<SearchSchemaCapabilities> {
  const generation = getPoolGeneration();
  if (!forceRefresh && capabilityCache?.generation === generation && capabilityCache.expiresAt > Date.now()) {
    return capabilityCache.capabilities;
  }

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
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.memories'::regclass
          AND attname = 'consolidated_into_id' AND NOT attisdropped
      ) AND to_regclass('public.memory_consolidation_memberships') IS NOT NULL AS consolidation_schema,
      (SELECT count(*) = 5
       FROM pg_attribute
       WHERE attrelid = 'public.memories'::regclass
         AND attname::text = ANY(ARRAY['memory_kind', 'valid_from', 'valid_to', 'supersedes_id', 'superseded_at']::text[])
         AND NOT attisdropped)
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = 'public.memories'::regclass
          AND a.attname = 'valid_from' AND a.attnotnull AND NOT a.attisdropped
      ) AND (
        SELECT count(*) = 3 FROM pg_constraint c
        WHERE c.conrelid = 'public.memories'::regclass
          AND c.conname::text = ANY(ARRAY[
            'memories_valid_from_present',
            'memories_validity_interval_check',
            'memories_validity_supersession_check'
          ]::text[])
          AND c.convalidated
      ) AS validity_finalized
  `);
  const probed = capabilityResult.rows[0] as SearchSchemaCapabilities | undefined;
  // Older test doubles and rolling callers may not yet return the additive
  // field. A fully finalized legacy capability tuple is treated as link-aware
  // only for that compatibility shape; real PostgreSQL always returns the
  // explicit catalog-derived boolean above.
  const capabilities = probed && typeof probed.consolidation_schema !== 'boolean'
    ? { ...probed, consolidation_schema: probed.belief_schema === true && probed.supersession_schema === true &&
        probed.revision_schema === true && probed.validity_finalized === true }
    : probed;
  if (!capabilities || !isCapabilities(capabilities)) {
    throw new Error('Search schema capability probe returned an invalid result');
  }

  // Cache only the fully finalized monotonic rollout state. Negative/partial
  // states are re-probed so a migration cannot leave a reader treating newly
  // superseded rows as current. Pool generation and TTL bound positive staleness.
  if (capabilities.belief_schema && capabilities.supersession_schema &&
      capabilities.revision_schema && capabilities.validity_finalized && capabilities.consolidation_schema) {
    capabilityCache = {
      generation,
      expiresAt: Date.now() + SEARCH_SCHEMA_CAPABILITY_TTL_MS,
      capabilities,
    };
  } else {
    capabilityCache = null;
  }
  return capabilities;
}

function isCapabilities(value: SearchSchemaCapabilities): boolean {
  return typeof value.belief_schema === 'boolean' &&
    typeof value.supersession_schema === 'boolean' &&
    typeof value.revision_schema === 'boolean' &&
    typeof value.validity_finalized === 'boolean' &&
    typeof value.consolidation_schema === 'boolean';
}

function boundedSchemaTtl(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return 30_000;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 300_000 ? value : 30_000;
}

async function hasEligibleRowsForProfile(
  client: ScopedClient,
  profile: EmbeddingProfile,
  params: SearchParams,
  namespaces: string[],
  maxAccessLevel: AccessLevel,
  capabilities: SearchSchemaCapabilities,
): Promise<boolean> {
  const values: unknown[] = [namespaces, maxAccessLevel, profile.provider, profile.model, profile.dimensions];
  const p = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const conditions = [
    'm.namespace = ANY($1)',
    accessLevelSql('m.access_level', '$2'),
    'm.embedding IS NOT NULL',
    'm.embedding_provider = $3',
    'm.embedding_model = $4',
    'm.embedding_dimensions = $5',
    'm.deleted_at IS NULL',
    '(m.expires_at IS NULL OR m.expires_at > statement_timestamp())',
  ];
  if (capabilities.consolidation_schema && !params.valid_at) conditions.push('m.consolidated_into_id IS NULL');
  if (params.tags?.length) conditions.push(`m.tags @> ${p(params.tags)}`);
  if (params.source) conditions.push(`m.source = ${p(params.source)}`);
  if (params.after) conditions.push(`m.created_at >= ${p(params.after)}::timestamptz`);
  if (params.before) conditions.push(`m.created_at <= ${p(params.before)}::timestamptz`);
  if (params.valid_at) {
    const validAt = p(params.valid_at);
    conditions.push(`m.valid_from <= ${validAt}::timestamptz`);
    conditions.push(`(m.valid_to IS NULL OR ${validAt}::timestamptz < m.valid_to)`);
    if (capabilities.consolidation_schema) conditions.push(`NOT EXISTS (
      SELECT 1 FROM memory_consolidation_memberships cm
      WHERE cm.member_id = m.id
        AND cm.consolidated_at <= ${validAt}::timestamptz
        AND (cm.deconsolidated_at IS NULL OR ${validAt}::timestamptz < cm.deconsolidated_at)
    )`);
  }
  if (params.mediaFilters?.services?.length) conditions.push(`m.metadata->>'service' = ANY(${p(params.mediaFilters.services)}::text[])`);
  if (params.mediaFilters?.eventTypes?.length) conditions.push(`m.metadata->>'event_type' = ANY(${p(params.mediaFilters.eventTypes)}::text[])`);
  if (params.mediaFilters?.eventAfter) conditions.push(`m.event_at >= ${p(params.mediaFilters.eventAfter)}::timestamptz`);
  if (params.mediaFilters?.eventBefore) {
    conditions.push(`m.event_at ${params.mediaFilters.eventBeforeExclusive ? '<' : '<='} ${p(params.mediaFilters.eventBefore)}::timestamptz`);
  }
  const result = await client.query<{ eligible: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM memories m WHERE ${conditions.join(' AND ')} LIMIT 1) AS eligible`,
    values,
  );
  return result.rows[0]?.eligible === true;
}

export async function hybridSearch(
  params: SearchParams,
  namespaces: string[],
  scope: DbScope,
  maxAccessLevel: AccessLevel
): Promise<SearchResult[]> {
  // queryVectors supersedes the old single vectorAvailable flag.
  const queryVectors: Array<{ profile: EmbeddingProfile; vector: string }> = [];
  try {
    const result = await embedWithProfile(params.query, ACTIVE_EMBEDDING_PROFILE);
    queryVectors.push({ profile: ACTIVE_EMBEDDING_PROFILE, vector: serializeEmbeddingVector(result.vector) });
  } catch (error) {
    console.warn('[search] Current embedding profile unavailable; using text-only search fallback');
  }
  const limit = Math.min(params.limit ?? 10, 50);
  const threshold = params.threshold ?? 0.3;

  return withScopedClient(scope, async (client) => {
    await client.query("SELECT set_config('hnsw.ef_search', $1, true)", [String(EF_SEARCH)]);

    // Ordinary finalized searches reuse a short-lived process/pool-generation
    // cache. valid_at always refreshes the finalization proof and fails closed.
    const capabilities = await searchSchemaCapabilities(client, params.valid_at !== undefined);

    if (params.valid_at && !capabilities.validity_finalized) {
      throw new Error('Invalid valid_at: temporal search is unavailable until memory validity finalization completes');
    }

    // Canonicalize aliases that describe the same space. A legacy provider is
    // never called merely because credentials exist: at least one fully labelled,
    // filtered, visible row must be present.
    const queriedIdentities = new Set([embeddingIdentity(ACTIVE_EMBEDDING_PROFILE)]);
    for (const profile of LEGACY_EMBEDDING_PROFILES) {
      const identity = embeddingIdentity(profile);
      if (queriedIdentities.has(identity)) continue;
      if (!await hasEligibleRowsForProfile(client, profile, params, namespaces, maxAccessLevel, capabilities)) continue;
      queriedIdentities.add(identity);
      try {
        const result = await embedWithProfile(params.query, profile);
        queryVectors.push({ profile, vector: serializeEmbeddingVector(result.vector) });
      } catch (error) {
        console.warn(`[search] Legacy embedding profile ${profile.name} (${profile.provider}/${profile.model}/${profile.dimensions}) unavailable; continuing without that vector space`);
      }
    }

    const values: unknown[] = [];
    let idx = 0;
    const p = (v: unknown) => { values.push(v); return `$${++idx}`; };

    const pNs = p(namespaces);
    const pQuery = p(params.query);
    const pLimit = p(limit);
    const pThreshold = p(threshold);
    const pMaxAccessLevel = p(maxAccessLevel);
    const pValidAt = params.valid_at ? p(params.valid_at) : null;
    const shouldDemoteSuperseded = capabilities.supersession_schema &&
      SUPERSEDED_SEARCH_DEMOTION_ENABLED && !params.valid_at;
    const pSupersededFactor = shouldDemoteSuperseded ? p(SUPERSEDED_SCORE_FACTOR) : null;
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
    const consolidationVisibility = capabilities.consolidation_schema
      ? (params.valid_at
        ? `AND NOT EXISTS (
             SELECT 1 FROM memory_consolidation_memberships cm
             WHERE cm.member_id = m.id
               AND cm.consolidated_at <= ${pValidAt}::timestamptz
               AND (cm.deconsolidated_at IS NULL OR ${pValidAt}::timestamptz < cm.deconsolidated_at)
           )`
        : 'AND m.consolidated_into_id IS NULL')
      : '';

    const beliefColumns = capabilities.belief_schema
      ? 'm.memory_kind, m.valid_from, m.valid_to'
      : "'unspecified'::text AS memory_kind, NULL::timestamptz AS valid_from, NULL::timestamptz AS valid_to";
    const supersessionColumns = capabilities.supersession_schema
      ? 'm.supersedes_id AS linked_supersedes_id, m.superseded_at'
      : 'NULL::uuid AS linked_supersedes_id, NULL::timestamptz AS superseded_at';
    const revisionColumn = capabilities.revision_schema ? 'm.revision' : '0::integer AS revision';
    const selectedColumns = `id, content, metadata, tags, source, namespace, created_at, event_at, expires_at,
      relevance_score, relevance_base_score, decay_rate, updated_at, accessed_at, access_count,
      access_level, client_id, agent_id, embedding_provider, embedding_model, embedding_dimensions,
      ${beliefColumns}, ${supersessionColumns}, ${revisionColumn}`;

    const lifecyclePredicates = capabilities.supersession_schema
      ? ['m.superseded_at IS NULL', 'm.superseded_at IS NOT NULL']
      : ['TRUE'];
    const vectorBranches = queryVectors.flatMap(({ profile, vector }) => {
      const pVec = p(vector);
      const pProvider = p(profile.provider);
      const pModel = p(profile.model);
      const pDimensions = p(profile.dimensions);
      const vectorPredicate = `embedding IS NOT NULL
        AND embedding_provider = ${pProvider}
        AND embedding_model = ${pModel}
        AND embedding_dimensions = ${pDimensions}`;
      return lifecyclePredicates.map(lifecycle => `
        (SELECT ${selectedColumns},
          1 - (embedding <=> ${pVec}::vector) AS vec_score
         FROM memories m
         WHERE namespace = ANY(${pNs}) ${accessWhere} ${extraWhere}
           AND m.deleted_at IS NULL
           AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
           AND ${lifecycle}
           ${consolidationVisibility}
           AND ${vectorPredicate}
         ORDER BY embedding <=> ${pVec}::vector, id
         LIMIT 50)`);
    }).join('\nUNION ALL\n') || `
      (SELECT ${selectedColumns}, NULL::double precision AS vec_score
       FROM memories m WHERE FALSE)`;

    const textBranches = lifecyclePredicates.map(lifecycle => `
      (SELECT ${selectedColumns}, NULL::double precision AS vec_score
       FROM memories m
       WHERE namespace = ANY(${pNs}) ${accessWhere} ${extraWhere}
         AND m.deleted_at IS NULL
         AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
         AND ${lifecycle}
         ${consolidationVisibility}
         AND to_tsvector('english', content) @@ plainto_tsquery(${pQuery})
         AND NOT EXISTS (SELECT 1 FROM vector_results v WHERE v.id = m.id)
       ORDER BY ts_rank_cd(to_tsvector('english', content), plainto_tsquery(${pQuery})) DESC, id
       LIMIT 20)`).join('\nUNION ALL\n');

    const demotionMultiplier = shouldDemoteSuperseded
      ? `CASE WHEN s.superseded_at IS NOT NULL THEN ${pSupersededFactor}::double precision ELSE 1.0 END`
      : '1.0';
    const predecessorSelect = capabilities.supersession_schema
      ? `(SELECT predecessor.id FROM memories predecessor
         WHERE predecessor.id = r.linked_supersedes_id
           AND predecessor.deleted_at IS NULL
           AND (predecessor.expires_at IS NULL OR predecessor.expires_at > statement_timestamp())
           AND predecessor.namespace = r.namespace
           AND predecessor.namespace = ANY(${pNs})
           AND ${accessLevelSql('predecessor.access_level', pMaxAccessLevel)}
         LIMIT 1)`
      : 'NULL::uuid';
    const successorSelect = capabilities.supersession_schema
      ? `(SELECT successor.id FROM memories successor
         WHERE successor.supersedes_id = r.id
           AND successor.deleted_at IS NULL
           AND (successor.expires_at IS NULL OR successor.expires_at > statement_timestamp())
           AND successor.namespace = r.namespace
           AND successor.namespace = ANY(${pNs})
           AND ${accessLevelSql('successor.access_level', pMaxAccessLevel)}
         LIMIT 1)`
      : 'NULL::uuid';

    const pRequesterKeyId = p(scope.keyId);
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
          AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
          ${consolidationVisibility}
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
      SELECT r.id, r.content, r.metadata, r.tags, r.source, r.namespace, r.created_at, r.event_at, r.expires_at,
        r.relevance_score, r.relevance_base_score, r.decay_rate, r.updated_at, r.accessed_at,
        r.access_count, r.access_level, r.client_id, r.embedding_provider, r.embedding_model,
        r.embedding_dimensions, r.memory_kind, r.valid_from, r.valid_to, r.superseded_at,
        r.revision, r.vec_score, r.text_score, r.base_score, r.relevance, r.final_score,
        ${predecessorSelect} AS supersedes_id,
        (r.superseded_at IS NOT NULL) AS is_superseded,
        ${successorSelect} AS superseded_by_id,
        CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
          'agent_id', a.id,
          'agent_name', a.name,
          'agent_type', a.type,
          'agent_model', a.model,
          'agent_runtime', a.runtime,
          'same_key_as_requester', COALESCE(a.api_key_id::text = ${pRequesterKeyId}, false)
        ) END AS provenance
      FROM ranked r
      LEFT JOIN agents a ON a.id = r.agent_id
      ORDER BY final_score DESC, r.id
      LIMIT ${pLimit};
    `;

    const res = await client.query(sql, values);

    if (res.rows.length > 0) {
      const ids = res.rows.map((r: any) => r.id);
      await client.query(
        `UPDATE memories SET accessed_at = NOW(), access_count = access_count + 1, last_boosted_at = NOW()
         WHERE id = ANY($1) AND deleted_at IS NULL
           AND (expires_at IS NULL OR expires_at > statement_timestamp())${capabilities.consolidation_schema ? ' AND consolidated_into_id IS NULL' : ''}`,
        [ids]
      );
    }

    return res.rows as SearchResult[];
  });
}
