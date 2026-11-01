import { z } from 'zod';
import { dbScopeFromAuth, queryScoped } from '../db.js';
import type { AuthContext, RecalledMemory } from '../types.js';
import { accessLevelSql, checkPermission } from '../auth.js';
import { logAudit } from '../audit.js';
import {
  ingestionQueueEnabled,
  ingestionStatusFromJob,
  ingestionStatusJoinSql,
  ingestionStatusSelectSql,
  type IngestionFailureCategory,
  type IngestionJobStatus,
} from '../ingestion.js';

export const recallSchema = z.object({
  id: z.string().uuid().optional(),
  document_id: z.string().uuid().optional(),
}).refine(
  (d) => d.id || d.document_id,
  { message: 'At least one of id or document_id is required' }
);

type DeduplicatedJobRow = {
  status: IngestionJobStatus;
  accepted_at: Date | string;
  ready_at: Date | string | null;
  attempts: number | string;
  next_attempt_at: Date | string | null;
  failure_category: IngestionFailureCategory | null;
  canonical_memory_id: string;
  similarity: number | string | null;
};

/**
 * Only while the durable ingestion queue is on: the content-free status column
 * and its LEFT JOIN. Off, the statements below are byte-for-byte the pre-queue
 * queries. RLS hides other owners' job rows, so a missing row yields NULL (or
 * `{ state: 'queued' }` when the vector is still absent) and never another
 * owner's details.
 */
function ingestionProjection(enabled: boolean, selectIndent: string, joinIndent: string): { select: string; join: string } {
  return {
    select: enabled ? `,\n${selectIndent}${ingestionStatusSelectSql('m')} AS ingestion` : '',
    join: enabled ? `\n${joinIndent}${ingestionStatusJoinSql('m')}` : '',
  };
}

export async function memoryRecall(params: { id: string; document_id?: undefined }, auth: AuthContext): Promise<RecalledMemory>;
export async function memoryRecall(params: { document_id: string; id?: undefined }, auth: AuthContext): Promise<RecalledMemory[]>;
export async function memoryRecall(params: z.infer<typeof recallSchema>, auth: AuthContext): Promise<RecalledMemory | RecalledMemory[]>;
export async function memoryRecall(
  params: z.infer<typeof recallSchema>,
  auth: AuthContext
): Promise<RecalledMemory | RecalledMemory[]> {
  checkPermission(auth, 'read');
  const namespaces = auth.namespaces;
  const queueEnabled = ingestionQueueEnabled();

  if (params.id) {
    let row = await recallById(params.id, auth, queueEnabled);
    if (!row && queueEnabled) {
      // A pending memory that deduplicated at finalization was soft-deleted,
      // but its stable id must stay resolvable: answer with the canonical row
      // and the job's own status (canonical_memory_id, similarity). RLS limits
      // the job lookup to the owner or an admin; every other soft-deleted id
      // stays not found.
      const job = await queryScoped<DeduplicatedJobRow>(
        dbScopeFromAuth(auth),
        `SELECT ij.status, ij.accepted_at, ij.ready_at, ij.attempts, ij.next_attempt_at,
                ij.failure_category, ij.canonical_memory_id, ij.similarity
         FROM memory_ingestion_jobs ij
         WHERE ij.memory_id = $1 AND ij.status = 'deduplicated'
           AND ij.canonical_memory_id IS NOT NULL AND ij.namespace = ANY($2)`,
        [params.id, namespaces]
      );
      const deduplicated = job.rows[0];
      if (deduplicated) {
        const canonical = await recallById(deduplicated.canonical_memory_id, auth, queueEnabled);
        if (canonical) row = { ...canonical, ingestion: ingestionStatusFromJob(deduplicated) };
      }
    }
    if (!row) throw new Error('Memory not found or access denied');
    await logAudit({
      clientId: auth.keyId, action: 'memory.recall', resourceType: 'memory',
      resourceId: params.id, memoryId: row.id, resultCount: 1,
    }, dbScopeFromAuth(auth));
    return row;
  }

  const ingestion = ingestionProjection(queueEnabled, '            ', '     ');
  const res = await queryScoped<RecalledMemory>(
    dbScopeFromAuth(auth),
    `SELECT m.id, m.content, m.source, m.namespace, m.tags, m.metadata, m.access_level,
            m.created_at, m.updated_at, m.document_id, m.chunk_index, m.memory_kind,
            m.valid_from, m.valid_to, m.superseded_at, m.revision, m.expires_at,
            CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
              'agent_id', a.id, 'agent_name', a.name, 'agent_type', a.type,
              'agent_model', a.model, 'agent_runtime', a.runtime,
              'same_key_as_requester', COALESCE(a.api_key_id::text = $4, false)
            ) END AS provenance,
            (to_jsonb(m)->>'consolidated_into_id')::uuid AS consolidated_into_id,
            (to_jsonb(m)->>'consolidated_at')::timestamptz AS consolidated_at,
            (SELECT predecessor.id FROM memories predecessor
             WHERE predecessor.id = m.supersedes_id
               AND predecessor.deleted_at IS NULL
               AND (predecessor.expires_at IS NULL OR predecessor.expires_at > statement_timestamp())
               AND predecessor.namespace = m.namespace
               AND predecessor.namespace = ANY($2)
               AND ${accessLevelSql('predecessor.access_level', '$3')}
             LIMIT 1) AS supersedes_id,
            m.superseded_at IS NOT NULL AS is_superseded,
            (SELECT successor.id FROM memories successor
             WHERE successor.supersedes_id = m.id
               AND successor.deleted_at IS NULL
               AND (successor.expires_at IS NULL OR successor.expires_at > statement_timestamp())
               AND successor.namespace = m.namespace
               AND successor.namespace = ANY($2)
               AND ${accessLevelSql('successor.access_level', '$3')}
             LIMIT 1) AS superseded_by_id${ingestion.select}
     FROM memories m
     LEFT JOIN agents a ON a.id = m.agent_id${ingestion.join}
     WHERE m.document_id = $1 AND m.deleted_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
       AND to_jsonb(m)->>'consolidated_into_id' IS NULL AND m.namespace = ANY($2) AND ${accessLevelSql('m.access_level', '$3')}
     ORDER BY m.chunk_index ASC`,
    [params.document_id, namespaces, auth.maxAccessLevel, auth.keyId]
  );
  if (res.rows.length === 0) throw new Error('Document not found or access denied');
  await logAudit({
    clientId: auth.keyId, action: 'memory.recall', resourceType: 'document',
    resourceId: params.document_id, resultCount: res.rows.length,
  }, dbScopeFromAuth(auth));
  return res.rows;
}

