import { query } from './db.js';
import type { Agent, AgentParams, SystemAgentParams } from './types.js';

export async function upsertAgent(params: AgentParams): Promise<Agent> {
  let parentAgentId: string | null = null;
  if (params.parent_agent_name) {
    const parent = await getAgentByName(params.parent_agent_name, params.api_key_id);
    if (parent) parentAgentId = parent.id;
  }

  const res = await query<Agent>(
    `INSERT INTO agents (name, type, model, runtime, parent_agent_id, api_key_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (api_key_id, name) WHERE api_key_id IS NOT NULL DO UPDATE SET
       type = COALESCE(EXCLUDED.type, agents.type),
       model = COALESCE(EXCLUDED.model, agents.model),
       runtime = COALESCE(EXCLUDED.runtime, agents.runtime),
       parent_agent_id = COALESCE(EXCLUDED.parent_agent_id, agents.parent_agent_id),
       metadata = agents.metadata || EXCLUDED.metadata,
       last_seen_at = NOW()
     RETURNING *`,
    [
      params.name,
      params.type ?? 'llm',
      params.model ?? null,
      params.runtime ?? null,
      parentAgentId,
      params.api_key_id,
      JSON.stringify(params.metadata ?? {}),
    ]
  );
  return res.rows[0];
}

export async function upsertSystemAgent(params: SystemAgentParams): Promise<Agent> {
  const res = await query<Agent>(
    `INSERT INTO agents (name, type, model, runtime, parent_agent_id, api_key_id, metadata)
     VALUES ($1, $2, $3, $4, NULL, NULL, $5)
     ON CONFLICT (name) WHERE api_key_id IS NULL DO UPDATE SET
       type = COALESCE(EXCLUDED.type, agents.type),
       model = COALESCE(EXCLUDED.model, agents.model),
       runtime = COALESCE(EXCLUDED.runtime, agents.runtime),
       metadata = agents.metadata || EXCLUDED.metadata,
       last_seen_at = NOW()
     RETURNING *`,
    [
      params.name,
      params.type ?? 'system',
      params.model ?? null,
      params.runtime ?? null,
      JSON.stringify(params.metadata ?? {}),
    ]
  );
  return res.rows[0];
}

export async function getAgent(id: string, apiKeyId: string): Promise<Agent | null> {
  const res = await query<Agent>('SELECT * FROM agents WHERE id = $1 AND api_key_id = $2', [id, apiKeyId]);
  return res.rows[0] ?? null;
}

export async function getAgentByName(name: string, apiKeyId: string): Promise<Agent | null> {
  const res = await query<Agent>('SELECT * FROM agents WHERE name = $1 AND api_key_id = $2', [name, apiKeyId]);
  return res.rows[0] ?? null;
}

export async function listAgents(apiKeyId: string): Promise<any[]> {
  const res = await query(
    `SELECT a.*,
       COUNT(m.id)::int AS memory_count,
       MAX(m.created_at) AS last_memory_at
     FROM agents a
     LEFT JOIN memories m ON m.agent_id = a.id
     WHERE a.api_key_id = $1
     GROUP BY a.id
     ORDER BY a.last_seen_at DESC`,
    [apiKeyId]
  );
  return res.rows;
}

export async function resolveAgent(
  agentName: string,
  agentType?: string,
  agentModel?: string,
  agentRuntime?: string,
  parentAgentName?: string,
  apiKeyId?: string
): Promise<string> {
  if (!apiKeyId) {
    throw new Error('apiKeyId is required to resolve authenticated agents');
  }
  const agent = await upsertAgent({
    name: agentName,
    type: agentType,
    model: agentModel,
    runtime: agentRuntime,
    parent_agent_name: parentAgentName,
    api_key_id: apiKeyId,
  });
  return agent.id;
}
