import { queryScoped, type DbScope, type ScopedClient } from './db.js';
import type { AuthContext } from './types.js';

export async function logAudit(params: {
  clientId: string;
  action: string;
  namespace?: string;
  memoryId?: string;
  queryText?: string;
  resultCount?: number;
  agentId?: string;
  sessionId?: string;
  resourceType?: 'memory' | 'document' | 'agent' | 'search' | 'subscription' | 'session' | 'system';
  resourceId?: string;
  /** Call-site-owned, allowlisted metadata only; never request serialization. */
  details?: Record<string, string | number | boolean | null>;
}, scope: DbScope, client?: ScopedClient): Promise<void> {
  const details = params.details ?? {};
  const allowedDetailKeys = new Set(['created', 'deduplicated', 'idempotent', 'chunks']);
  const unapprovedDetailKey = Object.keys(details).find(key => !allowedDetailKeys.has(key));
  if (unapprovedDetailKey) throw new Error(`Unapproved audit detail key: ${unapprovedDetailKey}`);
  const sql = `INSERT INTO audit_log
       (client_id, action, namespace, memory_id, query_text, result_count, agent_id, session_id,
        resource_type, resource_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`;
  const values = [
    params.clientId,
    params.action,
    params.namespace ?? null,
    params.memoryId ?? null,
    params.queryText ?? null,
    params.resultCount ?? null,
    params.agentId ?? null,
    params.sessionId ?? null,
    params.resourceType ?? (params.memoryId ? 'memory' : null),
    params.resourceId ?? params.memoryId ?? null,
    JSON.stringify(details),
  ];
  if (client) {
    await client.query(sql, values);
  } else {
    await queryScoped(scope, sql, values);
  }
}

export async function listAudit(
  auth: AuthContext,
  scope: DbScope,
  params: {
    limit?: number;
    offset?: number;
    action?: string;
    agentId?: string;
  } = {}
): Promise<any[]> {
  // Audit visibility is key-private even for admin credentials.
  const conditions: string[] = ['al.client_id = $1'];
  const values: unknown[] = [auth.keyId];
  let idx = 1;
  const p = (v: unknown) => { values.push(v); return `$${++idx}`; };

  if (params.action) conditions.push(`al.action = ${p(params.action)}`);
  if (params.agentId) conditions.push(`al.agent_id = ${p(params.agentId)}`);

  const res = await queryScoped(
    { ...scope, isAdmin: false },
    `SELECT al.*, a.name AS agent_name
     FROM audit_log al
     LEFT JOIN agents a ON a.id = al.agent_id AND a.api_key_id::text = al.client_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY al.created_at DESC
     LIMIT ${p(params.limit ?? 50)} OFFSET ${p(params.offset ?? 0)}`,
    values
  );
  return res.rows;
}
