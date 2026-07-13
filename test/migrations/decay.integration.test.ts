import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { repairLastBoostedAt } from '../../scripts/repair-last-boosted-at.js';
import { provisionDatabase } from '../../scripts/provision-db.js';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const migrationsDir = join(repoRoot, 'migrations');
const decayMigration = join(migrationsDir, '007_decay.sql');
const volatilityRepairMigration = join(migrationsDir, '019_repair_relevance_volatility.sql');
const hasDecayMigration = existsSync(decayMigration);

let containerId: string | undefined;
let adminUrl: string | undefined;
let ownerUrl = process.env.MIGRATION_TEST_DATABASE_URL;
let appUrl = process.env.MIGRATION_TEST_APP_DATABASE_URL;

test.after(async () => {
  if (containerId) {
    execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
  }
});

test('decay schema is represented by numbered migration 007', () => {
  assert.equal(hasDecayMigration, true, 'expected migrations/007_decay.sql to exist');

  const sql = readFileSync(decayMigration, 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS relevance_score\s+FLOAT\s+DEFAULT\s+1\.0/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS decay_rate\s+FLOAT\s+DEFAULT\s+0\.01/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS last_boosted_at\s+TIMESTAMPTZ/i);
  assert.match(sql, /ALTER COLUMN last_boosted_at SET DEFAULT NOW\(\)/i);
  assert.doesNotMatch(sql, /UPDATE\s+public\.memories[\s\S]+SET\s+last_boosted_at\s*=/i);
  assert.match(sql, /RAISE EXCEPTION[\s\S]+calculate_relevance[\s\S]+ALTER FUNCTION/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.calculate_relevance/i);
  assert.match(sql, /LANGUAGE plpgsql\s+STABLE/i);
});

test('forward repair targets only the canonical calculate_relevance signature and restores runtime execution', () => {
  assert.equal(
    existsSync(volatilityRepairMigration),
    true,
    'expected the next migration to repair databases whose bad volatility was already ledgered'
  );

  const sql = readFileSync(volatilityRepairMigration, 'utf8');
  assert.match(
    sql,
    /ALTER FUNCTION public\.calculate_relevance\(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, INTEGER\) STABLE/i
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION public\.calculate_relevance\(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, INTEGER\) TO total_recall_app/i
  );
  assert.doesNotMatch(sql, /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION/i);
});

test('migration rollout docs require calculate_relevance ownership preflight', () => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  const decaySql = readFileSync(decayMigration, 'utf8');
  const repairSql = readFileSync(volatilityRepairMigration, 'utf8');

  assert.match(readme, /Before deploying migration 007/i);
  assert.match(readme, /Before deploying migration 019/i);
  assert.match(readme, /pg_get_userbyid\(p\.proowner\)/i);
  assert.match(readme, /public\.calculate_relevance\s*\(\s*double precision,\s*double precision,\s*timestamp with time zone,\s*integer\s*\)/i);
  assert.match(readme, /ALTER FUNCTION public\.calculate_relevance\(FLOAT, FLOAT, TIMESTAMPTZ, INTEGER\) OWNER TO <migration-owner>/i);
  assert.match(readme, /DROP FUNCTION IF EXISTS public\.calculate_relevance\(FLOAT, FLOAT, TIMESTAMPTZ, INTEGER\)/i);
  assert.match(readme, /Do not grant `total_recall_app` general DDL/i);
  assert.doesNotMatch(decaySql, /GRANT\s+(CREATE|ALL PRIVILEGES|ALTER|DROP)\b[^;]*\bTO\s+total_recall_app/i);
  assert.doesNotMatch(repairSql, /GRANT\s+(CREATE|ALL PRIVILEGES|ALTER|DROP)\b[^;]*\bTO\s+total_recall_app/i);
});

