import { accessLevelSql, checkPermission, filterNamespaces } from './auth.js';
import { dbScopeFromAuth, queryScoped, type DbScope, type ScopedClient } from './db.js';
import type { AuthContext } from './types.js';
import { logAudit } from './audit.js';

export type MemorySort = 'created_at' | 'updated_at' | 'accessed_at' | 'access_count' | 'relevance';
export type MemoryActivity = 'active' | 'superseded' | 'expired' | 'all';

export interface MemoryBrowseFilters {
  namespace?: string;
  source?: string;
  tags?: string[];
  agent_id?: string;
  access_level?: 'normal' | 'sensitive' | 'secret';
  created_after?: string;
  created_before?: string;
  active: MemoryActivity;
  sort: MemorySort;
  direction: 'asc' | 'desc';
  limit: number;
  offset: number;
}

const SORT_COLUMNS: Record<MemorySort, string> = {
  created_at: 'm.created_at',
  updated_at: 'm.updated_at',
  accessed_at: 'm.accessed_at',
  access_count: 'm.access_count',
  relevance: 'm.relevance_score',
};

const COLUMNS = `m.id, m.content, m.source, m.namespace, m.tags, m.metadata,
  m.access_level, m.client_id, m.agent_id, m.session_id, m.document_id, m.chunk_index,
  m.created_at, m.updated_at, m.accessed_at, m.access_count, m.relevance_score,
  m.memory_kind, m.valid_from, m.valid_to, m.supersedes_id, m.superseded_at,
  m.revision, m.expires_at,
  (to_jsonb(m)->>'consolidated_into_id')::uuid AS consolidated_into_id,
  CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
    'agent_id', a.id, 'agent_name', a.name, 'agent_type', a.type,
    'agent_model', a.model, 'agent_runtime', a.runtime,
    'same_key_as_requester', COALESCE(a.api_key_id::text = app_current_key_id(), false)
  ) END AS provenance`;

function baseConditions(auth: AuthContext, namespaces: string[], includeInactive: boolean): { conditions: string[]; values: unknown[] } {
  const conditions = [
    'm.namespace = ANY($1::text[])',
    accessLevelSql('m.access_level', '$2'),
    'm.deleted_at IS NULL',
  ];
  if (!includeInactive) {
    conditions.push('(m.expires_at IS NULL OR m.expires_at > statement_timestamp())');
    conditions.push('m.superseded_at IS NULL');
    conditions.push("to_jsonb(m)->>'consolidated_into_id' IS NULL");
  }
  return { conditions, values: [namespaces, auth.maxAccessLevel] };
}

