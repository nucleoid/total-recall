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
import { QWEN_CONTRACT_ID } from './local-embedding-contract.js';
import { getLocalServingClient, localServingEnabled } from './local-embedding-runtime.js';
import {
  hnswEfSearchFromEnv,
  supersededScoreFactorFromEnv,
  supersededSearchDemotionEnabledFromEnv,
} from './config.js';
import type {
  AccessLevel,
  SearchExecutionOptions,
  SearchParams,
  SearchQueryVector,
  SearchRankingConfig,
  SearchResult,
} from './types.js';
import dotenv from 'dotenv';
dotenv.config();

const EF_SEARCH = hnswEfSearchFromEnv();
const SUPERSEDED_SEARCH_DEMOTION_ENABLED = supersededSearchDemotionEnabledFromEnv();
const SUPERSEDED_SCORE_FACTOR = SUPERSEDED_SEARCH_DEMOTION_ENABLED
  ? supersededScoreFactorFromEnv()
  : 1;
const SEARCH_SCHEMA_CAPABILITY_TTL_MS = boundedSchemaTtl(process.env.SEARCH_SCHEMA_CAPABILITY_TTL_MS);
const LOCAL_EXACT_PARENT_LIMIT = 10_000;
const LOCAL_EXACT_CHUNK_LIMIT = 50_000;
const LOCAL_ANN_CHUNK_OVERFETCH = 1_000;

/** Exact pre-evaluation ranking behavior, including the intentionally inconsistent diagnostic bonus. */
export const DEFAULT_SEARCH_RANKING_CONFIG: Readonly<SearchRankingConfig> = Object.freeze({
  vectorWeight: 0.3,
  textWeight: 0.7,
  diagnosticTextMatchBonus: 0.5,
  finalTextMatchBonus: 2.0,
  relevanceCap: 2.0,
  vectorCandidateLimit: 50,
  textCandidateLimit: 20,
  resultLimitCap: 50,
});

export function validateSearchRankingConfig(config: SearchRankingConfig): SearchRankingConfig {
  const finiteNonnegative = [
    'vectorWeight', 'textWeight', 'diagnosticTextMatchBonus', 'finalTextMatchBonus', 'relevanceCap',
  ] as const;
  for (const key of finiteNonnegative) {
    if (!Number.isFinite(config[key]) || config[key] < 0) throw new Error(`Invalid ranking ${key}`);
  }
  if (config.vectorWeight + config.textWeight <= 0) throw new Error('Ranking weights cannot both be zero');
  if (config.relevanceCap <= 0) throw new Error('Ranking relevanceCap must be greater than zero');
  for (const key of ['vectorCandidateLimit', 'textCandidateLimit', 'resultLimitCap'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > 1000) {
      throw new Error(`Invalid ranking ${key}`);
    }
  }
  return Object.freeze({ ...config });
}

function sqlNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('Ranking values must be finite and nonnegative');
  return String(value);
}

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
  return executeHybridSearch(params, namespaces, scope, maxAccessLevel);
}

/**
 * Side-effect-free ranking path: callers must inject vectors, and access tracking
 * cannot be enabled. Production tools deliberately call hybridSearch instead.
 */
export async function rankMemories(
  params: SearchParams,
  namespaces: string[],
  scope: DbScope,
  maxAccessLevel: AccessLevel,
  options: Omit<SearchExecutionOptions, 'trackAccess' | 'queryVectors'> &
    { queryVectors: NonNullable<SearchExecutionOptions['queryVectors']> },
): Promise<SearchResult[]> {
  return executeHybridSearch(params, namespaces, scope, maxAccessLevel, { ...options, trackAccess: false });
}

