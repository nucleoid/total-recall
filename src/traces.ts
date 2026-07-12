import { queryScoped, type DbScope } from './db.js';
import type { AuthContext, RecallTrace } from './types.js';

export async function logTrace(params: {
  sessionId?: string;
  agentId?: string;
  clientId?: string;
  queryText: string;
  memoryIds?: string[];
  resultCount?: number;
  scores?: unknown[];
  durationMs?: number;
}, scope: DbScope): Promise<void> {
  await queryScoped(
    scope,
    `INSERT INTO recall_traces (session_id, agent_id, client_id, query_text, memory_ids, result_count, scores, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.sessionId ?? null,
      params.agentId ?? null,
      params.clientId ?? null,
      params.queryText,
      params.memoryIds ?? [],
      params.resultCount ?? 0,
      JSON.stringify(params.scores ?? []),
      params.durationMs ?? null,
    ]
  );
}

export async function listTraces(
  auth: AuthContext,
  scope: DbScope,
  limit = 20,
  offset = 0,
  agentId?: string,
  sessionId?: string
): Promise<RecallTrace[]> {
  const isAdmin = auth.permissions.includes('admin');
  const conditions: string[] = ['($2::boolean OR rt.client_id = $1)'];
  const values: unknown[] = [auth.keyId, isAdmin];
  let idx = 2;
  const p = (v: unknown) => { values.push(v); return `$${++idx}`; };

  if (agentId) conditions.push(`rt.agent_id = ${p(agentId)}`);
  if (sessionId) conditions.push(`rt.session_id = ${p(sessionId)}`);

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const res = await queryScoped<RecallTrace>(
    { ...scope, isAdmin },
    `SELECT rt.*, a.name AS agent_name
     FROM recall_traces rt
     LEFT JOIN agents a ON a.id = rt.agent_id AND a.api_key_id::text = rt.client_id
     ${where}
     ORDER BY rt.created_at DESC
     LIMIT ${p(limit)} OFFSET ${p(offset)}`,
    values
  );
  return res.rows;
}

export async function getTrace(auth: AuthContext, id: string, scope: DbScope): Promise<RecallTrace | null> {
  const isAdmin = auth.permissions.includes('admin');
  const res = await queryScoped<RecallTrace>(
    { ...scope, isAdmin },
    `SELECT rt.*, a.name AS agent_name
     FROM recall_traces rt
     LEFT JOIN agents a ON a.id = rt.agent_id AND a.api_key_id::text = rt.client_id
     WHERE rt.id = $1 AND ($3::boolean OR rt.client_id = $2)`,
    [id, auth.keyId, isAdmin]
  );
  return res.rows[0] ?? null;
}

