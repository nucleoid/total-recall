import pg from 'pg';

const DATABASE_URL = process.env.OWNER_DATABASE_URL || 'postgresql://total_recall:total_recall_dev@localhost:5432/total_recall';

async function migrate() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await client.query(`
      ALTER TABLE memories
        ADD COLUMN IF NOT EXISTS relevance_score FLOAT DEFAULT 1.0,
        ADD COLUMN IF NOT EXISTS decay_rate FLOAT DEFAULT 0.01,
        ADD COLUMN IF NOT EXISTS last_boosted_at TIMESTAMPTZ DEFAULT NOW()
    `);
    console.log('✓ Added relevance_score, decay_rate, last_boosted_at columns');

    await client.query(`
      CREATE OR REPLACE FUNCTION calculate_relevance(
        p_relevance_score FLOAT,
        p_decay_rate FLOAT,
        p_accessed_at TIMESTAMPTZ,
        p_access_count INTEGER
      ) RETURNS FLOAT AS $$
      DECLARE
        days_since FLOAT;
        access_bonus FLOAT;
      BEGIN
        days_since := EXTRACT(EPOCH FROM (NOW() - COALESCE(p_accessed_at, NOW()))) / 86400.0;
        access_bonus := LEAST(COALESCE(p_access_count, 0) * 0.1, 1.0);
        RETURN COALESCE(p_relevance_score, 1.0) * EXP(-COALESCE(p_decay_rate, 0.01) * days_since) + access_bonus;
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;
    `);
    console.log('✓ Created calculate_relevance function');

    const res = await client.query(`
      UPDATE memories
      SET relevance_score = 1.0,
          last_boosted_at = COALESCE(accessed_at, created_at)
      WHERE relevance_score IS NULL
    `);
    console.log(`✓ Initialized ${res.rowCount} rows with default relevance_score`);

    console.log('Migration complete!');
  } finally {
    await client.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
