import { query } from './db.js';
import type { Agent, AgentParams, AuthContext } from './types.js';

function allowedMemoryAccessLevels(auth: AuthContext): string[] {
  if (auth.permissions.includes('secret')) return ['normal', 'sensitive', 'secret'];
  if (auth.permissions.includes('sensitive')) return ['normal', 'sensitive'];
  return ['normal'];
}

export async function upsertAgent(params: AgentParams, auth: AuthContext): Promise<Agent> {
  let parentAgentId: string | null = null;
  if (params.parent_agent_name) {
    const parent = await getAgentByName(params.parent_agent_name, auth);
    if (parent) parentAgentId = parent.id;
  }

  const res = await query<Agent>(
    `INSERT INTO agents (name, type, model, runtime, parent_agent_id, api_key_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (api_key_id, name) DO UPDATE SET
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
      auth.keyId,
      JSON.stringify(params.metadata ?? {}),
    ]
  );
  return res.rows[0];
}

export async function getAgent(id: string, auth: AuthContext): Promise<Agent | null> {
  const res = await query<Agent>('SELECT * FROM agents WHERE id = $1 AND api_key_id = $2', [id, auth.keyId]);
  return res.rows[0] ?? null;
}

export async function getAgentByName(name: string, auth: AuthContext): Promise<Agent | null> {
  const res = await query<Agent>(
    'SELECT * FROM agents WHERE name = $1 AND api_key_id = $2',
    [name, auth.keyId]
  );
  return res.rows[0] ?? null;
}

export async function listAgents(auth: AuthContext): Promise<any[]> {
  const res = await query(
    `SELECT a.*,
       COUNT(m.id)::int AS memory_count,
       MAX(m.created_at) AS last_memory_at
     FROM agents a
     LEFT JOIN memories m ON m.agent_id = a.id
       AND m.client_id = $1
       AND m.namespace = ANY($2)
       AND m.access_level = ANY($3)
     WHERE a.api_key_id = $1
     GROUP BY a.id
     ORDER BY a.last_seen_at DESC`
    ,
    [auth.keyId, auth.namespaces, allowedMemoryAccessLevels(auth)]
  );
  return res.rows;
}

export async function resolveAgent(
  auth: AuthContext,
  agentName: string,
  agentType?: string,
  agentModel?: string,
  agentRuntime?: string,
  parentAgentName?: string
): Promise<string> {
  const agent = await upsertAgent({
    name: agentName,
    type: agentType,
    model: agentModel,
    runtime: agentRuntime,
    parent_agent_name: parentAgentName,
  }, auth);
  return agent.id;
}
