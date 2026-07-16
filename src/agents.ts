import { queryScoped, queryUnscoped, withScopedClient, type DbScope, type ScopedClient } from './db.js';
import { accessLevelSql } from './auth.js';
import { logAudit } from './audit.js';
import type { Agent, AgentParams, AuthContext, SystemAgentParams } from './types.js';

function assertAgentScope(params: AgentParams, scope: DbScope): void {
  if (params.api_key_id !== scope.keyId) {
    throw new Error('Agent api_key_id must match the authenticated database scope');
  }
}

export async function upsertAgent(params: AgentParams, scope: DbScope, client?: ScopedClient): Promise<Agent> {
  assertAgentScope(params, scope);

  let parentAgentId: string | null = null;
  if (params.parent_agent_name) {
    const parent = await getAgentByName(params.parent_agent_name, scope, client);
    if (parent) parentAgentId = parent.id;
  }

  const sql = `INSERT INTO agents (name, type, model, runtime, parent_agent_id, api_key_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (api_key_id, name) WHERE api_key_id IS NOT NULL DO UPDATE SET
       type = COALESCE(EXCLUDED.type, agents.type),
       model = COALESCE(EXCLUDED.model, agents.model),
       runtime = COALESCE(EXCLUDED.runtime, agents.runtime),
       parent_agent_id = COALESCE(EXCLUDED.parent_agent_id, agents.parent_agent_id),
       metadata = agents.metadata || EXCLUDED.metadata,
       last_seen_at = NOW()
     RETURNING *`;
  const values = [
    params.name,
    params.type ?? 'llm',
    params.model ?? null,
    params.runtime ?? null,
    parentAgentId,
    params.api_key_id,
    JSON.stringify(params.metadata ?? {}),
  ];
  const res = client
    ? await client.query<Agent>(sql, values)
    : await queryScoped<Agent>(scope, sql, values);
  return res.rows[0];
}

/** Explicit user registration, audited in the same transaction as the upsert. */
export async function registerAgent(params: AgentParams, auth: AuthContext): Promise<Agent> {
  const scope: DbScope = {
    namespaces: auth.namespaces,
    keyId: auth.keyId,
    isAdmin: auth.permissions.includes('admin'),
  };
  return withScopedClient(scope, async client => {
    const agent = await upsertAgent(params, scope, client);
    await logAudit({
      clientId: auth.keyId,
      action: 'agent.register',
      resourceType: 'agent',
      resourceId: agent.id,
      agentId: agent.id,
    }, scope, client);
    return agent;
  });
}

export async function upsertSystemAgent(params: SystemAgentParams): Promise<Agent> {
  const res = await queryUnscoped<Agent>(
    'SELECT * FROM upsert_system_agent($1, $2, $3, $4, $5::jsonb)',
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

export async function getAgent(id: string, scope: DbScope): Promise<Agent | null> {
  const res = await queryScoped<Agent>(
    scope,
    'SELECT * FROM agents WHERE id = $1 AND api_key_id::text = $2',
    [id, scope.keyId]
  );
  return res.rows[0] ?? null;
}

export async function getAgentByName(name: string, scope: DbScope, client?: ScopedClient): Promise<Agent | null> {
  const sql = 'SELECT * FROM agents WHERE name = $1 AND api_key_id::text = $2';
  const values = [name, scope.keyId];
  const res = client
    ? await client.query<Agent>(sql, values)
    : await queryScoped<Agent>(scope, sql, values);
  return res.rows[0] ?? null;
}

export async function listAgents(auth: AuthContext, scope: DbScope): Promise<any[]> {
  const isAdmin = auth.permissions.includes('admin');
  const res = await queryScoped(
    { ...scope, isAdmin },
    `SELECT a.*,
       COUNT(m.id)::int AS memory_count,
       MAX(m.created_at) AS last_memory_at
     FROM agents a
     LEFT JOIN memories m ON m.agent_id = a.id
       AND m.deleted_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
       AND to_jsonb(m)->>'consolidated_into_id' IS NULL
       AND (($4::boolean AND m.client_id = a.api_key_id::text) OR (NOT $4::boolean AND m.client_id = $1))
       AND m.namespace = ANY($2)
       AND ${accessLevelSql('m.access_level', '$3')}
     WHERE ($4::boolean OR a.api_key_id::text = $1)
     GROUP BY a.id
     ORDER BY a.last_seen_at DESC`,
    [scope.keyId, auth.namespaces, auth.maxAccessLevel, isAdmin]
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
  if (!apiKeyId) {
    throw new Error('apiKeyId is required to resolve authenticated agents');
  }
  if (!scope) {
    throw new Error('Agent resolution requires an authenticated database scope');
  }
  if (apiKeyId !== scope.keyId) {
    throw new Error('apiKeyId must match the authenticated database scope');
  }

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
