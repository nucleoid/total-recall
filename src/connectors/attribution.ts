import { query } from '../db.js';
import { upsertAgent } from '../agents.js';

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
}> {
  const keyName = process.env.MEDIA_DEFAULT_API_KEY_NAME || 'openclaw-v2';
  const keyRow = await query<{ id: string; namespaces: string[] }>(
    `SELECT id, namespaces FROM api_keys WHERE name = $1 AND enabled = true LIMIT 1`,
    [keyName]
  );
  if (keyRow.rows.length === 0) {
    throw new Error(`No enabled api_key named "${keyName}" — set MEDIA_DEFAULT_API_KEY_NAME or create one with create-key.`);
  }
  const apiKeyId = keyRow.rows[0].id;

  const agent = await upsertAgent({
    name: `${service}-connector`,
    type: 'system',
    runtime: 'cron',
    api_key_id: apiKeyId,
  });

  return { apiKeyId, agentId: agent.id };
}
