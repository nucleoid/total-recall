import { queryScoped, queryUnscoped, type DbScope } from './db.js';
import type { Agent, AgentParams } from './types.js';

export async function upsertAgent(params: AgentParams, scope?: DbScope): Promise<Agent> {
  let parentAgentId: string | null = null;
  if (params.parent_agent_name) {
    const parent = await getAgentByName(params.parent_agent_name, scope);
    if (parent) parentAgentId = parent.id;
  }

  const sql = `INSERT INTO agents (name, type, model, runtime, parent_agent_id, api_key_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (name) DO UPDATE SET
       type = COALESCE(EXCLUDED.type, agents.type),
       model = COALESCE(EXCLUDED.model, agents.model),
       runtime = COALESCE(EXCLUDED.runtime, agents.runtime),
       parent_agent_id = COALESCE(EXCLUDED.parent_agent_id, agents.parent_agent_id),
       api_key_id = COALESCE(EXCLUDED.api_key_id, agents.api_key_id),
       metadata = agents.metadata || EXCLUDED.metadata,
       last_seen_at = NOW()
     RETURNING *`;
  const values = [
    params.name,
    params.type ?? 'llm',
    params.model ?? null,
    params.runtime ?? null,
    parentAgentId,
    params.api_key_id ?? null,
    JSON.stringify(params.metadata ?? {}),
  ];
  const res = scope
    ? await queryScoped<Agent>(scope, sql, values)
    : await queryUnscoped<Agent>(sql, values);
  return res.rows[0];
}

export async function getAgent(id: string, scope?: DbScope): Promise<Agent | null> {
  const res = scope
    ? await queryScoped<Agent>(scope, 'SELECT * FROM agents WHERE id = $1', [id])
    : await queryUnscoped<Agent>('SELECT * FROM agents WHERE id = $1', [id]);
  return res.rows[0] ?? null;
}

export async function getAgentByName(name: string, scope?: DbScope): Promise<Agent | null> {
  const res = scope
    ? await queryScoped<Agent>(scope, 'SELECT * FROM agents WHERE name = $1', [name])
    : await queryUnscoped<Agent>('SELECT * FROM agents WHERE name = $1', [name]);
  return res.rows[0] ?? null;
}

export async function listAgents(scope: DbScope): Promise<any[]> {
  const res = await queryScoped(
    scope,
    `SELECT a.*,
       COUNT(m.id)::int AS memory_count,
       MAX(m.created_at) AS last_memory_at
     FROM agents a
     LEFT JOIN memories m ON m.agent_id = a.id
     GROUP BY a.id
     ORDER BY a.last_seen_at DESC`
  );
  return res.rows;
}

export async function resolveAgent(
  agentName: string,
  agentType?: string,
  agentModel?: string,
  agentRuntime?: string,
  parentAgentName?: string,
  apiKeyId?: string,
  scope?: DbScope
): Promise<string> {
  const agent = await upsertAgent({
    name: agentName,
    type: agentType,
    model: agentModel,
    runtime: agentRuntime,
    parent_agent_name: parentAgentName,
    api_key_id: apiKeyId,
  }, scope);
  return agent.id;
}
