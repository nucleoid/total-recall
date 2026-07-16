import { createHash, randomBytes } from 'node:crypto';
import type { AuthContext } from './types.js';
import { checkPermission } from './auth.js';
import { dbScopeFromAuth, withScopedClient, type DbScope, type ScopedClient } from './db.js';
import { embed, embeddingDescriptorParams, serializeEmbeddingVector } from './embedding.js';
import { logAudit } from './audit.js';
import {
  canonicalJson,
  decryptValue,
  encryptValue,
  normalizeWebhookUrl,
  parseEncryptionKeyRing,
  redactWebhookUrl,
  resolveWebhookDestination,
  type EncryptionKeyRing,
  type EncryptedValue,
} from './webhooks.js';

export const SUBSCRIPTION_QUERY_MAX_CHARS = 8192;
export const SUBSCRIPTION_MAX_NAMESPACES = 100;
export const SUBSCRIPTION_DEFAULT_THRESHOLD = 0.75;
export const WEBHOOK_MAX_ATTEMPTS = 6;

export interface CreateSubscriptionParams {
  query: string;
  webhook_url: string;
  namespaces?: string[];
  threshold?: number;
  exclude_self?: boolean;
  idempotency_key: string;
  agent_name?: string;
}
export interface SubscriptionSummary {
  id: string;
  query: string;
  webhook_url: string;
  namespaces: string[];
  threshold: number;
  exclude_self: boolean;
  status: 'active' | 'disabled';
  created_at: Date;
  disabled_at: Date | null;
  deliveries: { pending: number; delivered: number; dead: number; cancelled: number };
}
export interface CreatedSubscription extends SubscriptionSummary { signing_secret: string; idempotency_key_honored: true }

function configuredRing(): EncryptionKeyRing {
  return parseEncryptionKeyRing(process.env.WEBHOOK_ENCRYPTION_KEYS);
}

function assertCreationEnabled(): void {
  if (process.env.MEMORY_SUBSCRIPTION_CREATION_ENABLED !== 'true') {
    throw new Error('Memory subscription creation is disabled by operator policy');
  }
}

