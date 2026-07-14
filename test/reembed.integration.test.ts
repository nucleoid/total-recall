import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import pg from 'pg';
import { runReembedAgainstEnvironment } from '../scripts/reembed-all.js';

interface Fixture {
  containerId: string;
  ownerUrl: string;
  appUrl: string;
  untouchedUrl: string;
}

const IDS = {
  unknown: '00000000-0000-0000-0000-000000000001',
  active: '00000000-0000-0000-0000-000000000002',
  media: '00000000-0000-0000-0000-000000000003',
};

async function createFixture(): Promise<Fixture> {
  const containerId = execFileSync('docker', [
    'run', '--rm', '-d',
    '-e', 'POSTGRES_USER=postgres',
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-p', '127.0.0.1::5432',
    process.env.REEMBED_TEST_IMAGE || 'pgvector/pgvector:pg16',
  ], { encoding: 'utf8' }).trim();

  try {
    const port = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
    const adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 30_000;
    let admin: pg.Client | undefined;
    while (Date.now() < deadline) {
      admin = new pg.Client({ connectionString: adminUrl });
      try {
        await admin.connect();
        break;
      } catch {
        await admin.end().catch(() => undefined);
        admin = undefined;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    if (!admin) throw new Error('PostgreSQL test container did not become ready');
    try {
      await admin.query('CREATE DATABASE reembed_selected');
      await admin.query('CREATE DATABASE reembed_untouched');
      await admin.query("CREATE ROLE reembed_app LOGIN PASSWORD 'app-password'");
    } finally {
      await admin.end();
    }

    const base = `127.0.0.1:${port}`;
    const ownerUrl = `postgresql://postgres:postgres@${base}/reembed_selected`;
    const untouchedUrl = `postgresql://postgres:postgres@${base}/reembed_untouched`;
    const appUrl = `postgresql://reembed_app:app-password@${base}/reembed_selected`;
    for (const url of [ownerUrl, untouchedUrl]) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      await client.query('CREATE EXTENSION vector');
      await client.query(`
        CREATE TABLE public.memories (
          id uuid PRIMARY KEY,
          content text NOT NULL,
          namespace text NOT NULL,
          embedding vector(2),
          embedding_provider text,
          embedding_model text,
          embedding_dimensions integer,
          updated_at timestamptz NOT NULL DEFAULT NOW(),
          deleted_at timestamptz,
          revision integer NOT NULL DEFAULT 0
        )
      `);
      await client.query(`
        INSERT INTO public.memories
          (id, content, namespace, embedding, embedding_provider, embedding_model, embedding_dimensions, updated_at)
        VALUES
          ($1, 'unknown content', 'personal', '[0,0]', NULL, NULL, NULL, '2026-07-11 12:34:56.123456+00'),
          ($2, 'active content', 'personal', '[0.1,0.1]', 'gemini', 'target-model', 2, '2026-07-11 12:34:56.234567+00'),
          ($3, 'media content', 'media', '[0,0]', NULL, NULL, NULL, '2026-07-11 12:34:56.345678+00')
      `, [IDS.unknown, IDS.active, IDS.media]);
      if (url === ownerUrl) {
        await client.query('ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY');
        await client.query('GRANT SELECT, UPDATE ON public.memories TO reembed_app');
        await client.query("CREATE POLICY app_rows ON public.memories FOR ALL TO reembed_app USING (namespace = 'personal')");
      }
      await client.end();
    }
    return { containerId, ownerUrl, appUrl, untouchedUrl };
  } catch (error) {
    execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
    throw error;
  }
}

async function row(url: string, id: string): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT content, embedding::text AS embedding, embedding_provider, embedding_model, embedding_dimensions
      FROM public.memories WHERE id = $1
    `, [id]);
    return result.rows[0];
  } finally {
    await client.end();
  }
}

const profile = { provider: 'gemini', model: 'target-model', dimensions: 2 };
const embedder = async (texts: string[]) => texts.map(() => [0.25, 0.75]);

async function within<T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('operation did not terminate')), milliseconds)),
  ]);
}

test('reembed is owner-gated, exact, scoped, resumable, and terminating in full repair', async () => {
  const fixture = await createFixture();
  try {
    let rejectedProviderCalls = 0;
    await assert.rejects(
      runReembedAgainstEnvironment(
        { REEMBED_DATABASE_URL: fixture.appUrl },
        async () => { rejectedProviderCalls++; return []; },
        { ...profile, delayMs: 0 },
      ),
      /all-row maintenance preflight failed/i,
    );
    assert.equal(rejectedProviderCalls, 0);

    const scoped = await runReembedAgainstEnvironment(
      { REEMBED_DATABASE_URL: fixture.ownerUrl },
      embedder,
      { ...profile, namespaces: ['personal'], batchSize: 1, delayMs: 0 },
    );
    assert.equal(scoped.summary.selected, 1);
    assert.equal(scoped.summary.succeeded, 1);
    assert.deepEqual(scoped.summary.verification, { unknown_count: '0', legacy_count: '0' });
    assert.deepEqual(await row(fixture.ownerUrl, IDS.unknown), {
      content: 'unknown content',
      embedding: '[0.25,0.75]',
      embedding_provider: 'gemini',
      embedding_model: 'target-model',
      embedding_dimensions: 2,
    });
    assert.equal((await row(fixture.ownerUrl, IDS.media)).embedding_provider, null, 'out-of-scope row remains untouched');

    const fullRepair = await within(runReembedAgainstEnvironment(
      { REEMBED_DATABASE_URL: fixture.ownerUrl },
      embedder,
      { ...profile, namespaces: ['personal'], fullRepair: true, batchSize: 1, delayMs: 0 },
    ));
    assert.equal(fullRepair.summary.selected, 2);
    assert.equal(fullRepair.summary.succeeded, 2);

    let concurrentCalls = 0;
    const concurrent = await within(runReembedAgainstEnvironment(
      { REEMBED_DATABASE_URL: fixture.ownerUrl },
      async texts => {
        concurrentCalls++;
        const writer = new pg.Client({ connectionString: fixture.ownerUrl });
        await writer.connect();
        try {
          await writer.query(
            'UPDATE public.memories SET content = $1, updated_at = clock_timestamp() WHERE id = $2',
            ['concurrently changed', IDS.media],
          );
        } finally {
          await writer.end();
        }
        return texts.map(() => [0.5, 0.5]);
      },
      { ...profile, namespaces: ['media'], batchSize: 1, delayMs: 0, maxErrors: 0 },
    ));
    assert.equal(concurrentCalls, 1, 'cursor prevents reselecting the concurrently changed row forever');
    assert.equal(concurrent.summary.failed, 1);
    assert.equal(concurrent.summary.errors[0]?.category, 'concurrent_change');
    assert.deepEqual(concurrent.summary.verification, { unknown_count: '1', legacy_count: '0' });
    assert.equal((await row(fixture.ownerUrl, IDS.media)).content, 'concurrently changed');

    const resumed = await runReembedAgainstEnvironment(
      { REEMBED_DATABASE_URL: fixture.ownerUrl },
      embedder,
      { ...profile, namespaces: ['media'], delayMs: 0 },
    );
    assert.equal(resumed.summary.succeeded, 1);
    assert.deepEqual(resumed.summary.verification, { unknown_count: '0', legacy_count: '0' });

    assert.equal((await row(fixture.untouchedUrl, IDS.unknown)).embedding, '[0,0]');
    assert.equal(scoped.identity.database, 'reembed_selected');
    assert.equal(scoped.source, 'REEMBED_DATABASE_URL');
  } finally {
    execFileSync('docker', ['rm', '-f', fixture.containerId], { stdio: 'ignore' });
  }
});
