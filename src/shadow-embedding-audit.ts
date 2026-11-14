import type pg from 'pg';
import { CURRENT_PARENT_ELIGIBILITY } from './shadow-embedding-store.js';
import { QWEN_CONTRACT_ID, sha256 } from './local-embedding-contract.js';

export interface ShadowAuditItem {
  parentId: string;
  namespace: string;
  state: 'verified_current' | 'missing' | 'stale' | 'invalid';
  code?: string;
  expectedChunks: number;
  actualChunks: number;
  sourceBytes: number;
}

/** Content-free receipt. A page is not full-corpus acceptance or a cutover watermark. */
export interface ShadowAuditPage {
  contractId: string;
  afterId: string | null;
  nextId: string | null;
  endOfScan: boolean;
  parents: ShadowAuditItem[];
  subscriptionEvidence: { eligibleActive: number; currentValid: number; missingOrInvalid: number };
  pendingEligibleInsertEvents: number;
}

export async function assertShadowOperator(client: pg.PoolClient, expectedDatabase: string): Promise<void> {
  if (!expectedDatabase.trim()) throw new Error('embedding.expected_database_required');
  const identity = await client.query(`SELECT current_database() AS db,rolsuper OR rolbypassrls AS operator
    FROM pg_roles WHERE rolname=current_user`);
  if (identity.rows[0]?.db !== expectedDatabase || identity.rows[0]?.operator !== true) throw new Error('embedding.database_identity');
}

