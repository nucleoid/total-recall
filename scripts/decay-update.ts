import { shutdown, withScopedClient, type DbScope } from '../src/db.js';

const DECAY_SCOPE: DbScope = {
  keyId: 'decay-update',
  namespaces: ['personal', 'work', 'projects', 'financial', 'shared', 'media'],
};

async function updateDecay() {
  await withScopedClient(DECAY_SCOPE, async (client) => {
    const res = await client.query(`
      UPDATE memories
      SET relevance_score = calculate_relevance(relevance_score, decay_rate, accessed_at, access_count),
          updated_at = NOW()
      RETURNING relevance_score
    `);

    const scores = res.rows.map((r: any) => r.relevance_score as number);
    const count = scores.length;

    if (count === 0) {
      console.log('No memories to update.');
      return;
    }

    scores.sort((a, b) => a - b);
    const min = scores[0].toFixed(4);
    const max = scores[count - 1].toFixed(4);
    const median = scores[Math.floor(count / 2)].toFixed(4);
    const avg = (scores.reduce((a, b) => a + b, 0) / count).toFixed(4);

    const buckets = { 'low (<0.5)': 0, 'medium (0.5-1.0)': 0, 'high (1.0-1.5)': 0, 'very high (>1.5)': 0 };
    for (const s of scores) {
      if (s < 0.5) buckets['low (<0.5)']++;
      else if (s < 1.0) buckets['medium (0.5-1.0)']++;
      else if (s < 1.5) buckets['high (1.0-1.5)']++;
      else buckets['very high (>1.5)']++;
    }

    console.log(`Updated ${count} memories`);
    console.log(`  Min: ${min} | Max: ${max} | Median: ${median} | Avg: ${avg}`);
    console.log('  Distribution:', buckets);
  });
}

updateDecay()
  .then(() => shutdown())
  .catch((err) => {
    console.error('Decay update failed:', err);
    shutdown().finally(() => process.exit(1));
  });