export async function listMemories(auth: AuthContext, filters: MemoryBrowseFilters) {
  checkPermission(auth, 'read');
  const namespaces = filterNamespaces(filters.namespace ? [filters.namespace] : undefined, auth.namespaces);
  if (namespaces.length === 0) {
    await logAudit({ clientId: auth.keyId, action: 'memory.list', resourceType: 'search', resultCount: 0 }, dbScopeFromAuth(auth));
    return { memories: [], total: 0, limit: filters.limit, offset: filters.offset };
  }

  const { conditions, values } = baseConditions(auth, namespaces, filters.active !== 'active');
  const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };

  if (filters.active === 'superseded') conditions.push('m.superseded_at IS NOT NULL');
  if (filters.active === 'expired') conditions.push('m.expires_at <= statement_timestamp()');
  if (filters.active === 'active') {
    // baseConditions already applies the full logical-active contract.
  } else if (filters.active === 'all') {
    // Deliberately includes expired and superseded rows, but never tombstones.
  }
  if (filters.source) conditions.push(`m.source = ${parameter(filters.source)}`);
  if (filters.tags?.length) conditions.push(`m.tags @> ${parameter(filters.tags)}::text[]`);
  if (filters.agent_id) conditions.push(`m.agent_id = ${parameter(filters.agent_id)}::uuid`);
  if (filters.access_level) conditions.push(`m.access_level = ${parameter(filters.access_level)}`);
  if (filters.created_after) conditions.push(`m.created_at >= ${parameter(filters.created_after)}::timestamptz`);
  if (filters.created_before) conditions.push(`m.created_at <= ${parameter(filters.created_before)}::timestamptz`);

  const where = conditions.join(' AND ');
  const countValues = [...values];
  const limit = parameter(filters.limit);
  const offset = parameter(filters.offset);
  const order = `${SORT_COLUMNS[filters.sort]} ${filters.direction.toUpperCase()}, m.id ${filters.direction.toUpperCase()}`;
  const scope = dbScopeFromAuth(auth);
  const [count, rows] = await Promise.all([
    queryScoped<{ total: string }>(scope, `SELECT COUNT(*)::text AS total FROM memories m WHERE ${where}`, countValues),
    queryScoped(scope, `SELECT ${COLUMNS} FROM memories m LEFT JOIN agents a ON a.id = m.agent_id WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, values),
  ]);

  await logAudit({
    clientId: auth.keyId, action: 'memory.list', resourceType: 'search', resultCount: rows.rows.length,
  }, scope);
  return {
    memories: rows.rows,
    total: Number(count.rows[0]?.total ?? 0),
    limit: filters.limit,
    offset: filters.offset,
  };
}

export async function getMemory(auth: AuthContext, id: string) {
  checkPermission(auth, 'read');
  const { conditions, values } = baseConditions(auth, auth.namespaces, false);
  values.push(id);
  conditions.push(`m.id = $${values.length}::uuid`);
  const scope = dbScopeFromAuth(auth);
  const result = await queryScoped(scope, `SELECT ${COLUMNS} FROM memories m LEFT JOIN agents a ON a.id = m.agent_id WHERE ${conditions.join(' AND ')} LIMIT 1`, values);
  if (result.rows[0]) {
    await logAudit({
      clientId: auth.keyId, action: 'memory.recall', resourceType: 'memory',
      resourceId: id, memoryId: id, resultCount: 1,
    }, scope);
  }
  return result.rows[0] ?? null;
}

/** Fetch active, accessible trace result summaries in their recorded order. */
export async function getMemorySummaries(auth: AuthContext, ids: string[]) {
  checkPermission(auth, 'read');
  if (ids.length === 0) return [];
  const { conditions, values } = baseConditions(auth, auth.namespaces, false);
  values.push(ids);
  conditions.push(`m.id = ANY($${values.length}::uuid[])`);
  return (await queryScoped(dbScopeFromAuth(auth),
    `SELECT m.id, m.content, m.namespace, m.source, m.tags, m.access_level, m.created_at
     FROM memories m WHERE ${conditions.join(' AND ')}
     ORDER BY array_position($${values.length}::uuid[], m.id)`, values)).rows;
}

export interface SourceKeyMemoryRevisionInput {
  ownerKeyId: string;
  agentId: string;
  namespace: string;
  source: string;
  sourceKey: string;
  content: string;
  embedding: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  tags: string[];
  metadata: Record<string, unknown>;
  aggregateHash: string;
  auditAction: string;
  /** Metadata field/value identifying the lifecycle series, such as category=music. */
  seriesField: string;
  seriesValue: string;
  /** Optional lexically sortable metadata identity used to prevent out-of-order lifecycle insertion. */
  seriesOrderField?: string;
  seriesOrderValue?: string;
  force?: boolean;
}

export interface SourceKeyMemoryRevisionResult {
  id: string;
  outcome: 'created' | 'updated' | 'unchanged';
  supersededId: string | null;
}

/**
 * Client-aware source-key create/update with one-series supersession. Callers
 * must precompute generation and embedding before opening this transaction.
 */
export async function upsertSourceKeyMemoryRevision(
  client: Pick<ScopedClient, 'query'>,
  scope: DbScope,
  input: SourceKeyMemoryRevisionInput,
): Promise<SourceKeyMemoryRevisionResult> {
  if (input.ownerKeyId !== scope.keyId || !scope.namespaces.includes(input.namespace) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.agentId)) {
    throw new Error('Source-key memory owner and namespace must match database scope');
  }
  if (!input.sourceKey.trim() || !/^[a-z][a-z0-9.-]{0,127}$/.test(input.auditAction) ||
      !input.seriesField.trim() || !input.seriesValue.trim() ||
      ((input.seriesOrderField === undefined) !== (input.seriesOrderValue === undefined)) ||
      (input.seriesOrderField !== undefined && (!input.seriesOrderField.trim() || !input.seriesOrderValue!.trim()))) {
    throw new Error('Source-key memory identity fields must be nonempty');
  }
  if (!/^[0-9a-f]{64}$/.test(input.aggregateHash) || input.metadata.aggregate_hash !== input.aggregateHash) {
    throw new Error('Source-key aggregate hash is invalid');
  }
  if (input.metadata[input.seriesField] !== input.seriesValue ||
      (input.seriesOrderField !== undefined && input.metadata[input.seriesOrderField] !== input.seriesOrderValue)) {
    throw new Error('Source-key memory series metadata does not match its identity');
  }
  if (!Number.isSafeInteger(input.embeddingDimensions) || input.embeddingDimensions < 1) {
    throw new Error('Source-key embedding dimensions are invalid');
  }

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
    `${input.ownerKeyId}\0${input.namespace}\0${input.source}`,
    `${input.seriesField}\0${input.seriesValue}`,
  ]);
  const existing = await client.query<{
    id: string; aggregate_hash: string | null; source: string; series_value: string | null;
    series_order: string | null; deleted_at: string | null;
  }>(`
    SELECT id, source, metadata->>'aggregate_hash' AS aggregate_hash,
      metadata->>$4 AS series_value,
      CASE WHEN $5::text IS NULL THEN NULL ELSE metadata->>$5 END AS series_order,
      deleted_at::text
    FROM memories
    WHERE client_id = $1::uuid AND namespace = $2 AND source_key = $3
    FOR UPDATE
  `, [input.ownerKeyId, input.namespace, input.sourceKey, input.seriesField,
    input.seriesOrderField ?? null]);
  if (existing.rows.length > 1) throw new Error('Source-key memory identity is not unique');
  const current = existing.rows[0];
  if (current && (current.source !== input.source || current.series_value !== input.seriesValue || current.deleted_at ||
      (input.seriesOrderValue !== undefined && current.series_order !== input.seriesOrderValue))) {
    throw new Error('Source-key memory identity conflicts with existing lifecycle state');
  }
  if (current && current.aggregate_hash === input.aggregateHash && !input.force) {
    return { id: current.id, outcome: 'unchanged', supersededId: null };
  }

  if (current) {
    const updated = await client.query<{ id: string }>(`
      UPDATE memories SET content = $2, embedding = $3::vector, tags = $4::text[], metadata = $5::jsonb,
        embedding_provider = $6, embedding_model = $7, embedding_dimensions = $8,
        agent_id = $9::uuid, updated_at = statement_timestamp()
      WHERE id = $1::uuid AND client_id = $10::uuid AND namespace = $11
      RETURNING id
    `, [current.id, input.content, input.embedding, input.tags, JSON.stringify(input.metadata),
      input.embeddingProvider, input.embeddingModel, input.embeddingDimensions, input.agentId,
      input.ownerKeyId, input.namespace]);
    if (updated.rows.length !== 1) throw new Error('Source-key memory changed during update');
    await logAudit({ clientId: input.ownerKeyId, action: input.auditAction, namespace: input.namespace,
      memoryId: current.id, details: { updated: 1 } }, scope, client as ScopedClient);
    return { id: current.id, outcome: 'updated', supersededId: null };
  }

  const predecessor = await client.query<{ id: string; series_order: string | null }>(`
    SELECT id, CASE WHEN $6::text IS NULL THEN NULL ELSE metadata->>$6 END AS series_order
    FROM memories
    WHERE client_id = $1::uuid AND namespace = $2 AND source = $3
      AND metadata->>$4 = $5
      AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > statement_timestamp())
      AND superseded_at IS NULL AND valid_to IS NULL AND consolidated_into_id IS NULL
    ORDER BY valid_from DESC NULLS LAST, created_at DESC, id DESC
    LIMIT 1 FOR UPDATE
  `, [input.ownerKeyId, input.namespace, input.source, input.seriesField, input.seriesValue,
    input.seriesOrderField ?? null]);
  const prior = predecessor.rows[0];
  if (prior && input.seriesOrderValue !== undefined &&
      (prior.series_order === null || prior.series_order >= input.seriesOrderValue)) {
    throw new Error('Source-key lifecycle revisions must be applied in increasing series order');
  }
  const supersededId = prior?.id ?? null;
  const clock = (await client.query<{ now: string }>(
    'SELECT statement_timestamp()::text AS now',
  )).rows[0].now;
  if (supersededId) {
    const closed = await client.query(`
      UPDATE memories SET superseded_at = $2::timestamptz, valid_to = $2::timestamptz,
        updated_at = $2::timestamptz
      WHERE id = $1::uuid AND superseded_at IS NULL AND valid_to IS NULL
    `, [supersededId, clock]);
    if (closed.rowCount !== 1) throw new Error('Prior source-key memory changed during supersession');
  }
  const inserted = await client.query<{ id: string }>(`
    INSERT INTO memories (
      content, embedding, source, namespace, tags, metadata, access_level, client_id, agent_id,
      source_key, embedding_provider, embedding_model, embedding_dimensions,
      memory_kind, valid_from, supersedes_id, created_at, updated_at
    ) VALUES ($1, $2::vector, $3, $4, $5::text[], $6::jsonb, 'normal', $7::uuid, $8::uuid,
      $9, $10, $11, $12, 'semantic', $13::timestamptz, $14::uuid, $13::timestamptz, $13::timestamptz)
    RETURNING id
  `, [input.content, input.embedding, input.source, input.namespace, input.tags,
    JSON.stringify(input.metadata), input.ownerKeyId, input.agentId, input.sourceKey,
    input.embeddingProvider, input.embeddingModel, input.embeddingDimensions, clock, supersededId]);
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error('Source-key memory insert returned no identity');
  await logAudit({ clientId: input.ownerKeyId, action: input.auditAction, namespace: input.namespace,
    memoryId: id, details: { created: 1 } }, scope, client as ScopedClient);
  return { id, outcome: 'created', supersededId };
}
