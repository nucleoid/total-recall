import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://total_recall_app:total_recall_app_dev@localhost:5432/total_recall';

async function updateDecay() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await client.query(`SELECT set_config('app.allowed_namespaces', 'personal,work,projects,financial,shared', false)`);

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

    console.log(`✓ Updated ${count} memories`);
    console.log(`  Min: ${min} | Max: ${max} | Median: ${median} | Avg: ${avg}`);
    console.log(`  Distribution:`, buckets);
  } finally {
    await client.end();
  }
}

updateDecay().catch(err => {
  console.error('Decay update failed:', err);
  process.exit(1);
});
