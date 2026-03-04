import { withClient } from './db.js';
import { embed } from './embedding.js';
import type { SearchParams, SearchResult } from './types.js';
import dotenv from 'dotenv';
dotenv.config();

const EF_SEARCH = parseInt(process.env.HNSW_EF_SEARCH || '200', 10);

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
      text_results AS (
        SELECT id,
          ts_rank_cd(to_tsvector('english', content), plainto_tsquery(${pQuery})) AS text_score
        FROM memories m
        WHERE namespace = ANY(${pNs}) ${extraWhere}
          AND to_tsvector('english', content) @@ plainto_tsquery(${pQuery})
      )
      SELECT v.*,
        COALESCE(t.text_score, 0) AS text_score,
        (v.vec_score * 0.7 + COALESCE(t.text_score, 0) * 0.3) AS base_score,
        calculate_relevance(v.relevance_score, v.decay_rate, v.accessed_at, v.access_count) AS relevance,
        (v.vec_score * 0.7 + COALESCE(t.text_score, 0) * 0.3)
          * calculate_relevance(v.relevance_score, v.decay_rate, v.accessed_at, v.access_count) AS final_score
      FROM vector_results v
      LEFT JOIN text_results t ON v.id = t.id
      WHERE v.vec_score >= ${pThreshold}
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