test('clean install and upgrade paths converge on decay schema', { skip: !hasDecayMigration && 'missing 007_decay.sql' }, async () => {
  await withFreshDatabase(async () => {
    await resetDatabase();
    await applyMigrationsThrough('007_decay');

    await assertDecaySchema();
    await assertFunctionVolatility();
    await assertDecayDefaults();
  });

  await withFreshDatabase(async () => {
    await resetDatabase();
    await applyMigrationsThrough('006_media_events');
    const owner = await ownerClient();
    try {
      await insertMemory(owner, {
        content: 'legacy row without decay objects',
        accessedAt: null,
        createdAt: '2024-01-02T03:04:05Z',
      });
    } finally {
      await owner.end();
    }

    await applyMigration('007_decay.sql');

    await assertDecaySchema();
    await assertFunctionVolatility();
    await assertLastBoostedAt('legacy row without decay objects', null);
  });

  await withFreshDatabase(async () => {
    await resetDatabase();
    await applyMigrationsThrough('006_media_events');
    const owner = await ownerClient();
    try {
      await owner.query(`
        ALTER TABLE memories
          ADD COLUMN IF NOT EXISTS relevance_score FLOAT DEFAULT 1.0,
          ADD COLUMN IF NOT EXISTS decay_rate FLOAT DEFAULT 0.01,
          ADD COLUMN IF NOT EXISTS last_boosted_at TIMESTAMPTZ DEFAULT NOW()
      `);
      await owner.query(`
        CREATE OR REPLACE FUNCTION calculate_relevance(
          p_relevance_score FLOAT,
          p_decay_rate FLOAT,
          p_accessed_at TIMESTAMPTZ,
          p_access_count INTEGER
        ) RETURNS FLOAT AS $$
        BEGIN
          RETURN 0;
        END;
        $$ LANGUAGE plpgsql IMMUTABLE
      `);
      await insertMemory(owner, {
        content: 'legacy row with standalone decay objects',
        accessedAt: '2024-02-03T04:05:06Z',
        createdAt: '2024-01-01T00:00:00Z',
      });
      await owner.query(`
        UPDATE memories
        SET relevance_score = NULL,
            decay_rate = NULL,
            last_boosted_at = '2025-05-06T07:08:09Z'
        WHERE content = 'legacy row with standalone decay objects'
      `);
    } finally {
      await owner.end();
    }

    await applyMigration('007_decay.sql');
    await applyMigration('007_decay.sql');

    await assertDecaySchema();
    await assertFunctionVolatility();
    await assertLastBoostedAt('legacy row with standalone decay objects', '2025-05-06T07:08:09.000Z');
  });
});

