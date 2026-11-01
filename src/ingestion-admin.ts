import { checkPermission } from './auth.js';
import { logAudit } from './audit.js';
import { dbScopeFromAuth, withScopedClient } from './db.js';
import {
  ingestionQueueEnabled,
  ingestionStats,
  requeueIngestionJob,
  setIngestionPaused,
  type IngestionStats,
  type RequeuedIngestionJob,
} from './ingestion.js';
import type { AuthContext } from './types.js';

/**
 * Admin-only REST operations over the durable ingestion queue. Every function
 * checks permissions before opening a scoped transaction, mirrors the
 * memoryStats pattern, and is content-free by construction: the job table has
 * no content columns and these paths never join memories.
 */

export interface IngestionStatsResponse extends IngestionStats {
  /** Whether MEMORY_INGESTION_QUEUE_ENABLED is on for this API process. */
  enabled: boolean;
}

export interface IngestionRequeueResponse extends RequeuedIngestionJob {
  /** The job's state after the reset; the worker claims it at its next poll. */
  status: 'pending';
}

export interface IngestionPauseState {
  paused: boolean;
}

/**
 * Queue aggregates bounded by the key's RLS scope. Stays available with the
 * gate off so an operator can watch a drain or a rollback; `enabled` reports
 * the gate so the dashboard can label the panel honestly.
 */
export async function getIngestionStats(auth: AuthContext): Promise<IngestionStatsResponse> {
  checkPermission(auth, 'admin');
  checkPermission(auth, 'read');
  const stats = await withScopedClient(dbScopeFromAuth(auth), client => ingestionStats(client), { readOnly: true });
  return { enabled: ingestionQueueEnabled(), ...stats };
}

/**
 * Reset an embedding_failed or cancelled job to pending. The primitive writes
 * the content-free ingestion.requeue audit row in the same transaction and
 * throws the 404/409 public errors that sendApiError maps to HTTP.
 */
export async function requeueIngestion(auth: AuthContext, memoryId: string): Promise<IngestionRequeueResponse> {
  checkPermission(auth, 'admin');
  checkPermission(auth, 'write');
  const requeued = await withScopedClient(dbScopeFromAuth(auth), client =>
    requeueIngestionJob(client, memoryId, { keyId: auth.keyId }));
  return { ...requeued, status: 'pending' };
}

/**
 * Flip instance_settings.ingestion_paused. A running worker observes the flag
 * at its next poll; in-flight jobs finish and the inline fast path is
 * unaffected. Audited as ingestion.pause / ingestion.resume on the system
 * resource in the same transaction as the flip.
 */
export async function setIngestionPausedByAdmin(auth: AuthContext, paused: boolean): Promise<IngestionPauseState> {
  checkPermission(auth, 'admin');
  checkPermission(auth, 'write');
  const scope = dbScopeFromAuth(auth);
  return withScopedClient(scope, async client => {
    const current = await setIngestionPaused(client, paused);
    await logAudit({
      clientId: auth.keyId,
      action: paused ? 'ingestion.pause' : 'ingestion.resume',
      resourceType: 'system',
    }, scope, client);
    return { paused: current };
  });
}
