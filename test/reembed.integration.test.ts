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
        id text PRIMARY KEY,
        content text NOT NULL,
        namespace text NOT NULL,
        embedding vector(2) NOT NULL
      )
    `);
    await client.query("INSERT INTO public.memories VALUES ('row-1', 'content', 'personal', '[0,0]')");
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

async function embedding(url: string): Promise<number[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ embedding: string }>("SELECT embedding::text AS embedding FROM public.memories WHERE id = 'row-1'");
    return result.rows[0].embedding.slice(1, -1).split(',').map(Number);
  } finally {
    await client.end();
  }
}

test('reembed changes only the selected custom database and rejects its RLS-limited app role', async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      runReembedAgainstEnvironment(
        { DATABASE_URL: fixture.appUrl },
        async texts => texts.map(() => [0.25, 0.75]),
        { dimensions: 2, delayMs: 0 },
      ),
      /all-row maintenance preflight failed/i,
    );
    assert.deepEqual(await embedding(fixture.ownerUrl), [0, 0]);

    const result = await runReembedAgainstEnvironment(
      { DATABASE_URL: fixture.ownerUrl },
      async texts => texts.map(() => [0.25, 0.75]),
      { dimensions: 2, delayMs: 0 },
    );
    assert.equal(result.summary.succeeded, 1);
    assert.equal(result.identity.database, 'reembed_selected');
    assert.deepEqual(await embedding(fixture.ownerUrl), [0.25, 0.75]);
    assert.deepEqual(await embedding(fixture.untouchedUrl), [0, 0]);
  } finally {
    execFileSync('docker', ['rm', '-f', fixture.containerId], { stdio: 'ignore' });
  }
});
