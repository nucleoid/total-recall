import type pg from 'pg';
import { assertShadowOperator } from './shadow-embedding-audit.js';
import { CURRENT_PARENT_ELIGIBILITY } from './shadow-embedding-store.js';
import { QWEN_CONTRACT_ID } from './local-embedding-contract.js';

/** Progress evidence only. Full acceptance also needs bounded audits and all operational gates. */
export async function readShadowEmbeddingStatus(client: pg.PoolClient, expectedDatabase: string) {
  await assertShadowOperator(client, expectedDatabase);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL work_mem='4MB'; SET LOCAL max_parallel_workers_per_gather=0");
    const installed = (await client.query(`SELECT to_regclass('public.memory_embedding_manifests') IS NOT NULL AS installed`)).rows[0].installed;
    if (!installed) {
      await client.query('COMMIT');
      return { contractId: QWEN_CONTRACT_ID, installed: false, completion: 'not_evaluated', coverageSummaryOnly: true };
    }
    const groups = await client.query(`SELECT m.namespace,
      CASE WHEN NOT (${CURRENT_PARENT_ELIGIBILITY}) THEN 'lifecycle_excluded'
        WHEN f.is_current AND f.source_revision=m.revision THEN 'current_manifest'
        WHEN w.state='retry' AND w.error_code='embedding.valid_from_deferred' THEN 'deferred_not_yet_valid'
        WHEN w.state IN ('claimed','retry','failed') THEN w.state
        WHEN w.state='pending' THEN 'pending' ELSE 'stale_or_missing' END AS category,
      count(*)::text AS parents
      FROM memories m LEFT JOIN memory_embedding_manifests f ON f.parent_id=m.id AND f.contract_id=$1
      LEFT JOIN embedding_work_items w ON w.parent_id=m.id AND w.parent_type='memory' AND w.contract_id=$1
      GROUP BY m.namespace,category ORDER BY m.namespace,category`, [QWEN_CONTRACT_ID]);
    const work = await client.query(`SELECT parent_type,state,count(*)::text AS items
      FROM embedding_work_items WHERE contract_id=$1 GROUP BY parent_type,state ORDER BY parent_type,state`, [QWEN_CONTRACT_ID]);
    const subscriptions = await client.query(`SELECT count(*)::text AS physical,
      count(*) FILTER (WHERE s.status='active')::text AS active,
      count(*) FILTER (WHERE s.status='active' AND k.enabled AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp())
        AND EXISTS (SELECT 1 FROM subscription_namespaces sn WHERE sn.subscription_id=s.id AND sn.api_key_id=k.id
          AND sn.namespace=ANY(k.namespaces)))::text AS eligible_active,
      count(*) FILTER (WHERE s.status='active' AND k.enabled AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp())
        AND EXISTS (SELECT 1 FROM subscription_namespaces sn WHERE sn.subscription_id=s.id AND sn.api_key_id=k.id
          AND sn.namespace=ANY(k.namespaces))
        AND t.source_sha256=encode(digest(s.query_text,'sha256'),'hex') AND vector_dims(t.embedding)=768
        AND abs(vector_norm(t.embedding)-1)<0.00001 AND t.formatted_tokens BETWEEN 0 AND 2000)::text AS current_valid_targets
      FROM memory_subscriptions s JOIN api_keys k ON k.id=s.api_key_id
      LEFT JOIN subscription_embedding_targets t ON t.subscription_id=s.id AND t.contract_id=$1`, [QWEN_CONTRACT_ID]);
    const events = await client.query(`SELECT count(*) FILTER (WHERE processed_at IS NULL)::text AS pending,
      count(*) FILTER (WHERE processed_at IS NOT NULL)::text AS processed FROM shadow_subscription_insert_events WHERE contract_id=$1`, [QWEN_CONTRACT_ID]);
    const runs = await client.query(`SELECT id,status,source_watermark,cutover_watermark,completion_attestation IS NOT NULL AS completion_attested,updated_at,last_error_code
      FROM embedding_runs WHERE contract_id=$1 ORDER BY created_at DESC LIMIT 10`, [QWEN_CONTRACT_ID]);
    await client.query('COMMIT');
    return { contractId: QWEN_CONTRACT_ID, installed: true, completion: 'not_evaluated', coverageSummaryOnly: true,
      independentFullAuditRequired: true, parentsByNamespaceAndCategory: groups.rows,
      allWorkStates: work.rows, subscriptions: subscriptions.rows[0], subscriptionEvents: events.rows[0], recentRuns: runs.rows };
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  }
}