test('ledgered bad volatility is repaired exactly once and remains transaction-stable for the app role', async () => {
  await withFreshDatabase(async () => {
    await resetDatabase();
    await applyMigrationsThrough('018_stable_relevance_base');

    const owner = await ownerClient();
    try {
      await owner.query(`
        ALTER FUNCTION public.calculate_relevance(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, INTEGER)
          IMMUTABLE
      `);
      await owner.query(`
        REVOKE ALL ON FUNCTION public.calculate_relevance(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, INTEGER)
          FROM PUBLIC, total_recall_app
      `);
      await owner.query(`
        CREATE FUNCTION public.calculate_relevance(p_value INTEGER)
        RETURNS INTEGER LANGUAGE sql IMMUTABLE AS 'SELECT p_value'
      `);
    } finally {
      await owner.end();
    }

    await assert.rejects(
      () => applyMigration('019_repair_relevance_volatility.sql'),
      /calculate_relevance[\s\S]+overload/i
    );

    const cleanup = await ownerClient();
    try {
      await cleanup.query('DROP FUNCTION public.calculate_relevance(INTEGER)');
    } finally {
      await cleanup.end();
    }
    await applyMigration('019_repair_relevance_volatility.sql');

    const catalog = await ownerClient();
    try {
      const { rows } = await catalog.query<{ provolatile: string; args: string }>(`
        SELECT p.provolatile,
               pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'calculate_relevance'
      `);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].provolatile, 's');
      assert.equal(
        rows[0].args,
        'p_relevance_base_score double precision, p_decay_rate double precision, p_accessed_at timestamp with time zone, p_access_count integer'
      );
    } finally {
      await catalog.end();
    }

    const app = new pg.Client({ connectionString: appUrl });
    await app.connect();
    try {
      await app.query('BEGIN');
      const anchor = await app.query<{ accessed_at: Date }>(
        "SELECT date_trunc('milliseconds', NOW() - INTERVAL '1 day') AS accessed_at"
      );
      const first = await app.query<{ score: number }>(
        'SELECT public.calculate_relevance(1.0, 1.0, $1::timestamptz, 0) AS score',
        [anchor.rows[0].accessed_at]
      );
      await app.query("SELECT pg_sleep(0.1)");
      const repeated = await app.query<{ score: number }>(
        'SELECT public.calculate_relevance(1.0, 1.0, $1::timestamptz, 0) AS score',
        [anchor.rows[0].accessed_at]
      );
      assert.equal(repeated.rows[0].score, first.rows[0].score);
      await app.query('COMMIT');

      await app.query("SELECT pg_sleep(0.1)");
      const nextTransaction = await app.query<{ score: number }>(
        'SELECT public.calculate_relevance(1.0, 1.0, $1::timestamptz, 0) AS score',
        [anchor.rows[0].accessed_at]
      );
      assert.ok(nextTransaction.rows[0].score < first.rows[0].score);

      await app.query("SELECT set_config('app.allowed_namespaces', 'shared', false)");
      await app.query(
        `INSERT INTO memories (
           content, embedding, source, namespace, client_id, relevance_base_score, decay_rate, accessed_at
         ) VALUES ($1, $2::vector, 'test', 'shared', 'test-client', 1.0, 0.01, NOW() - INTERVAL '1 day')`,
        ['runtime hybrid relevance', zeroVector()]
      );
      const hybrid = await app.query<{ final_score: number }>(`
        WITH vector_results AS (
          SELECT relevance_base_score, decay_rate, accessed_at, access_count, 1.0 AS vec_score
          FROM memories
          WHERE namespace = 'shared'
        ), scored AS MATERIALIZED (
          SELECT vec_score,
                 public.calculate_relevance(
                   relevance_base_score, decay_rate, accessed_at, access_count
                 ) AS relevance
          FROM vector_results
        )
        SELECT vec_score * LEAST(relevance, 2.0) AS final_score
        FROM scored
      `);
      assert.equal(hybrid.rows.length, 1);
      assert.equal(typeof hybrid.rows[0].final_score, 'number');
    } finally {
      await app.end();
    }
  });
});

test('migration 019 fails before DDL with clear remediation when calculate_relevance has a different owner', async () => {
  await withFreshDatabase(async () => {
    await resetDatabase();
    await applyMigrationsThrough('018_stable_relevance_base');

    const owner = await ownerClient();
    try {
      await owner.query(`
        ALTER FUNCTION public.calculate_relevance(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, INTEGER)
          IMMUTABLE
      `);
      await owner.query(`
        ALTER FUNCTION public.calculate_relevance(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, INTEGER)
          OWNER TO total_recall_app
      `);
    } finally {
      await owner.end();
    }

    await assert.rejects(
      () => applyMigration('019_repair_relevance_volatility.sql'),
      /calculate_relevance[\s\S]+owned by total_recall_app[\s\S]+ALTER FUNCTION[\s\S]+OWNER TO/i
    );

    const catalog = await ownerClient();
    try {
      const { rows } = await catalog.query<{ provolatile: string; owner: string }>(`
        SELECT p.provolatile, pg_get_userbyid(p.proowner) AS owner
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.oid = to_regprocedure(
            'public.calculate_relevance(double precision,double precision,timestamp with time zone,integer)'
          )
      `);
      assert.deepEqual(rows, [{ provolatile: 'i', owner: 'total_recall_app' }]);
    } finally {
      await catalog.end();
    }
  });
});

