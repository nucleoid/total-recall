import type { DbScope, ScopedClient } from '../db.js';
import type { ConnectorStoredState } from './types.js';

export interface ConnectorStateRow {
  service: string;
  source_id: string;
  namespace: string;
  client_id: string;
  last_sync_at: Date | null;
  last_event_at: Date | null;
  cursor: string | null;
  metadata: Record<string, unknown>;
  updated_at: Date;
}

export async function acquireConnectorSourceLock(
  client: ScopedClient,
  scope: DbScope,
  service: string,
  sourceId: string,
  namespace: string,
): Promise<void> {
  assertIdentity(service, sourceId, namespace);
  const result = await client.query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
    [lockIdentity(scope, service, sourceId, namespace)],
  );
  if (result.rows[0]?.acquired !== true) {
    throw new Error(`Connector source is already syncing: ${service}/${sourceId}`);
  }
}

export async function releaseConnectorSourceLock(
  client: ScopedClient,
  scope: DbScope,
  service: string,
  sourceId: string,
  namespace: string,
): Promise<void> {
  const result = await client.query<{ released: boolean }>(
    `SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released`,
    [lockIdentity(scope, service, sourceId, namespace)],
  );
  if (result.rows[0]?.released !== true) {
    throw new Error(`Connector source lock was not held: ${service}/${sourceId}`);
  }
}

export async function lockConnectorState(
  client: ScopedClient,
  scope: DbScope,
  service: string,
  sourceId: string,
  namespace: string,
): Promise<ConnectorStateRow> {
  assertIdentity(service, sourceId, namespace);
  if (scope.keyId.trim() === '' || !scope.namespaces.includes(namespace)) {
    throw new Error(`Connector source requires authorized namespace "${namespace}"`);
  }

  // Transaction-scoped and source-specific: a second worker cannot fetch from
  // the same cursor while this page is in flight.
  const lock = await client.query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired`,
    [lockIdentity(scope, service, sourceId, namespace)],
  );
  if (lock.rows[0]?.acquired !== true) {
    throw new Error(`Connector source is already syncing: ${service}/${sourceId}`);
  }

  await client.query(
    `INSERT INTO connector_sync_state
       (service, source_id, namespace, client_id, metadata, updated_at)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, statement_timestamp())
     ON CONFLICT (client_id, namespace, service, source_id) DO NOTHING`,
    [service, sourceId, namespace, scope.keyId],
  );
  const result = await client.query<ConnectorStateRow>(
    `SELECT * FROM connector_sync_state
     WHERE client_id = $1 AND namespace = $2 AND service = $3 AND source_id = $4
     FOR UPDATE`,
    [scope.keyId, namespace, service, sourceId],
  );
  if (!result.rows[0]) throw new Error(`Unable to lock connector state for ${service}/${sourceId}`);
  return result.rows[0];
}

export async function readConnectorStateRowWithClient(
  client: Pick<ScopedClient, 'query'>,
  scope: DbScope,
  service: string,
  sourceId: string,
  namespace: string,
): Promise<ConnectorStateRow | null> {
  assertIdentity(service, sourceId, namespace);
  const result = await client.query<ConnectorStateRow>(
    `SELECT * FROM connector_sync_state
     WHERE client_id = $1 AND namespace = $2 AND service = $3 AND source_id = $4`,
    [scope.keyId, namespace, service, sourceId],
  );
  return result.rows[0] ?? null;
}

export async function readConnectorStateWithClient(
  client: Pick<ScopedClient, 'query'>,
  scope: DbScope,
  service: string,
  sourceId: string,
  namespace: string,
): Promise<ConnectorStoredState> {
  assertIdentity(service, sourceId, namespace);
  const row = await readConnectorStateRowWithClient(client, scope, service, sourceId, namespace);
  return {
    cursor: row?.cursor ?? null,
    lastEventAt: row?.last_event_at ?? null,
    metadata: row?.metadata ?? {},
  };
}

export async function advanceConnectorState(
  client: ScopedClient,
  scope: DbScope,
  service: string,
  sourceId: string,
  namespace: string,
  page: { cursor: string | null; lastEventAt?: Date | null; metadata?: Record<string, unknown> },
): Promise<void> {
  const result = await client.query(
    `UPDATE connector_sync_state
     SET cursor = $5,
         last_event_at = COALESCE($6, last_event_at),
         last_sync_at = statement_timestamp(),
         metadata = COALESCE($7::jsonb, metadata),
         updated_at = statement_timestamp()
     WHERE client_id = $1 AND namespace = $2 AND service = $3 AND source_id = $4`,
    [
      scope.keyId,
      namespace,
      service,
      sourceId,
      page.cursor,
      page.lastEventAt ?? null,
      page.metadata === undefined ? null : JSON.stringify(page.metadata),
    ],
  );
  if (result.rowCount !== 1) throw new Error(`Unable to advance connector state for ${service}/${sourceId}`);
}

function lockIdentity(scope: DbScope, service: string, sourceId: string, namespace: string): string {
  return `connector:${scope.keyId}:${namespace}:${service}:${sourceId}`;
}

function assertIdentity(service: string, sourceId: string, namespace: string): void {
  if (!service.trim() || !sourceId.trim() || !namespace.trim()) {
    throw new Error('Connector service, source_id, and namespace must be nonblank');
  }
  if (service.length > 128 || sourceId.length > 512 || namespace.length > 512) {
    throw new Error('Connector service/source/namespace exceeds its maximum length');
  }
}
