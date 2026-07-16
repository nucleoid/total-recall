import type { ScopedClient, DbScope } from './db.js';
import { withScopedClient } from './db.js';
import { accessLevelSql } from './auth.js';
import type { AccessLevel } from './types.js';
import { normalizeEntityName, type EntityType, type ExtractedEntity } from './entity-extractor.js';

export const GRAPH_MAX_ENTITIES = 100;
export const GRAPH_MAX_MEMORIES = 500;
export const GRAPH_MAX_EDGES = 1_000;
export const GRAPH_MAX_DEPTH = 3;
export const ENTITY_JOB_MAX_ATTEMPTS = 5;

export interface EntityEnrichmentJob {
  memoryId: string;
  namespace: string;
  sourceRevision: number;
  sourceContentHash: string;
  sourceAccessLevel: string;
  attempts: number;
}

export async function claimEntityEnrichmentJob(
  client: ScopedClient,
  namespaces: readonly string[],
  staleAfterMinutes = 5,
): Promise<EntityEnrichmentJob | null> {
  if (!Number.isInteger(staleAfterMinutes) || staleAfterMinutes < 1 || staleAfterMinutes > 60) {
    throw new Error('staleAfterMinutes must be an integer from 1 to 60');
  }
  const result = await client.query<{
    memory_id: string; namespace: string; source_revision: number;
    source_content_hash: string; source_access_level: string; attempts: number;
  }>(`
    WITH candidate AS (
      SELECT q.memory_id
      FROM entity_enrichment_queue q
      WHERE q.namespace = ANY($1::text[])
        AND ((q.status IN ('pending', 'retry') AND q.next_attempt_at <= statement_timestamp())
          OR (q.status = 'processing' AND q.locked_at < statement_timestamp() - ($2::int * interval '1 minute')))
      ORDER BY q.next_attempt_at, q.created_at, q.memory_id
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE entity_enrichment_queue q
    SET status = 'processing', attempts = q.attempts + 1, locked_at = statement_timestamp(),
        updated_at = statement_timestamp(), last_error_code = NULL
    FROM candidate
    WHERE q.memory_id = candidate.memory_id
    RETURNING q.memory_id, q.namespace, q.source_revision, q.source_content_hash,
              q.source_access_level, q.attempts
  `, [namespaces, staleAfterMinutes]);
  const row = result.rows[0];
  return row ? {
    memoryId: row.memory_id,
    namespace: row.namespace,
    sourceRevision: row.source_revision,
    sourceContentHash: row.source_content_hash,
    sourceAccessLevel: row.source_access_level,
    attempts: row.attempts,
  } : null;
}

/** Load source text only after the feature-specific policy has approved this exact scope. */
export async function loadEntityJobContent(
  client: ScopedClient,
  job: EntityEnrichmentJob,
): Promise<string | null> {
  const result = await client.query<{ content: string }>(`
    SELECT m.content
    FROM entity_enrichment_queue q
    JOIN memories m ON m.id = q.memory_id AND m.namespace = q.namespace
    WHERE q.memory_id = $1::uuid AND q.namespace = $2 AND q.status = 'processing'
      AND q.source_revision = $3 AND q.source_content_hash = $4
      AND q.source_access_level = 'normal' AND m.memory_kind <> 'episode_chunk'
      AND m.entity_source_revision = q.source_revision AND md5(m.content) = q.source_content_hash
      AND COALESCE(m.access_level, 'normal') = q.source_access_level
      AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.valid_to IS NULL
      AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp())
      AND m.consolidated_into_id IS NULL
  `, [job.memoryId, job.namespace, job.sourceRevision, job.sourceContentHash]);
  return result.rows[0]?.content ?? null;
}