test('migration 007 fails with clear remediation when calculate_relevance has a different owner', { skip: !hasDecayMigration && 'missing 007_decay.sql' }, async () => {
  await withFreshDatabase(async () => {
    await resetDatabase();
    await applyMigrationsThrough('006_media_events');
    const owner = await ownerClient();
    try {
      await owner.query(`
        CREATE OR REPLACE FUNCTION public.calculate_relevance(
          p_relevance_score FLOAT,
          p_decay_rate FLOAT,
          p_accessed_at TIMESTAMPTZ,
          p_access_count INTEGER
        ) RETURNS FLOAT AS $$
        BEGIN
          RETURN 0;
        END;
        $$ LANGUAGE plpgsql IMMUTABLE
      `);
      await owner.query(`
        ALTER FUNCTION public.calculate_relevance(FLOAT, FLOAT, TIMESTAMPTZ, INTEGER)
        OWNER TO total_recall_app
      `);
    } finally {
      await owner.end();
    }

    await assert.rejects(
      () => applyMigration('007_decay.sql'),
      /calculate_relevance[\s\S]+owned by total_recall_app[\s\S]+ALTER FUNCTION/i
    );
  });
});

test('last_boosted_at repair is resumable, bounded, and preserves non-null values', { skip: !hasDecayMigration && 'missing 007_decay.sql' }, async () => {
  await withFreshDatabase(async () => {
    await resetDatabase();
    await applyMigrationsThrough('006_media_events');
    const owner = await ownerClient();
    try {
      await insertMemory(owner, {
        content: 'repair row one',
        accessedAt: '2024-01-02T03:04:05Z',
        createdAt: '2024-01-01T00:00:00Z',
      });
      await insertMemory(owner, {
        content: 'repair row two',
        accessedAt: null,
        createdAt: '2024-02-03T04:05:06Z',
      });
      await owner.query(`
        ALTER TABLE memories
          ADD COLUMN IF NOT EXISTS last_boosted_at TIMESTAMPTZ
      `);
      await insertMemory(owner, {
        content: 'preserve non-null repair row',
        accessedAt: '2024-03-04T05:06:07Z',
        createdAt: '2024-03-01T00:00:00Z',
      });
      await owner.query(`
        UPDATE memories
        SET last_boosted_at = '2025-01-01T00:00:00Z'
        WHERE content = 'preserve non-null repair row'
      `);
    } finally {
      await owner.end();
    }
    await applyMigration('007_decay.sql');

    const first = await repairLastBoostedAt({
      connectionString: ownerUrl!,
      batchSize: 1,
      maxRows: 1,
    });
    assert.equal(first.updatedRows, 1);
    assert.equal(first.batches, 1);
    assert.equal(first.remainingRows, 1);

    const second = await repairLastBoostedAt({
      connectionString: ownerUrl!,
      batchSize: 10,
      maxRows: 10,
    });
    assert.equal(second.updatedRows, 1);
    assert.equal(second.remainingRows, 0);

    await assertLastBoostedAt('repair row one', '2024-01-02T03:04:05.000Z');
    await assertLastBoostedAt('repair row two', '2024-02-03T04:05:06.000Z');
    await assertLastBoostedAt('preserve non-null repair row', '2025-01-01T00:00:00.000Z');
  });
});

test('calculate_relevance preserves existing decay formula', { skip: !hasDecayMigration && 'missing 007_decay.sql' }, async () => {
  await withFreshDatabase(async () => {
    await resetDatabase();
    await applyMigrationsThrough('007_decay');
    const owner = await ownerClient();
    try {
      const { rows } = await owner.query<{
        zero_age: number;
        aged: number;
        null_inputs: number;
        capped_bonus: number;
        future: number;
        expected_zero_age: number;
        expected_aged: number;
        expected_null_inputs: number;
        expected_capped_bonus: number;
        expected_future: number;
      }>(`
        SELECT
          public.calculate_relevance(1.0, 0.01, NOW(), 0) AS zero_age,
          public.calculate_relevance(1.0, 0.01, NOW() - INTERVAL '10 days', 5) AS aged,
          public.calculate_relevance(NULL, NULL, NULL, NULL) AS null_inputs,
          public.calculate_relevance(1.0, 0.01, NOW(), 20) AS capped_bonus,
          public.calculate_relevance(1.0, 0.01, NOW() + INTERVAL '2 days', 1) AS future,
          1.0 * EXP(-0.01 * 0) + LEAST(0 * 0.1, 1.0) AS expected_zero_age,
          1.0 * EXP(-0.01 * 10) + LEAST(5 * 0.1, 1.0) AS expected_aged,
          1.0 * EXP(-0.01 * 0) + 0 AS expected_null_inputs,
          1.0 * EXP(-0.01 * 0) + LEAST(20 * 0.1, 1.0) AS expected_capped_bonus,
          1.0 * EXP(-0.01 * -2) + LEAST(1 * 0.1, 1.0) AS expected_future
      `);
      const row = rows[0];
      assertClose(row.zero_age, row.expected_zero_age);
      assertClose(row.aged, row.expected_aged);
      assertClose(row.null_inputs, row.expected_null_inputs);
      assertClose(row.capped_bonus, row.expected_capped_bonus);
      assertClose(row.future, row.expected_future);
    } finally {
      await owner.end();
    }
  });
});