/** Independent of success counters: inspect actual ordinals, spans, hashes, shape and live source. */
export async function auditShadowPage(client: pg.PoolClient, expectedDatabase: string,
  afterId: string | null = null, limit = 100): Promise<ShadowAuditPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('embedding.audit_row_limit');
  if (afterId !== null && !/^[a-f0-9-]{36}$/iu.test(afterId)) throw new Error('embedding.audit_cursor');
  await assertShadowOperator(client, expectedDatabase);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL work_mem='4MB'; SET LOCAL max_parallel_workers_per_gather=0");
    // Up to 8 MiB of source text per page. Oversized parents are reported without
    // loading their content, so poison inputs cannot defeat the audit memory cap.
    const selected = await client.query(`WITH candidates AS MATERIALIZED (
      SELECT id,octet_length(content) AS bytes FROM memories WHERE (${CURRENT_PARENT_ELIGIBILITY})
        AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2
    ), bounded AS (
      SELECT *,sum(LEAST(bytes,1048576)) OVER(ORDER BY id) AS cumulative FROM candidates
    ) SELECT m.id,m.namespace,m.revision,b.bytes,
      CASE WHEN b.bytes<=1048576 THEN m.content ELSE NULL END AS content,
      f.source_revision,f.source_sha256,f.source_bytes,f.chunk_count,f.is_current
    FROM bounded b JOIN memories m ON m.id=b.id LEFT JOIN memory_embedding_manifests f
      ON f.parent_id=m.id AND f.contract_id=$3 WHERE b.cumulative<=8388608 ORDER BY m.id`,
    [afterId, limit, QWEN_CONTRACT_ID]);
    const parents = selected.rows;
    const ids = parents.map(p => p.id as string);
    const chunks = ids.length ? (await client.query(`SELECT parent_id,ordinal,core_start,core_end,chunk_sha256,
      formatted_tokens,vector_dims(embedding) AS dimensions,vector_norm(embedding) AS norm
      FROM memory_embedding_chunks WHERE contract_id=$1 AND parent_id=ANY($2::uuid[]) ORDER BY parent_id,ordinal LIMIT 50001`,
    [QWEN_CONTRACT_ID, ids])).rows : [];
    if (chunks.length > 50_000) throw new Error('embedding.audit_chunk_limit');
    const byParent = new Map<string, typeof chunks>();
    for (const chunk of chunks) {
      if (!byParent.has(chunk.parent_id)) byParent.set(chunk.parent_id, []);
      byParent.get(chunk.parent_id)!.push(chunk);
    }
    const receipt: ShadowAuditItem[] = [];
    for (const parent of parents) {
      const actual = byParent.get(parent.id) ?? [];
      const item: ShadowAuditItem = { parentId: parent.id, namespace: parent.namespace, state: 'verified_current',
        expectedChunks: parent.chunk_count ?? 0, actualChunks: actual.length, sourceBytes: parent.bytes };
      const fail = (state: ShadowAuditItem['state'], code: string) => { item.state = state; item.code = code; };
      if (parent.content === null) fail('invalid', 'embedding.parent_byte_limit');
      else if (parent.chunk_count === null) fail('missing', 'embedding.manifest_missing');
      else if (!parent.is_current || parent.source_revision !== parent.revision
        || parent.source_sha256 !== sha256(parent.content) || parent.source_bytes !== parent.bytes) fail('stale', 'embedding.source_mismatch');
      else if (actual.length !== parent.chunk_count || actual.length === 0) fail('invalid', 'embedding.chunk_count');
      else {
        const bytes = Buffer.from(parent.content, 'utf8');
        let cursor = 0;
        for (let i = 0; i < actual.length; i++) {
          const c = actual[i];
          const invalidStart = c.core_start > 0 && c.core_start < bytes.length && (bytes[c.core_start] & 0xc0) === 0x80;
          const invalidEnd = c.core_end > 0 && c.core_end < bytes.length && (bytes[c.core_end] & 0xc0) === 0x80;
          if (c.ordinal !== i || c.core_start !== cursor || c.core_end < cursor || c.core_end > bytes.length
            || invalidStart || invalidEnd || c.chunk_sha256 !== sha256(bytes.subarray(c.core_start, c.core_end))
            || c.dimensions !== 768 || !Number.isFinite(c.norm) || Math.abs(c.norm - 1) > 1e-5
            || !Number.isSafeInteger(c.formatted_tokens) || c.formatted_tokens < 0 || c.formatted_tokens > 256
            || (c.core_end === c.core_start && !(bytes.length === 0 && actual.length === 1))) {
            fail('invalid', 'embedding.chunk_integrity'); break;
          }
          cursor = c.core_end;
        }
        if (item.state === 'verified_current' && cursor !== bytes.length) fail('invalid', 'embedding.chunk_gap');
      }
      receipt.push(item);
    }
    const subscriptions = (await client.query(`SELECT
      count(*) FILTER (WHERE s.status='active' AND k.enabled AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp())
        AND EXISTS (SELECT 1 FROM subscription_namespaces sn WHERE sn.subscription_id=s.id AND sn.api_key_id=k.id
          AND sn.namespace=ANY(k.namespaces)))::int AS eligible,
      count(*) FILTER (WHERE s.status='active' AND k.enabled AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp())
        AND EXISTS (SELECT 1 FROM subscription_namespaces sn WHERE sn.subscription_id=s.id AND sn.api_key_id=k.id
          AND sn.namespace=ANY(k.namespaces)) AND t.source_sha256=encode(digest(s.query_text,'sha256'),'hex')
        AND vector_dims(t.embedding)=768 AND abs(vector_norm(t.embedding)-1)<0.00001
        AND t.formatted_tokens BETWEEN 0 AND 2000)::int AS valid
      FROM memory_subscriptions s JOIN api_keys k ON k.id=s.api_key_id
      LEFT JOIN subscription_embedding_targets t ON t.subscription_id=s.id AND t.contract_id=$1`, [QWEN_CONTRACT_ID])).rows[0];
    const pendingEvents = (await client.query(`SELECT count(*)::int AS count FROM shadow_subscription_insert_events e
      JOIN memories m ON m.id=e.memory_id WHERE e.contract_id=$1 AND e.processed_at IS NULL
        AND COALESCE(m.access_level,'normal')='normal' AND (${CURRENT_PARENT_ELIGIBILITY})`, [QWEN_CONTRACT_ID])).rows[0]?.count ?? 0;
    // The transaction gives each page a local read boundary. Full completion
    // additionally needs coordinated writers and a recorded final source watermark.
    await client.query('COMMIT');
    const eligibleActive=Number(subscriptions?.eligible ?? 0), currentValid=Number(subscriptions?.valid ?? 0);
    return { contractId: QWEN_CONTRACT_ID, afterId, nextId: ids.at(-1) ?? afterId,
      endOfScan: parents.length === 0, parents: receipt,
      subscriptionEvidence: { eligibleActive, currentValid, missingOrInvalid: eligibleActive-currentValid },
      pendingEligibleInsertEvents: Number(pendingEvents) };
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  }
}