/** Revalidate exact source state and replace links in the caller's transaction. */
export async function replaceMemoryEntityLinks(
  client: ScopedClient,
  job: EntityEnrichmentJob,
  entities: readonly ExtractedEntity[],
): Promise<boolean> {
  const locked = await lockFreshEntityJob(client, job);
  if (!locked) return false;
  if (!locked.eligible) {
    await client.query('DELETE FROM memory_entities WHERE namespace = $1 AND memory_id = $2::uuid',
      [job.namespace, job.memoryId]);
    await markJobDone(client, job);
    return true;
  }

  await client.query('DELETE FROM memory_entities WHERE namespace = $1 AND memory_id = $2::uuid',
    [job.namespace, job.memoryId]);
  for (const entity of entities) {
    const upserted = await client.query<{ id: string }>(`
      INSERT INTO entities (namespace, type, normalized_name, display_name)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (namespace, type, normalized_name) DO UPDATE
        SET display_name = EXCLUDED.display_name, updated_at = statement_timestamp()
      RETURNING id
    `, [job.namespace, entity.type, entity.normalizedName, entity.displayName]);
    await client.query(`
      INSERT INTO memory_entities (namespace, memory_id, entity_id, mention, aliases, confidence)
      VALUES ($1, $2::uuid, $3::uuid, $4, $5::text[], $6)
    `, [job.namespace, job.memoryId, upserted.rows[0].id, entity.mention, entity.aliases, entity.confidence]);
  }
  await markJobDone(client, job);
  return true;
}

/** Complete an out-of-policy row without materializing or sending its content. */
export async function removeEntityLinksForIneligibleJob(
  client: ScopedClient,
  job: EntityEnrichmentJob,
): Promise<boolean> {
  const locked = await lockFreshEntityJob(client, job);
  if (!locked) return false;
  if (locked.eligible) return false;
  await client.query('DELETE FROM memory_entities WHERE namespace = $1 AND memory_id = $2::uuid',
    [job.namespace, job.memoryId]);
  await markJobDone(client, job);
  return true;
}

export async function markEntityJobFailed(
  client: ScopedClient,
  job: EntityEnrichmentJob,
  errorCode: string,
  maxAttempts = ENTITY_JOB_MAX_ATTEMPTS,
): Promise<boolean> {
  if (!/^[a-z0-9_.-]{1,64}$/.test(errorCode)) throw new Error('Invalid content-free entity job error code');
  const result = await client.query(`
    UPDATE entity_enrichment_queue
    SET status = CASE WHEN attempts >= $5 THEN 'dead' ELSE 'retry' END,
        next_attempt_at = statement_timestamp() + (LEAST(3600, power(2, attempts)::int * 15) * interval '1 second'),
        locked_at = NULL, last_error_code = $4, updated_at = statement_timestamp()
    WHERE memory_id = $1::uuid AND namespace = $2 AND source_revision = $3
      AND source_content_hash = $6 AND status = 'processing'
  `, [job.memoryId, job.namespace, job.sourceRevision, errorCode, maxAttempts, job.sourceContentHash]);
  return result.rowCount === 1;
}

async function lockFreshEntityJob(client: ScopedClient, job: EntityEnrichmentJob): Promise<{
  eligible: boolean;
} | null> {
  const result = await client.query<{ eligible: boolean }>(`
    SELECT (COALESCE(m.access_level, 'normal') = 'normal' AND m.memory_kind <> 'episode_chunk'
      AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.valid_to IS NULL
      AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp())
      AND m.consolidated_into_id IS NULL) AS eligible
    FROM entity_enrichment_queue q
    JOIN memories m ON m.id = q.memory_id AND m.namespace = q.namespace
    WHERE q.memory_id = $1::uuid AND q.namespace = $2 AND q.status = 'processing'
      AND q.source_revision = $3 AND q.source_content_hash = $4
      AND m.entity_source_revision = q.source_revision AND md5(m.content) = q.source_content_hash
      AND COALESCE(m.access_level, 'normal') = q.source_access_level
    FOR UPDATE OF q, m
  `, [job.memoryId, job.namespace, job.sourceRevision, job.sourceContentHash]);
  return result.rows[0] ?? null;
}

async function markJobDone(client: ScopedClient, job: EntityEnrichmentJob): Promise<void> {
  const result = await client.query(`
    UPDATE entity_enrichment_queue SET status = 'done', locked_at = NULL, completed_at = statement_timestamp(),
      last_error_code = NULL, updated_at = statement_timestamp()
    WHERE memory_id = $1::uuid AND namespace = $2 AND source_revision = $3
      AND source_content_hash = $4 AND status = 'processing'
  `, [job.memoryId, job.namespace, job.sourceRevision, job.sourceContentHash]);
  if (result.rowCount !== 1) throw new Error('Entity enrichment source changed while completing');
}

