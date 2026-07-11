import { queryScoped, type DbScope } from './db.js';

export async function logAudit(params: {
  clientId: string;
  action: string;
  namespace?: string;
  memoryId?: string;
  queryText?: string;
  resultCount?: number;
  agentId?: string;
  sessionId?: string;
}, scope: DbScope): Promise<void> {
  await queryScoped(
    scope,
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
