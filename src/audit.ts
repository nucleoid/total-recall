import { query } from './db.js';

export async function logAudit(params: {
  clientId: string;
  action: string;
  namespace?: string;
  memoryId?: string;
  queryText?: string;
  resultCount?: number;
}): Promise<void> {
  await query(
    `INSERT INTO audit_log (client_id, action, namespace, memory_id, query_text, result_count) 
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [params.clientId, params.action, params.namespace ?? null, params.memoryId ?? null, params.queryText ?? null, params.resultCount ?? null]
  );
}
