import { queryUnscoped, type DbScope } from '../db.js';
import { upsertAgent } from '../agents.js';
import type { AuthContext } from '../types.js';

const MEDIA_NAMESPACE = 'media';
const ACTIVITY_NAMESPACE = 'activity';

type ConnectorKeyRow = {
  id: string;
  name: string;
  namespaces: string[];
  permissions: string[];
  max_access_level: AuthContext['maxAccessLevel'];
};

function mediaConnectorKeyNames(): string[] {
  const configured = process.env.MEDIA_CONNECTOR_API_KEY_NAMES ?? process.env.MEDIA_DEFAULT_API_KEY_NAME ?? 'openclaw-v2';
  return configured
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

function authFromKeyRow(row: ConnectorKeyRow): AuthContext {
  return {
    keyId: row.id,
    name: row.name,
    namespaces: row.namespaces,
    permissions: row.permissions,
    maxAccessLevel: row.max_access_level,
  };
}

function assertMediaConnectorKey(auth: AuthContext, keyName: string): void {
  if (!auth.namespaces.includes(MEDIA_NAMESPACE)) {
    throw new Error(`api_key "${keyName}" must include the media namespace for connector jobs.`);
  }
  if (!auth.permissions.includes('write')) {
    throw new Error(`api_key "${keyName}" must include write permission for connector jobs.`);
  }
}

async function loadConnectorKey(keyName: string): Promise<ConnectorKeyRow> {
  const keyRow = await queryUnscoped<ConnectorKeyRow>(
    `SELECT id, name, namespaces, permissions, max_access_level FROM api_keys WHERE name = $1 AND enabled = true LIMIT 1`,
    [keyName]
  );
  if (keyRow.rows.length === 0) {
    throw new Error(`No enabled api_key named "${keyName}" - set MEDIA_DEFAULT_API_KEY_NAME or create one with create-key.`);
  }
  return keyRow.rows[0];
}

export async function preflightConnectorKey(
  keyName: string,
  namespace: string,
  permission: string = 'write',
): Promise<AuthContext> {
  const auth = authFromKeyRow(await loadConnectorKey(keyName));
  if (!auth.namespaces.includes(namespace)) {
    throw new Error(`api_key "${keyName}" must include the ${namespace} namespace for connector jobs.`);
  }
  if (!auth.permissions.includes(permission)) {
    throw new Error(`api_key "${keyName}" must include ${permission} permission for connector jobs.`);
  }
  return auth;
}

export async function preflightMediaConnectorKeys(keyNames = mediaConnectorKeyNames()): Promise<AuthContext[]> {
  if (keyNames.length === 0) {
    throw new Error('At least one media connector api_key name is required.');
  }

  const auths: AuthContext[] = [];
  for (const keyName of keyNames) {
    const auth = authFromKeyRow(await loadConnectorKey(keyName));
    assertMediaConnectorKey(auth, keyName);
    auths.push(auth);
  }
  return auths;
}

/**
 * Resolves the api_key id and agent id that connector cron jobs should
 * attribute events and rolled-up memories to.
 *
 * Picks the first configured media connector api_key, then auto-registers a
 * per-service system agent under that key so the Cortex dashboard shows where
 * events came from.
 */
export async function resolveConnectorAttribution(service: string): Promise<{
  apiKeyId: string;
  agentId: string;
  scope: DbScope;
  auth: AuthContext;
}> {
  const [keyName] = mediaConnectorKeyNames();
  if (!keyName) {
    throw new Error('At least one media connector api_key name is required.');
  }
  const auth = (await preflightMediaConnectorKeys([keyName]))[0];
  const apiKeyId = auth.keyId;
  const scope = { keyId: apiKeyId, namespaces: auth.namespaces };

  const agent = await upsertAgent({
    name: `${service}-connector`,
    type: 'system',
    runtime: 'cron',
    api_key_id: apiKeyId,
  }, scope);

  return { apiKeyId, agentId: agent.id, scope, auth };
}

/** Resolve least-privilege ownership for private activity connectors. Dry-run
 * deliberately performs no agent registration or other mutation. */
export async function resolveActivityConnectorAttribution(
  service: string,
  dryRun = false,
): Promise<{
  apiKeyId: string;
  agentId?: string;
  scope: DbScope;
  auth: AuthContext;
}> {
  const keyName = (process.env.ACTIVITY_CONNECTOR_API_KEY_NAME ?? '').trim();
  if (!keyName) throw new Error('ACTIVITY_CONNECTOR_API_KEY_NAME is required for activity connector jobs.');
  const auth = await preflightConnectorKey(keyName, ACTIVITY_NAMESPACE, 'write');
  const scope = { keyId: auth.keyId, namespaces: auth.namespaces };
  if (dryRun) return { apiKeyId: auth.keyId, scope, auth };

  const agent = await upsertAgent({
    name: `${service}-connector`,
    type: 'system',
    runtime: 'cron',
    api_key_id: auth.keyId,
  }, scope);
  return { apiKeyId: auth.keyId, agentId: agent.id, scope, auth };
}
