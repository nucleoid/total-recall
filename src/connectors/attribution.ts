import { query } from '../db.js';
import { setAuthContext } from '../db.js';
import { upsertAgent } from '../agents.js';
import type { AuthContext } from '../types.js';

/**
 * Resolves the api_key id and agent id that connector cron jobs should
 * attribute events and rolled-up memories to.
 *
 * Picks the api_key named `MEDIA_DEFAULT_API_KEY_NAME` (default
 * "openclaw-v2"), since that's the home agent key with the `media`
 * namespace granted. Auto-registers a per-service system agent under that
 * key so the Cortex dashboard shows where events came from.
 */
export async function resolveConnectorAttribution(service: string): Promise<{
  apiKeyId: string;
  agentId: string;
  auth: AuthContext;
}> {
  const keyName = process.env.MEDIA_DEFAULT_API_KEY_NAME || 'openclaw-v2';
  const keyRow = await query<{ id: string; name: string; namespaces: string[]; permissions: string[] }>(
    `SELECT id, name, namespaces, permissions FROM api_keys WHERE name = $1 AND enabled = true LIMIT 1`,
    [keyName]
  );
  if (keyRow.rows.length === 0) {
    throw new Error(`No enabled api_key named "${keyName}" — set MEDIA_DEFAULT_API_KEY_NAME or create one with create-key.`);
  }
  const row = keyRow.rows[0];
  const auth: AuthContext = {
    keyId: row.id,
    name: row.name,
    namespaces: row.namespaces,
    permissions: row.permissions,
  };
  await setAuthContext(auth);

  const agent = await upsertAgent({
    name: `${service}-connector`,
    type: 'system',
    runtime: 'cron',
  }, auth);

  return { apiKeyId: auth.keyId, agentId: agent.id, auth };
}