test('runtime app role can store and search with decay fields', { skip: !hasDecayMigration && 'missing 007_decay.sql' }, async () => {
  await withFreshDatabase(async () => {
    await resetDatabase();
    await applyMigrationsThrough('007_decay');

    const app = new pg.Client({ connectionString: appUrl });
    await app.connect();
    try {
      await app.query(`SELECT set_config('app.allowed_namespaces', 'shared', false)`);
      await app.query(
        `INSERT INTO memories (content, embedding, source, namespace, client_id)
         VALUES ($1, $2::vector, 'test', 'shared', 'test-client')`,
        ['runtime inserted memory', zeroVector()]
      );

      const { rows } = await app.query<{ relevance: number }>(
        `SELECT public.calculate_relevance(relevance_score, decay_rate, accessed_at, access_count) AS relevance
         FROM memories
         WHERE namespace = ANY($1)
         ORDER BY embedding <=> $2::vector
         LIMIT 1`,
        [['shared'], zeroVector()]
      );

      assert.equal(rows.length, 1);
      assert.equal(typeof rows[0].relevance, 'number');
    } finally {
      await app.end();
    }
  });
});

async function withFreshDatabase(fn: () => Promise<void>) {
  await ensureDatabase();
  await fn();
}

async function ensureDatabase() {
  if (ownerUrl && appUrl) {
    return;
  }

  if (!containerId) {
    const image = process.env.MIGRATION_TEST_IMAGE || 'pgvector/pgvector:pg16';
    containerId = execFileSync('docker', [
      'run',
      '--rm',
      '-d',
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-p',
      '127.0.0.1::5432',
      image,
    ], { encoding: 'utf8' }).trim();

    const portLine = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' }).trim();
    const port = portLine.split(':').at(-1);
    adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    ownerUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/total_recall`;
    appUrl = `postgresql://total_recall_app:total_recall_app_dev@127.0.0.1:${port}/total_recall`;
  }

  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: adminUrl ?? ownerUrl });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastError = err;
      try {
        await client.end();
      } catch {
        // Ignore close errors while waiting for PostgreSQL to accept connections.
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  throw lastError;
}

async function resetDatabase() {
  if (adminUrl) {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query('DROP DATABASE IF EXISTS total_recall WITH (FORCE)');
      await admin.query('CREATE DATABASE total_recall');
    } finally {
      await admin.end();
    }

    const owner = await ownerClient();
    try {
      await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
      await owner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await provisionDatabase(owner, {
        appPassword: decodeURIComponent(new URL(appUrl!).password),
        rotateAppPassword: false,
      });
    } finally {
      await owner.end();
    }
    return;
  }

  const client = await ownerClient();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await provisionDatabase(client, {
      appPassword: decodeURIComponent(new URL(appUrl!).password),
      rotateAppPassword: false,
    });
  } finally {
    await client.end();
  }
}

async function applyMigrationsThrough(lastVersion: string) {
  const files = readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .filter(file => file.replace('.sql', '') <= lastVersion);

  for (const file of files) {
    await applyMigration(file);
  }
}

