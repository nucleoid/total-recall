import { query } from './db.js';
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
}): Promise<void> {
  await query(
    `INSERT INTO audit_log (client_id, action, namespace, memory_id, query_text, result_count, agent_id, session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.clientId,
      params.action,
      params.namespace ?? null,
      params.memoryId ?? null,
      params.queryText ?? null,
      params.resultCount ?? null,
      params.agentId ?? null,
      params.sessionId ?? null,
    ]
  );
}

export async function listAudit(
  auth: AuthContext,
  params: {
    limit?: number;
    offset?: number;
    action?: string;
    agentId?: string;
  } = {}
): Promise<any[]> {
  const conditions: string[] = ['al.client_id = $1'];
  const values: unknown[] = [auth.keyId];
  let idx = 1;
  const p = (v: unknown) => { values.push(v); return `$${++idx}`; };

  if (params.action) conditions.push(`al.action = ${p(params.action)}`);
  if (params.agentId) conditions.push(`al.agent_id = ${p(params.agentId)}`);

  const res = await query(
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
