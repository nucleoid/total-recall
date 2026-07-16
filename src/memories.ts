import { accessLevelSql, checkPermission, filterNamespaces } from './auth.js';
import { dbScopeFromAuth, queryScoped } from './db.js';
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