export interface MemoryGraphOptions {
  entity: string;
  type?: EntityType;
  namespaces: string[];
  depth: number;
  maxAccessLevel: AccessLevel;
}

export interface MemoryGraphResult {
  version: 1;
  seeds: string[];
  entities: Array<{
    id: string; namespace: string; type: EntityType; name: string; normalized_name: string; distance: number;
  }>;
  memories: Array<{
    id: string; namespace: string; content: string; source: string; tags: string[]; created_at: Date;
  }>;
  edges: Array<{
    entity_id: string; memory_id: string; namespace: string; mention: string; aliases: string[]; confidence: number;
  }>;
  indexing: { complete: boolean; pending: number; processing: number; retry: number; dead: number; unindexed: number };
  truncation: { entities: boolean; memories: boolean; edges: boolean };
}

type EntityRow = {
  id: string; namespace: string; type: EntityType; display_name: string; normalized_name: string;
};

/** Bounded, deterministic breadth-first traversal under one transaction-local authorization scope. */
export async function traverseMemoryGraph(
  scope: DbScope,
  options: MemoryGraphOptions,
): Promise<MemoryGraphResult> {
  if (options.namespaces.length === 0) return emptyGraph();
  return withScopedClient(scope, async client => {
    await client.query("SELECT set_config('statement_timeout', '10000', true)");
    const normalized = normalizeEntityName(options.entity);
    const seedResult = await client.query<EntityRow>(`
      SELECT id, namespace, type, display_name, normalized_name
      FROM entities
      WHERE namespace = ANY($1::text[])
        AND EXISTS (
          SELECT 1 FROM memory_entities visible_link
          JOIN memories visible_memory ON visible_memory.id = visible_link.memory_id
            AND visible_memory.namespace = visible_link.namespace
          WHERE visible_link.entity_id = entities.id AND visible_link.namespace = entities.namespace
            AND visible_memory.namespace = ANY($1::text[])
            AND ${activeMemorySql('visible_memory', '$4')}
        )
        AND (normalized_name = $2 OR EXISTS (
          SELECT 1 FROM memory_entities alias_link
          JOIN memories alias_memory ON alias_memory.id = alias_link.memory_id
            AND alias_memory.namespace = alias_link.namespace,
            unnest(alias_link.aliases) AS extracted_alias(value)
          WHERE alias_link.entity_id = entities.id AND alias_link.namespace = entities.namespace
            AND alias_memory.namespace = ANY($1::text[])
            AND ${activeMemorySql('alias_memory', '$4')}
            AND lower(btrim(regexp_replace(extracted_alias.value, '\\s+', ' ', 'g'))) = $2
        ))
        AND ($3::text IS NULL OR type = $3)
      ORDER BY namespace, type, normalized_name, id
      LIMIT $5
    `, [options.namespaces, normalized, options.type ?? null, options.maxAccessLevel, GRAPH_MAX_ENTITIES + 1]);

    let entitiesTruncated = seedResult.rows.length > GRAPH_MAX_ENTITIES;
    const selected = seedResult.rows.slice(0, GRAPH_MAX_ENTITIES);
    const distances = new Map(selected.map(row => [row.id, 0]));
    let frontier = selected.map(row => row.id);
    for (let distance = 1; distance <= options.depth && frontier.length > 0; distance += 1) {
      const remaining = GRAPH_MAX_ENTITIES - selected.length;
      const neighbors = await client.query<EntityRow>(`
        SELECT e.id, e.namespace, e.type, e.display_name, e.normalized_name
        FROM memory_entities source_link
        JOIN memories m ON m.id = source_link.memory_id AND m.namespace = source_link.namespace
        JOIN memory_entities neighbor_link ON neighbor_link.memory_id = m.id AND neighbor_link.namespace = m.namespace
        JOIN entities e ON e.id = neighbor_link.entity_id AND e.namespace = neighbor_link.namespace
        WHERE source_link.entity_id = ANY($1::uuid[])
          AND m.namespace = ANY($2::text[])
          AND ${activeMemorySql('m', '$3')}
          AND NOT (e.id = ANY($4::uuid[]))
        GROUP BY e.id, e.namespace, e.type, e.display_name, e.normalized_name
        ORDER BY e.namespace, e.type, e.normalized_name, e.id
        LIMIT $5
      `, [frontier, options.namespaces, options.maxAccessLevel, [...distances.keys()], remaining + 1]);
      if (neighbors.rows.length > remaining) entitiesTruncated = true;
      const admitted = neighbors.rows.slice(0, remaining);
      for (const row of admitted) {
        selected.push(row);
        distances.set(row.id, distance);
      }
      frontier = admitted.map(row => row.id);
    }

    const entityIds = selected.map(row => row.id);
    const memoryResult = entityIds.length === 0 ? { rows: [] as any[] } : await client.query<{
      id: string; namespace: string; content: string; source: string; tags: string[]; created_at: Date;
    }>(`
      SELECT DISTINCT m.id, m.namespace, m.content, m.source, m.tags, m.created_at
      FROM memory_entities me JOIN memories m ON m.id = me.memory_id AND m.namespace = me.namespace
      WHERE me.entity_id = ANY($1::uuid[]) AND m.namespace = ANY($2::text[])
        AND ${activeMemorySql('m', '$3')}
      ORDER BY m.created_at, m.id
      LIMIT $4
    `, [entityIds, options.namespaces, options.maxAccessLevel, GRAPH_MAX_MEMORIES + 1]);
    const memoriesTruncated = memoryResult.rows.length > GRAPH_MAX_MEMORIES;
    const memories = memoryResult.rows.slice(0, GRAPH_MAX_MEMORIES);
    const memoryIds = memories.map(row => row.id);

    const edgeResult = entityIds.length === 0 || memoryIds.length === 0 ? { rows: [] as any[] } : await client.query<{
      entity_id: string; memory_id: string; namespace: string; mention: string; aliases: string[]; confidence: number;
    }>(`
      SELECT me.entity_id, me.memory_id, me.namespace, me.mention, me.aliases, me.confidence
      FROM memory_entities me
      WHERE me.entity_id = ANY($1::uuid[]) AND me.memory_id = ANY($2::uuid[])
        AND me.namespace = ANY($3::text[])
      ORDER BY me.namespace, me.memory_id, me.entity_id
      LIMIT $4
    `, [entityIds, memoryIds, options.namespaces, GRAPH_MAX_EDGES + 1]);
    const edgesTruncated = edgeResult.rows.length > GRAPH_MAX_EDGES;

    const indexing = await graphIndexingStatus(client, options.namespaces);
    return {
      version: 1,
      seeds: seedResult.rows.slice(0, GRAPH_MAX_ENTITIES).map(row => row.id),
      entities: selected.map(row => ({ id: row.id, namespace: row.namespace, type: row.type,
        name: row.display_name, normalized_name: row.normalized_name, distance: distances.get(row.id)! })),
      memories,
      edges: edgeResult.rows.slice(0, GRAPH_MAX_EDGES).map(row => ({ ...row, confidence: Number(row.confidence) })),
      indexing,
      truncation: { entities: entitiesTruncated, memories: memoriesTruncated, edges: edgesTruncated },
    };
  });
}