async function applyMigration(file: string) {
  const client = await ownerClient();
  try {
    await client.query(readFileSync(join(migrationsDir, file), 'utf8'));
  } finally {
    await client.end();
  }
}

async function ownerClient() {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  return client;
}

async function insertMemory(
  client: pg.Client,
  row: { content: string; accessedAt: string | null; createdAt: string }
) {
  await client.query(
    `INSERT INTO memories (content, embedding, source, namespace, client_id, accessed_at, created_at)
     VALUES ($1, $2::vector, 'test', 'shared', 'test-client', $3, $4)`,
    [row.content, zeroVector(), row.accessedAt, row.createdAt]
  );
}

async function assertDecaySchema() {
  const client = await ownerClient();
  try {
    const { rows: columns } = await client.query<{
      column_name: string;
      column_default: string | null;
      data_type: string;
    }>(`
      SELECT column_name, column_default, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'memories'
        AND column_name IN ('relevance_score', 'decay_rate', 'last_boosted_at')
      ORDER BY column_name
    `);

    assert.deepEqual(
      columns.map(row => row.column_name),
      ['decay_rate', 'last_boosted_at', 'relevance_score']
    );
    assert.match(columns.find(row => row.column_name === 'relevance_score')?.column_default ?? '', /1\.0/);
    assert.match(columns.find(row => row.column_name === 'decay_rate')?.column_default ?? '', /0\.01/);
    assert.match(columns.find(row => row.column_name === 'last_boosted_at')?.column_default ?? '', /now\(\)/i);
  } finally {
    await client.end();
  }
}

async function assertFunctionVolatility() {
  const client = await ownerClient();
  try {
    const { rows } = await client.query<{ provolatile: string; args: string }>(`
      SELECT p.provolatile,
             pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'calculate_relevance'
    `);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].provolatile, 's');
    assert.equal(
      rows[0].args,
      'p_relevance_score double precision, p_decay_rate double precision, p_accessed_at timestamp with time zone, p_access_count integer'
    );
  } finally {
    await client.end();
  }
}

async function assertDecayDefaults() {
  const client = await ownerClient();
  try {
    await insertMemory(client, {
      content: 'defaulted decay row',
      accessedAt: null,
      createdAt: '2024-03-04T05:06:07Z',
    });
    const { rows } = await client.query<{
      relevance_score: number;
      decay_rate: number;
      last_boosted_at: Date;
    }>(`
      SELECT relevance_score, decay_rate, last_boosted_at
      FROM memories
      WHERE content = 'defaulted decay row'
    `);
    assert.equal(rows[0].relevance_score, 1);
    assert.equal(rows[0].decay_rate, 0.01);
    assert.ok(rows[0].last_boosted_at instanceof Date);
  } finally {
    await client.end();
  }
}

async function assertBackfill(content: string, expectedIso: string) {
  const client = await ownerClient();
  try {
    const { rows } = await client.query<{
      relevance_score: number;
      decay_rate: number;
      last_boosted_at: Date;
    }>(
      `SELECT relevance_score, decay_rate, last_boosted_at
       FROM memories
       WHERE content = $1`,
      [content]
    );

    assert.equal(rows[0].relevance_score, 1);
    assert.equal(rows[0].decay_rate, 0.01);
    assert.equal(rows[0].last_boosted_at.toISOString(), expectedIso);
  } finally {
    await client.end();
  }
}

async function assertLastBoostedAt(content: string, expectedIso: string | null) {
  const client = await ownerClient();
  try {
    const { rows } = await client.query<{ last_boosted_at: Date | null }>(
      `SELECT last_boosted_at
       FROM memories
       WHERE content = $1`,
      [content]
    );

    assert.equal(rows.length, 1);
    if (expectedIso === null) {
      assert.equal(rows[0].last_boosted_at, null);
      return;
    }
    assert.equal(rows[0].last_boosted_at?.toISOString(), expectedIso);
  } finally {
    await client.end();
  }
}

function assertClose(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} should be close to ${expected}`);
}

function zeroVector() {
  return `[${Array.from({ length: 768 }, () => '0').join(',')}]`;
}