async function recallById(id: string, auth: AuthContext, queueEnabled: boolean): Promise<RecalledMemory | null> {
  const namespaces = auth.namespaces;
  const ingestion = ingestionProjection(queueEnabled, '              ', '       ');
  const res = await queryScoped<RecalledMemory>(
    dbScopeFromAuth(auth),
    `SELECT m.id, m.content, m.source, m.namespace, m.tags, m.metadata, m.access_level,
              m.created_at, m.updated_at, m.document_id, m.chunk_index, m.memory_kind,
              m.valid_from, m.valid_to, m.superseded_at, m.revision, m.expires_at,
              CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
                'agent_id', a.id, 'agent_name', a.name, 'agent_type', a.type,
                'agent_model', a.model, 'agent_runtime', a.runtime,
                'same_key_as_requester', COALESCE(a.api_key_id::text = $4, false)
              ) END AS provenance,
              (to_jsonb(m)->>'consolidated_into_id')::uuid AS consolidated_into_id,
              (to_jsonb(m)->>'consolidated_at')::timestamptz AS consolidated_at,
              (SELECT predecessor.id FROM memories predecessor
               WHERE predecessor.id = m.supersedes_id
                 AND predecessor.deleted_at IS NULL
                 AND (predecessor.expires_at IS NULL OR predecessor.expires_at > statement_timestamp())
                 AND predecessor.namespace = m.namespace
                 AND predecessor.namespace = ANY($2)
                 AND ${accessLevelSql('predecessor.access_level', '$3')}
               LIMIT 1) AS supersedes_id,
              m.superseded_at IS NOT NULL AS is_superseded,
              (SELECT successor.id FROM memories successor
               WHERE successor.supersedes_id = m.id
                 AND successor.deleted_at IS NULL
                 AND (successor.expires_at IS NULL OR successor.expires_at > statement_timestamp())
                 AND successor.namespace = m.namespace
                 AND successor.namespace = ANY($2)
                 AND ${accessLevelSql('successor.access_level', '$3')}
               LIMIT 1) AS superseded_by_id${ingestion.select}
       FROM memories m
       LEFT JOIN agents a ON a.id = m.agent_id${ingestion.join}
       WHERE m.id = $1 AND m.deleted_at IS NULL
         AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
         AND m.namespace = ANY($2) AND ${accessLevelSql('m.access_level', '$3')}`,
    [id, namespaces, auth.maxAccessLevel, auth.keyId]
  );
  return res.rows[0] ?? null;
}