/** Shared implementation behind the production and side-effect-free wrappers. */
export async function executeHybridSearch(
  params: SearchParams,
  namespaces: string[],
  scope: DbScope,
  maxAccessLevel: AccessLevel,
  options: SearchExecutionOptions = {},
): Promise<SearchResult[]> {
  const ranking = validateSearchRankingConfig(options.ranking ?? DEFAULT_SEARCH_RANKING_CONFIG);
  const trackAccess = options.trackAccess !== false;
  const asOf = options.asOf === undefined ? undefined : normalizedInstant(options.asOf, 'asOf');
  const configuredLocalServing = !options.queryVectors && localServingEnabled();
  const useLocalServing = options.queryVectors ? false : await withScopedClient(scope, async client => {
    return resolveAutomaticReadMode(client, configuredLocalServing);
  }, { readOnly: true });
  let localQueryVector: string | undefined;
  // queryVectors supersedes the old single vectorAvailable flag.
  const queryVectors: Array<{ profile: SearchQueryVector['profile']; vector: string }> = [];
  if (options.queryVectors) {
    for (const item of options.queryVectors) {
      if (item.profile.provider === 'llama.cpp') {
        if (item.profile.model !== QWEN_CONTRACT_ID || item.profile.dimensions !== 768 || localQueryVector) {
          throw new Error('shadow_embedding.explicit_vector_identity');
        }
        // Current manifests cannot support a historical snapshot. Keep valid_at
        // explicitly text-only rather than scoring today's chunks against the past.
        if (!params.valid_at) localQueryVector = serializeEmbeddingVector(item.vector);
      } else {
        queryVectors.push({ profile: item.profile, vector: serializeEmbeddingVector(item.vector) });
      }
    }
  } else if (useLocalServing) {
    // Historical manifests deliberately describe only the current parent revision.
    // Temporal retrieval therefore remains text-only rather than resurrecting a
    // current chunk vector into a historical result set.
  } else {
    try {
      const result = await embedWithProfile(params.query, ACTIVE_EMBEDDING_PROFILE);
      queryVectors.push({ profile: ACTIVE_EMBEDDING_PROFILE, vector: serializeEmbeddingVector(result.vector) });
    } catch (error) {
      console.warn('[search] Current embedding profile unavailable; using text-only search fallback');
    }
  }
  const limit = Math.min(params.limit ?? 10, ranking.resultLimitCap);
  const threshold = params.threshold ?? 0.3;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Search limit must be a positive integer');
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) throw new Error('Search threshold must be between -1 and 1');

  if (useLocalServing) {
    await withScopedClient(scope, async client => verifyLocalServingContract(client), { readOnly: true });
    const localClient = getLocalServingClient();
    if (!params.valid_at) try {
      const result = await localClient.embed([params.query], 'query');
      localQueryVector = serializeEmbeddingVector(result.vectors[0]);
    } catch {
      console.warn('[search] Local embedding runtime unavailable; using text-only search fallback');
    }
  }

  return withScopedClient(scope, async (client) => {
    await client.query("SELECT set_config('hnsw.ef_search', $1, true)", [String(EF_SEARCH)]);

    // Ordinary finalized searches reuse a short-lived process/pool-generation
    // cache. valid_at always refreshes the finalization proof and fails closed.
    const capabilities = await searchSchemaCapabilities(client, params.valid_at !== undefined);

    if (params.valid_at && !capabilities.validity_finalized) {
      throw new Error('Invalid valid_at: temporal search is unavailable until memory validity finalization completes');
    }

    if (!options.queryVectors && !useLocalServing) {
      // The provider call runs outside a transaction. Recheck automatic legacy
      // mode before ranking so a concurrent cutover cannot score the old space.
      await resolveAutomaticReadMode(client, false);
    }
    // Canonicalize aliases that describe the same space. A legacy provider is
    // never called merely because credentials exist: at least one fully labelled,
    // filtered, visible row must be present.
    const queriedIdentities = new Set([embeddingIdentity(ACTIVE_EMBEDDING_PROFILE)]);
    if (!options.queryVectors && !useLocalServing) for (const profile of LEGACY_EMBEDDING_PROFILES) {
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
    if (!options.queryVectors) {
      // Provider work is complete. Hold a shared transaction lock across the
      // final serving fence and ranking so supported cutover/rollback cannot
      // commit a mode change between them. Never hold this lock during inference.
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('total-recall.embedding-serving',0))");
      if (useLocalServing) await verifyLocalServingContract(client);
      else await resolveAutomaticReadMode(client, false);
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
    const pAsOf = asOf ? p(asOf) : null;
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
    const selectedColumns = `id, content, source_key, metadata, tags, source, namespace, created_at, event_at, expires_at,
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
         LIMIT ${ranking.vectorCandidateLimit})`);
    }).join('\nUNION ALL\n') || `
      (SELECT ${selectedColumns}, NULL::double precision AS vec_score
       FROM memories m WHERE FALSE)`;

    const localVectorBranch = localQueryVector ? (() => {
      const pVec = p(localQueryVector);
      const pContract = p(QWEN_CONTRACT_ID);
      const pReadinessNamespaces=p(namespaces),pReadinessAccess=p(maxAccessLevel);
      // Exact scoring is bounded to selective scopes. Large scopes use a correlated
      // membership filter so pgvector can retain HNSW ordering while applying the
      // eligible parent ACL, revision and lifecycle set before LIMIT. Per-parent MAX and
      // one-row aggregation prevent multi-chunk parents from occupying result slots.
      return `
        local_scope_readiness AS MATERIALIZED (
          SELECT shadow_embedding_scope_ready(${pReadinessNamespaces}::text[],${pReadinessAccess}) AS ready
        ),
        eligible_local_parents AS NOT MATERIALIZED (
          SELECT m.*, mf.chunk_count AS shadow_chunk_count
          FROM memories m
          JOIN memory_embedding_manifests mf
            ON mf.contract_id = ${pContract} AND mf.parent_id = m.id
           AND mf.is_current AND mf.source_revision = m.revision
          WHERE (SELECT ready FROM local_scope_readiness)
            AND m.namespace = ANY(${pNs}) ${accessWhere} ${extraWhere}
            AND m.deleted_at IS NULL
            AND m.superseded_at IS NULL
            AND m.consolidated_into_id IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
            AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp())
            AND (m.valid_to IS NULL OR m.valid_to > statement_timestamp())
        ),
        local_scope_size AS (
          SELECT count(*) AS parents, COALESCE(sum(shadow_chunk_count), 0) AS chunks
          FROM (
            SELECT shadow_chunk_count FROM eligible_local_parents
            LIMIT ${LOCAL_EXACT_PARENT_LIMIT + 1}
          ) bounded_scope
        ),
        local_exact_chunks AS MATERIALIZED (
          SELECT c.parent_id, 1 - (c.embedding <=> ${pVec}::vector) AS vec_score
          FROM memory_embedding_chunks c
          JOIN eligible_local_parents ep ON ep.id = c.parent_id
          WHERE c.contract_id = ${pContract}
            AND (SELECT parents <= ${LOCAL_EXACT_PARENT_LIMIT} AND chunks <= ${LOCAL_EXACT_CHUNK_LIMIT} FROM local_scope_size)
        ),
        local_ann_head AS MATERIALIZED (
          SELECT c.parent_id, 1 - (c.embedding <=> ${pVec}::vector) AS vec_score
          FROM memory_embedding_chunks c
          WHERE c.contract_id = ${pContract}
            AND NOT (SELECT parents <= ${LOCAL_EXACT_PARENT_LIMIT} AND chunks <= ${LOCAL_EXACT_CHUNK_LIMIT} FROM local_scope_size)
            AND (SELECT true FROM eligible_local_parents ep WHERE ep.id = c.parent_id)
          ORDER BY c.embedding <=> ${pVec}::vector
          LIMIT ${LOCAL_ANN_CHUNK_OVERFETCH}
        ),
        local_parent_scores AS MATERIALIZED (
          SELECT candidate.parent_id, max(candidate.vec_score) AS vec_score
          FROM (
            SELECT * FROM local_exact_chunks
            UNION ALL
            SELECT * FROM local_ann_head
          ) candidate
          GROUP BY candidate.parent_id
          ORDER BY max(candidate.vec_score) DESC, candidate.parent_id
          LIMIT ${ranking.vectorCandidateLimit}
        ),
        local_vector_results AS (
          SELECT ${selectedColumns}, ps.vec_score
          FROM local_parent_scores ps
          JOIN eligible_local_parents m ON m.id = ps.parent_id
        ),`;
    })() : '';

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
       LIMIT ${ranking.textCandidateLimit})`).join('\nUNION ALL\n');

    const demotionMultiplier = shouldDemoteSuperseded
      ? `CASE WHEN s.superseded_at IS NOT NULL THEN ${pSupersededFactor}::double precision ELSE 1.0 END`
      : '1.0';
    // Keep the established default visibly exact while allowing validated evaluator experiments.
    const relevanceMultiplier = ranking.relevanceCap === 2
      ? 'LEAST(s.relevance, 2.0)'
      : `LEAST(s.relevance, ${sqlNumber(ranking.relevanceCap)})`;
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
      WITH ${localVectorBranch}vector_results AS (
        ${localQueryVector
          ? `SELECT * FROM local_vector_results${queryVectors.length ? `\nUNION ALL\n${vectorBranches}` : ''}`
          : vectorBranches}
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
        FROM combined
        WHERE to_tsvector('english', content) @@ plainto_tsquery(${pQuery})
      ),
      scored AS MATERIALIZED (
        SELECT c.*,
          COALESCE(t.text_score, 0) AS text_score,
          (COALESCE(c.vec_score, 0) * ${sqlNumber(ranking.vectorWeight)} + COALESCE(t.text_score, 0) * ${sqlNumber(ranking.textWeight)} + CASE WHEN COALESCE(t.text_score, 0) > 0 THEN ${sqlNumber(ranking.diagnosticTextMatchBonus)} ELSE 0 END) AS base_score,
          ${pAsOf
            ? `(COALESCE(c.relevance_base_score, 1.0) * EXP(-COALESCE(c.decay_rate, 0.01) * GREATEST(0.0, EXTRACT(EPOCH FROM (${pAsOf}::timestamptz - COALESCE(c.accessed_at, ${pAsOf}::timestamptz))) / 86400.0)) + LEAST(GREATEST(COALESCE(c.access_count, 0) * 0.1, 0.0), 1.0))`
            : 'calculate_relevance(c.relevance_base_score, c.decay_rate, c.accessed_at, c.access_count)'} AS relevance
        FROM combined c
        LEFT JOIN text_scores t ON c.id = t.id
        WHERE COALESCE(c.vec_score, 0) >= ${pThreshold} OR t.text_score > 0
      ),
      ranked AS (
        SELECT s.*,
          (COALESCE(s.vec_score, 0) * ${sqlNumber(ranking.vectorWeight)} + s.text_score * ${sqlNumber(ranking.textWeight)} + CASE WHEN s.text_score > 0 THEN ${sqlNumber(ranking.finalTextMatchBonus)} ELSE 0 END)
            * ${relevanceMultiplier}
            * ${demotionMultiplier} AS final_score
        FROM scored s
      )
      SELECT r.id, r.content, r.source_key, r.metadata, r.tags, r.source, r.namespace, r.created_at, r.event_at, r.expires_at,
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

    if (trackAccess && res.rows.length > 0) {
      const ids = res.rows.map((r: any) => r.id);
      await client.query(
        `UPDATE memories SET accessed_at = NOW(), access_count = access_count + 1, last_boosted_at = NOW()
         WHERE id = ANY($1) AND deleted_at IS NULL
           AND (expires_at IS NULL OR expires_at > statement_timestamp())${capabilities.consolidation_schema ? ' AND consolidated_into_id IS NULL' : ''}`,
        [ids]
      );
    }

    return res.rows as SearchResult[];
  }, { readOnly: !trackAccess });
}

function normalizedInstant(value: string, field: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error(`${field} must be an ISO-8601 instant`);
  }
  return date.toISOString();
}

async function verifyLocalServingContract(client: ScopedClient): Promise<void> {
  const serving = await client.query<{ contract_id: string }>(`
    SELECT contract_id FROM embedding_serving_settings WHERE singleton = true
  `);
  if (serving.rows.length !== 1 || serving.rows[0].contract_id !== QWEN_CONTRACT_ID) {
    throw new Error('shadow_embedding.serving_contract_mismatch');
  }
}

async function resolveAutomaticReadMode(client: ScopedClient, configuredLocalServing: boolean): Promise<boolean> {
  const schema = await client.query<{ serving_table: string | null }>(`
    SELECT to_regclass('public.embedding_serving_settings')::text AS serving_table
  `);
  if (schema.rows.length !== 1 || !Object.prototype.hasOwnProperty.call(schema.rows[0], 'serving_table')
    || (schema.rows[0].serving_table !== null && typeof schema.rows[0].serving_table !== 'string')) {
    throw new Error('shadow_embedding.serving_catalog_mismatch');
  }
  if (schema.rows[0].serving_table === null) {
    if (configuredLocalServing) throw new Error('shadow_embedding.serving_contract_mismatch');
    return false;
  }
  const serving = await client.query<{ contract_id: string }>(`
    SELECT contract_id FROM embedding_serving_settings WHERE singleton = true
  `);
  if (serving.rows.length === 0) {
    if (configuredLocalServing) throw new Error('shadow_embedding.serving_contract_mismatch');
    return false;
  }
  if (serving.rows.length !== 1 || serving.rows[0].contract_id !== QWEN_CONTRACT_ID || !configuredLocalServing) {
    throw new Error('shadow_embedding.serving_contract_mismatch');
  }
  return true;
}