async function graphIndexingStatus(client: ScopedClient, namespaces: string[]): Promise<MemoryGraphResult['indexing']> {
  const result = await client.query<{
    pending: string; processing: string; retry: string; dead: string; unindexed: string;
  }>(`
    SELECT
      count(*) FILTER (WHERE q.status = 'pending')::text AS pending,
      count(*) FILTER (WHERE q.status = 'processing')::text AS processing,
      count(*) FILTER (WHERE q.status = 'retry')::text AS retry,
      count(*) FILTER (WHERE q.status = 'dead')::text AS dead,
      count(*) FILTER (WHERE q.memory_id IS NULL OR q.status <> 'done'
        OR q.source_revision <> m.entity_source_revision OR q.source_content_hash <> md5(m.content)
        OR q.source_access_level <> COALESCE(m.access_level, 'normal'))::text AS unindexed
    FROM memories m
    LEFT JOIN entity_enrichment_queue q ON q.memory_id = m.id AND q.namespace = m.namespace
    WHERE m.namespace = ANY($1::text[]) AND COALESCE(m.access_level, 'normal') = 'normal'
      AND m.memory_kind <> 'episode_chunk' AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.valid_to IS NULL
      AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp())
      AND m.consolidated_into_id IS NULL
  `, [namespaces]);
  const row = result.rows[0];
  const status = {
    pending: Number(row?.pending ?? 0), processing: Number(row?.processing ?? 0),
    retry: Number(row?.retry ?? 0), dead: Number(row?.dead ?? 0), unindexed: Number(row?.unindexed ?? 0),
  };
  return { complete: status.unindexed === 0, ...status };
}

