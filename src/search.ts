import { withClient } from './db.js';
import { embed } from './embedding.js';
import type { SearchParams, SearchResult } from './types.js';
import dotenv from 'dotenv';
dotenv.config();

const EF_SEARCH = parseInt(process.env.HNSW_EF_SEARCH || '200', 10);
const ISO_TIMESTAMPTZ_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$';

export async function hybridSearch(
  params: SearchParams,
  namespaces: string[]
): Promise<SearchResult[]> {
  const embedding = await embed(params.query);
  const vecStr = `[${embedding.join(',')}]`;
  const limit = Math.min(params.limit ?? 10, 50);
  const threshold = params.threshold ?? 0.3;

  return withClient(async (client) => {
    await client.query(`SET LOCAL hnsw.ef_search = ${EF_SEARCH}`);

    const values: unknown[] = [];
    let idx = 0;
    const p = (v: unknown) => { values.push(v); return `$${++idx}`; };

    const pVec = p(vecStr);
    const pNs = p(namespaces);
    const pQuery = p(params.query);
    const pLimit = p(limit);
    const pThreshold = p(threshold);

    const conditions: string[] = [];
    if (params.tags && params.tags.length > 0) {
      conditions.push(`m.tags @> ${p(params.tags)}`);
    }
    if (params.mediaFilters?.services && params.mediaFilters.services.length > 0) {
      conditions.push(`m.metadata->>'service' = ANY(${p(params.mediaFilters.services)}::text[])`);
    }
    if (params.mediaFilters?.eventTypes && params.mediaFilters.eventTypes.length > 0) {
      conditions.push(`m.metadata->>'event_type' = ANY(${p(params.mediaFilters.eventTypes)}::text[])`);
    }
    if (params.mediaFilters?.playedAfter) {
      conditions.push(`${playedAtExpression('m')} >= ${p(params.mediaFilters.playedAfter)}::timestamptz`);
    }
    if (params.mediaFilters?.playedBefore) {
      conditions.push(`${playedAtExpression('m')} <= ${p(params.mediaFilters.playedBefore)}::timestamptz`);
    }
    if (params.source) {
      conditions.push(`m.source = ${p(params.source)}`);
    }
    if (params.after) {
      conditions.push(`m.created_at >= ${p(params.after)}`);
    }
    if (params.before) {
      conditions.push(`m.created_at <= ${p(params.before)}`);
    }

    const extraWhere = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';

    const sql = `
      WITH vector_results AS (
        SELECT id, content, metadata, tags, source, namespace, created_at, relevance_score, decay_rate,
          updated_at, accessed_at, access_count, access_level, client_id,
          1 - (embedding <=> ${pVec}::vector) AS vec_score
        FROM memories m
        WHERE namespace = ANY(${pNs}) ${extraWhere}
        ORDER BY embedding <=> ${pVec}::vector
        LIMIT 50
      ),
      text_only_results AS (
        SELECT id, content, metadata, tags, source, namespace, created_at, relevance_score, decay_rate,
          updated_at, accessed_at, access_count, access_level, client_id,
          1 - (embedding <=> ${pVec}::vector) AS vec_score
        FROM memories m
        WHERE namespace = ANY(${pNs}) ${extraWhere}
          AND to_tsvector('english', content) @@ plainto_tsquery(${pQuery})
          AND id NOT IN (SELECT id FROM vector_results)
        LIMIT 20
      ),
      combined AS (
        SELECT * FROM vector_results
        UNION ALL
        SELECT * FROM text_only_results
      ),
      text_scores AS (
        SELECT id,
          ts_rank_cd(to_tsvector('english', content), plainto_tsquery(${pQuery})) AS text_score
        FROM memories m
        WHERE namespace = ANY(${pNs}) ${extraWhere}
          AND to_tsvector('english', content) @@ plainto_tsquery(${pQuery})
      )
      SELECT c.*,
        COALESCE(t.text_score, 0) AS text_score,
        (c.vec_score * 0.3 + COALESCE(t.text_score, 0) * 0.7 + CASE WHEN COALESCE(t.text_score, 0) > 0 THEN 0.5 ELSE 0 END) AS base_score,
        calculate_relevance(c.relevance_score, c.decay_rate, c.accessed_at, c.access_count) AS relevance,
        (c.vec_score * 0.3 + COALESCE(t.text_score, 0) * 0.7 + CASE WHEN COALESCE(t.text_score, 0) > 0 THEN 2.0 ELSE 0 END)
          * LEAST(calculate_relevance(c.relevance_score, c.decay_rate, c.accessed_at, c.access_count), 2.0) AS final_score
      FROM combined c
      LEFT JOIN text_scores t ON c.id = t.id
      WHERE c.vec_score >= ${pThreshold} OR t.text_score > 0
      ORDER BY final_score DESC
      LIMIT ${pLimit};
    `;

    const res = await client.query(sql, values);

    if (res.rows.length > 0) {
      const ids = res.rows.map((r: any) => r.id);
      await client.query(
        `UPDATE memories SET accessed_at = NOW(), access_count = access_count + 1, last_boosted_at = NOW() WHERE id = ANY($1)`,
        [ids]
      );
    }

    return res.rows as SearchResult[];
  });
}

function playedAtExpression(alias: string): string {
  return `(CASE WHEN ${alias}.metadata->>'played_at' ~ '${ISO_TIMESTAMPTZ_PATTERN}' ` +
    `THEN (${alias}.metadata->>'played_at')::timestamptz END)`;
}
