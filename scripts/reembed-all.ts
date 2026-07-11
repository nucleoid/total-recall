import dotenv from 'dotenv';
dotenv.config({ override: true });

import pg from 'pg';
import { embedBatch } from '../src/embedding.js';

const BATCH_SIZE = 10;
const DELAY_MS = 50;

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.OWNER_DATABASE_URL || 'postgresql://total_recall:total_recall_dev@localhost:5432/total_recall',
  });

  const client = await pool.connect();
  console.log('[reembed] Connected to PostgreSQL');

  // Owner connection intentionally bypasses RLS for full-store re-embedding.
  const { rows } = await client.query<{ id: string; content: string }>(
    `SELECT id, content FROM memories ORDER BY id`
  );
  console.log(`[reembed] Found ${rows.length} memories to re-embed`);

  const startTime = Date.now();
  let processed = 0;
  let errors = 0;
  const errorDetails: Array<{ id: string; error: string }> = [];

  // Process in batches
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const texts = batch.map((r) => r.content);

    try {
      const embeddings = await embedBatch(texts);

      // Update each memory with its new embedding
      for (let j = 0; j < batch.length; j++) {
        const vectorStr = `[${embeddings[j].join(',')}]`;
        await client.query(`UPDATE memories SET embedding = $1 WHERE id = $2`, [
          vectorStr,
          batch[j].id,
        ]);
      }

      processed += batch.length;
    } catch (err: any) {
      // Fallback: try individually
      for (const row of batch) {
        try {
          const [embedding] = await embedBatch([row.content]);
          const vectorStr = `[${embedding.join(',')}]`;
          await client.query(`UPDATE memories SET embedding = $1 WHERE id = $2`, [
            vectorStr,
            row.id,
          ]);
          processed++;
        } catch (innerErr: any) {
          errors++;
          errorDetails.push({ id: row.id, error: innerErr.message });
        }
      }
    }

    // Progress logging
    if (processed % 100 < BATCH_SIZE || i + BATCH_SIZE >= rows.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[reembed] Progress: ${processed}/${rows.length} (${elapsed}s elapsed, ${errors} errors)`);
    }

    // Rate limit
    if (i + BATCH_SIZE < rows.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[reembed] ✅ Complete!`);
  console.log(`[reembed]   Total: ${processed} re-embedded`);
  console.log(`[reembed]   Errors: ${errors}`);
  console.log(`[reembed]   Time: ${totalTime}s`);

  if (errorDetails.length > 0) {
    console.log(`[reembed]   Error details:`);
    for (const e of errorDetails) {
      console.log(`    - ${e.id}: ${e.error}`);
    }
  }

  client.release();
  await pool.end();
}

main().catch((err) => {
  console.error('[reembed] Fatal error:', err);
  process.exit(1);
});