export async function createSubscription(params: CreateSubscriptionParams, auth: AuthContext): Promise<CreatedSubscription> {
  checkPermission(auth, 'write');
  assertCreationEnabled();
  if (!params.query || params.query.length > SUBSCRIPTION_QUERY_MAX_CHARS) throw new Error('Subscription query must contain 1 to 8192 characters');
  if (!params.idempotency_key || params.idempotency_key.length > 512) throw new Error('Subscription idempotency key must contain 1 to 512 characters');
  const ring = configuredRing();
  const url = normalizeWebhookUrl(params.webhook_url);
  const namespaces = [...new Set(params.namespaces?.length ? params.namespaces : auth.namespaces)].sort();
  if (namespaces.length < 1 || namespaces.length > SUBSCRIPTION_MAX_NAMESPACES) throw new Error('A subscription requires 1 to 100 namespaces');
  if (namespaces.some(namespace => !namespace.trim() || namespace.includes(','))) throw new Error('Subscription namespaces must be nonblank and cannot contain commas');
  const initiallyDenied = namespaces.find(namespace => !auth.namespaces.includes(namespace));
  if (initiallyDenied) throw new Error(`Access denied to namespace '${initiallyDenied}'`);
  const threshold = params.threshold ?? SUBSCRIPTION_DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('Subscription threshold must be between 0 and 1');
  const excludeSelf = params.exclude_self ?? true;
  const requestHash = createHash('sha256').update(canonicalJson({
    version: 1, query: params.query, webhook_url: url.toString(), namespaces,
    threshold, exclude_self: excludeSelf, agent_name: params.agent_name ?? null,
  })).digest('hex');
  // Recover a lost create response without another DNS/provider dependency.
  const replay = await withScopedClient(dbScopeFromAuth(auth), async client => {
    const existing = await client.query<{ id: string; request_hash: string }>(
      'SELECT id, request_hash FROM memory_subscriptions WHERE api_key_id = $1::uuid AND idempotency_key = $2',
      [auth.keyId, params.idempotency_key]);
    if (!existing.rows[0]) return null;
    if (existing.rows[0].request_hash !== requestHash) throw new Error('Subscription idempotency key was reused with a different request');
    return loadCreatedSubscription(client, auth.keyId, existing.rows[0].id, ring);
  });
  if (replay) return replay;
  // Registration validation is intentionally repeated by the worker before every attempt.
  await resolveWebhookDestination(url.toString());
  const vector = serializeEmbeddingVector(await embed(params.query));
  const signingSecret = randomBytes(32).toString('base64url');
  const encryptedUrl = encryptValue(url.toString(), ring, 'webhook-url');
  const encryptedSecret = encryptValue(signingSecret, ring, 'signing-secret');

  return withScopedClient(dbScopeFromAuth(auth), async client => {
    const currentKey = await client.query<{ namespaces: string[]; enabled: boolean; permissions: string[] }>(
      'SELECT namespaces, enabled, permissions FROM api_keys WHERE id = $1::uuid FOR SHARE', [auth.keyId]);
    const key = currentKey.rows[0];
    if (!key?.enabled || !key.permissions.includes('write')) throw new Error('Subscription owner key is disabled or no longer writable');
    const denied = namespaces.find(namespace => !key.namespaces.includes(namespace));
    if (denied) throw new Error(`Access denied to namespace '${denied}'`);

    let agentId: string | null = null;
    if (params.agent_name) {
      const agent = await client.query<{ id: string }>(
        'SELECT id FROM agents WHERE api_key_id = $1::uuid AND name = $2 LIMIT 1', [auth.keyId, params.agent_name]);
      if (!agent.rows[0]) throw new Error('Subscription agent is not registered to the authenticated key');
      agentId = agent.rows[0].id;
    }
    const descriptor = embeddingDescriptorParams();
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO memory_subscriptions (
        api_key_id, created_by_agent_id, query_text, query_embedding,
        embedding_provider, embedding_model, embedding_dimensions, threshold, exclude_self,
        webhook_url_ciphertext, webhook_url_iv, webhook_url_tag,
        signing_secret_ciphertext, signing_secret_iv, signing_secret_tag,
        encryption_key_id, idempotency_key, request_hash
      ) VALUES ($1::uuid, $2::uuid, $3, $4::vector, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT (api_key_id, idempotency_key) DO NOTHING
      RETURNING id
    `, [auth.keyId, agentId, params.query, vector, ...descriptor, threshold, excludeSelf,
      encryptedUrl.ciphertext, encryptedUrl.iv, encryptedUrl.tag,
      encryptedSecret.ciphertext, encryptedSecret.iv, encryptedSecret.tag,
      ring.currentId, params.idempotency_key, requestHash]);

    let id = inserted.rows[0]?.id;
    if (id) {
      for (const namespace of namespaces) {
        await client.query('INSERT INTO subscription_namespaces (subscription_id, api_key_id, namespace) VALUES ($1::uuid, $2::uuid, $3)',
          [id, auth.keyId, namespace]);
      }
      await logAudit({ clientId: auth.keyId, action: 'subscription.create', resultCount: namespaces.length }, dbScopeFromAuth(auth), client);
    } else {
      const existing = await client.query<{ id: string; request_hash: string }>(
        'SELECT id, request_hash FROM memory_subscriptions WHERE api_key_id = $1::uuid AND idempotency_key = $2 FOR SHARE',
        [auth.keyId, params.idempotency_key]);
      if (!existing.rows[0]) throw new Error('Subscription idempotency conflict is not visible to this owner');
      if (existing.rows[0].request_hash !== requestHash) throw new Error('Subscription idempotency key was reused with a different request');
      id = existing.rows[0].id;
    }
    return loadCreatedSubscription(client, auth.keyId, id, ring);
  });
}

export async function listSubscriptions(auth: AuthContext): Promise<SubscriptionSummary[]> {
  checkPermission(auth, 'read');
  const ring = configuredRing();
  return withScopedClient(dbScopeFromAuth(auth), async client => {
    const rows = await subscriptionRows(client, auth.keyId);
    return rows.map(row => summaryFromRow(row, ring));
  });
}

export async function disableSubscription(id: string, auth: AuthContext): Promise<{ id: string; status: 'disabled'; cancelled: number }> {
  checkPermission(auth, 'write');
  return withScopedClient(dbScopeFromAuth(auth), async client => {
    const disabled = await client.query(`
      UPDATE memory_subscriptions SET status = 'disabled', disabled_at = COALESCE(disabled_at, statement_timestamp()),
        updated_at = statement_timestamp()
      WHERE id = $1::uuid AND api_key_id = $2::uuid
      RETURNING id
    `, [id, auth.keyId]);
    if (!disabled.rows[0]) throw new Error('Subscription not found');
    const cancelled = await client.query(`
      UPDATE webhook_deliveries SET status = 'cancelled', locked_at = NULL,
        last_error_code = 'subscription_disabled', updated_at = statement_timestamp()
      WHERE subscription_id = $1::uuid AND api_key_id = $2::uuid
        AND status IN ('pending', 'retry', 'processing')
    `, [id, auth.keyId]);
    await logAudit({ clientId: auth.keyId, action: 'subscription.disable', resultCount: cancelled.rowCount ?? 0 }, dbScopeFromAuth(auth), client);
    return { id, status: 'disabled' as const, cancelled: cancelled.rowCount ?? 0 };
  });
}

type SubscriptionRow = {
  id: string; query_text: string; threshold: number; exclude_self: boolean; status: 'active' | 'disabled';
  created_at: Date; disabled_at: Date | null; namespaces: string[];
  webhook_url_ciphertext: Buffer; webhook_url_iv: Buffer; webhook_url_tag: Buffer;
  signing_secret_ciphertext: Buffer; signing_secret_iv: Buffer; signing_secret_tag: Buffer;
  encryption_key_id: string; pending: number; delivered: number; dead: number; cancelled: number;
};

async function subscriptionRows(client: ScopedClient, keyId: string, id?: string): Promise<SubscriptionRow[]> {
  const result = await client.query<SubscriptionRow>(`
    SELECT s.id, s.query_text, s.threshold, s.exclude_self, s.status, s.created_at, s.disabled_at,
      s.webhook_url_ciphertext, s.webhook_url_iv, s.webhook_url_tag,
      s.signing_secret_ciphertext, s.signing_secret_iv, s.signing_secret_tag, s.encryption_key_id,
      COALESCE(array_agg(DISTINCT sn.namespace ORDER BY sn.namespace) FILTER (WHERE sn.namespace IS NOT NULL), '{}') AS namespaces,
      count(DISTINCT d.id) FILTER (WHERE d.status IN ('pending','processing','retry'))::int AS pending,
      count(DISTINCT d.id) FILTER (WHERE d.status = 'delivered')::int AS delivered,
      count(DISTINCT d.id) FILTER (WHERE d.status = 'dead')::int AS dead,
      count(DISTINCT d.id) FILTER (WHERE d.status = 'cancelled')::int AS cancelled
    FROM memory_subscriptions s
    LEFT JOIN subscription_namespaces sn ON sn.subscription_id = s.id AND sn.api_key_id = s.api_key_id
    LEFT JOIN webhook_deliveries d ON d.subscription_id = s.id AND d.api_key_id = s.api_key_id
    WHERE s.api_key_id = $1::uuid AND ($2::uuid IS NULL OR s.id = $2::uuid)
    GROUP BY s.id
    ORDER BY s.created_at DESC, s.id
  `, [keyId, id ?? null]);
  return result.rows;
}

function encrypted(row: SubscriptionRow, prefix: 'webhook_url' | 'signing_secret'): EncryptedValue {
  return { keyId: row.encryption_key_id, ciphertext: row[`${prefix}_ciphertext`], iv: row[`${prefix}_iv`], tag: row[`${prefix}_tag`] };
}
function summaryFromRow(row: SubscriptionRow, ring: EncryptionKeyRing): SubscriptionSummary {
  const rawUrl = decryptValue(encrypted(row, 'webhook_url'), ring, 'webhook-url');
  return { id: row.id, query: row.query_text, webhook_url: redactWebhookUrl(rawUrl), namespaces: row.namespaces,
    threshold: row.threshold, exclude_self: row.exclude_self, status: row.status, created_at: row.created_at,
    disabled_at: row.disabled_at, deliveries: { pending: row.pending, delivered: row.delivered, dead: row.dead, cancelled: row.cancelled } };
}
async function loadCreatedSubscription(client: ScopedClient, keyId: string, id: string, ring: EncryptionKeyRing): Promise<CreatedSubscription> {
  const row = (await subscriptionRows(client, keyId, id))[0];
  if (!row) throw new Error('Subscription was not found after creation');
  return { ...summaryFromRow(row, ring), signing_secret: decryptValue(encrypted(row, 'signing_secret'), ring, 'signing-secret'), idempotency_key_honored: true };
}

export interface ClaimedDelivery { id: string; eventId: string; subscriptionId: string; ownerKeyId: string; attempts: number }
export async function claimWebhookDelivery(client: ScopedClient): Promise<ClaimedDelivery | null> {
  const result = await client.query<{ id: string; event_id: string; subscription_id: string; api_key_id: string; attempts: number }>(`
    WITH candidate AS (
      SELECT id FROM webhook_deliveries
      WHERE ((status IN ('pending','retry') AND next_attempt_at <= statement_timestamp())
        OR (status = 'processing' AND locked_at < statement_timestamp() - interval '5 minutes'))
      ORDER BY next_attempt_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE webhook_deliveries d SET status = 'processing', attempts = attempts + 1,
      locked_at = statement_timestamp(), last_error_code = NULL, updated_at = statement_timestamp()
    FROM candidate WHERE d.id = candidate.id
    RETURNING d.id, d.event_id, d.subscription_id, d.api_key_id, d.attempts
  `);
  const row = result.rows[0];
  return row ? { id: row.id, eventId: row.event_id, subscriptionId: row.subscription_id, ownerKeyId: row.api_key_id, attempts: row.attempts } : null;
}

export interface AuthorizedDelivery {
  deliveryId: string; eventId: string; subscriptionId: string; ownerKeyId: string; memoryId: string;
  namespace: string; memoryCreatedAt: Date; similarity: number; eventCreatedAt: Date;
  encryptedUrl: EncryptedValue; encryptedSecret: EncryptedValue;
}
export async function loadAuthorizedDelivery(client: ScopedClient, deliveryId: string): Promise<AuthorizedDelivery | null> {
  const result = await client.query<any>(`
    SELECT d.id, d.event_id, d.subscription_id, d.api_key_id, d.memory_id, d.namespace,
      d.similarity, d.created_at AS event_created_at, m.created_at AS memory_created_at,
      s.webhook_url_ciphertext, s.webhook_url_iv, s.webhook_url_tag,
      s.signing_secret_ciphertext, s.signing_secret_iv, s.signing_secret_tag, s.encryption_key_id
    FROM webhook_deliveries d
    JOIN memory_subscriptions s ON s.id = d.subscription_id AND s.api_key_id = d.api_key_id
    JOIN subscription_namespaces sn ON sn.subscription_id = s.id AND sn.api_key_id = s.api_key_id AND sn.namespace = d.namespace
    JOIN api_keys k ON k.id = s.api_key_id
    JOIN memories m ON m.id = d.memory_id AND m.namespace = d.namespace
    WHERE d.id = $1::uuid AND d.status = 'processing' AND s.status = 'active'
      AND s.access_level_policy = 'normal' AND k.enabled = true AND 'read' = ANY(k.permissions)
      AND d.namespace = ANY(k.namespaces) AND COALESCE(m.access_level, 'normal') = 'normal'
      AND (NOT s.exclude_self OR m.client_id <> s.api_key_id::text)
      AND m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.valid_to IS NULL
      AND (m.valid_from IS NULL OR m.valid_from <= statement_timestamp())
      AND m.consolidated_into_id IS NULL
    FOR SHARE OF s, k, m
  `, [deliveryId]);
  const row = result.rows[0];
  if (!row) return null;
  return { deliveryId: row.id, eventId: row.event_id, subscriptionId: row.subscription_id,
    ownerKeyId: row.api_key_id, memoryId: row.memory_id, namespace: row.namespace,
    memoryCreatedAt: row.memory_created_at, similarity: row.similarity, eventCreatedAt: row.event_created_at,
    encryptedUrl: { keyId: row.encryption_key_id, ciphertext: row.webhook_url_ciphertext, iv: row.webhook_url_iv, tag: row.webhook_url_tag },
    encryptedSecret: { keyId: row.encryption_key_id, ciphertext: row.signing_secret_ciphertext, iv: row.signing_secret_iv, tag: row.signing_secret_tag } };
}

export function buildWebhookPayload(delivery: AuthorizedDelivery): {
  event_id: string;
  memory: { created_at: string; id: string; namespace: string };
  subscription_id: string;
  type: 'memory.stored';
  version: 1;
} {
  return {
    event_id: delivery.eventId,
    memory: { created_at: delivery.memoryCreatedAt.toISOString(), id: delivery.memoryId, namespace: delivery.namespace },
    subscription_id: delivery.subscriptionId,
    type: 'memory.stored',
    version: 1,
  };
}

export async function cancelUnauthorizedDelivery(client: ScopedClient, id: string): Promise<boolean> {
  const result = await client.query(`UPDATE webhook_deliveries SET status = 'cancelled', locked_at = NULL,
    last_error_code = 'authorization_revoked', updated_at = statement_timestamp()
    WHERE id = $1::uuid AND status = 'processing'`, [id]);
  return result.rowCount === 1;
}
export async function deliveryStillAuthorized(client: ScopedClient, id: string): Promise<boolean> {
  return (await loadAuthorizedDelivery(client, id)) !== null;
}
export async function markDeliveryDelivered(client: ScopedClient, delivery: AuthorizedDelivery, status: number): Promise<boolean> {
  const result = await client.query(`UPDATE webhook_deliveries SET status = 'delivered', delivered_at = statement_timestamp(),
    locked_at = NULL, last_http_status = $2, last_error_code = NULL, updated_at = statement_timestamp()
    WHERE id = $1::uuid AND status = 'processing'`, [delivery.deliveryId, status]);
  return result.rowCount === 1;
}
export async function markDeliveryFailed(client: ScopedClient, delivery: AuthorizedDelivery, options: {
  errorCode: string; httpStatus?: number; retryAt?: Date; terminal: boolean;
}): Promise<boolean> {
  if (!/^[a-z0-9_.-]{1,64}$/.test(options.errorCode)) throw new Error('Invalid content-free webhook error code');
  const terminal = options.terminal;
  const result = await client.query(`UPDATE webhook_deliveries SET status = $2, next_attempt_at = COALESCE($3, next_attempt_at),
    locked_at = NULL, last_http_status = $4, last_error_code = $5, updated_at = statement_timestamp()
    WHERE id = $1::uuid AND status = 'processing'`,
    [delivery.deliveryId, terminal ? 'dead' : 'retry', options.retryAt ?? null, options.httpStatus ?? null, options.errorCode]);
  return result.rowCount === 1;
}

export function webhookWorkerScope(auth: AuthContext): DbScope {
  if (!auth.permissions.includes('admin') || !auth.permissions.includes('read')) {
    throw new Error('Webhook worker requires a dedicated API key with admin and read permissions');
  }
  return dbScopeFromAuth(auth);
}