function activeMemorySql(alias: string, ceilingParameter: string): string {
  return `${alias}.deleted_at IS NULL AND ${alias}.superseded_at IS NULL AND ${alias}.valid_to IS NULL
    AND (${alias}.valid_from IS NULL OR ${alias}.valid_from <= statement_timestamp())
    AND ${alias}.consolidated_into_id IS NULL AND ${accessLevelSql(`${alias}.access_level`, ceilingParameter)}`;
}

function emptyGraph(): MemoryGraphResult {
  return { version: 1, seeds: [], entities: [], memories: [], edges: [],
    indexing: { complete: true, pending: 0, processing: 0, retry: 0, dead: 0, unindexed: 0 },
    truncation: { entities: false, memories: false, edges: false } };
}

export interface EntityBackfillPreview {
  rows: number;
  inputBytes: number;
  estimatedTokens: number;
}

export async function previewEntityBackfill(client: ScopedClient, namespace: string): Promise<EntityBackfillPreview> {
  const result = await client.query<{ rows: string; input_bytes: string }>(`
    SELECT count(*)::text AS rows, COALESCE(sum(octet_length(m.content)), 0)::text AS input_bytes
    FROM memories m LEFT JOIN entity_enrichment_queue q ON q.memory_id = m.id
    WHERE m.namespace = $1 AND m.access_level = 'normal' AND m.memory_kind <> 'episode_chunk'
      AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.valid_to IS NULL
      AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp())
      AND m.consolidated_into_id IS NULL AND q.memory_id IS NULL
  `, [namespace]);
  const rows = Number(result.rows[0]?.rows ?? 0);
  const inputBytes = Number(result.rows[0]?.input_bytes ?? 0);
  return { rows, inputBytes, estimatedTokens: Math.ceil(inputBytes / 4) };
}

export async function enqueueEntityBackfill(
  client: ScopedClient,
  namespace: string,
  limit: number,
): Promise<{ enqueued: number; lastMemoryId: string | null }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('Backfill limit must be 1 to 10000');
  const result = await client.query<{ enqueued: string; last_memory_id: string | null }>(`
    WITH candidates AS MATERIALIZED (
      SELECT m.id AS memory_id, m.namespace, m.entity_source_revision,
             COALESCE(m.updated_at, statement_timestamp()) AS updated_at,
             md5(m.content) AS content_hash, m.access_level, m.created_at
      FROM memories m LEFT JOIN entity_enrichment_queue q ON q.memory_id = m.id
      WHERE m.namespace = $1 AND m.access_level = 'normal' AND m.memory_kind <> 'episode_chunk'
        AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.valid_to IS NULL
        AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp())
        AND m.consolidated_into_id IS NULL AND q.memory_id IS NULL
      ORDER BY m.created_at, m.id LIMIT $2
    ), inserted AS (
      INSERT INTO entity_enrichment_queue (
        memory_id, namespace, source_revision, source_updated_at, source_content_hash, source_access_level
      )
      SELECT memory_id, namespace, entity_source_revision, updated_at, content_hash, access_level FROM candidates
      ON CONFLICT (memory_id) DO NOTHING RETURNING memory_id
    )
    SELECT (SELECT count(*)::text FROM inserted) AS enqueued,
      (SELECT memory_id FROM candidates ORDER BY created_at DESC NULLS FIRST, memory_id DESC LIMIT 1) AS last_memory_id
  `, [namespace, limit]);
  return { enqueued: Number(result.rows[0]?.enqueued ?? 0), lastMemoryId: result.rows[0]?.last_memory_id ?? null };
}
