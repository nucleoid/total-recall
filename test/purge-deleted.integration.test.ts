import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { prepareAllRowMaintenance, type QueryClient } from '../scripts/lib/maintenance-db.js';
import {
  applyDeletedWithClient,
  previewDeletedWithClient,
} from '../scripts/purge-deleted.js';

const APP_ROLE = 'total_recall_app';
const APP_PASSWORD = 'app-password';
const BYPASS_ROLE = 'purge_bypass';
const BYPASS_PASSWORD = 'bypass-password';
const PURGE_LOCK_KEY = 0x54525051;
const NAMESPACE = 'purge-integration';

const IDS = {
  active: '10000000-0000-4000-8000-000000000001',
  recent: '10000000-0000-4000-8000-000000000002',
  eligible: '10000000-0000-4000-8000-000000000003',
  mediaBlocked: '10000000-0000-4000-8000-000000000004',
  dynamicBlocked: '10000000-0000-4000-8000-000000000005',
  auditRollback: '10000000-0000-4000-8000-000000000006',
  concurrentBlocked: '10000000-0000-4000-8000-000000000007',
  lockBlocked: '10000000-0000-4000-8000-000000000008',
} as const;

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

async function connectWhenReady(connectionString: string, timeoutMs = 30_000): Promise<pg.Client> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error('PostgreSQL did not become ready', { cause: lastError });
}

async function insertMemory(
  client: pg.Client,
  id: string,
  deletedAt: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO public.memories
       (id, content, source, namespace, client_id, deleted_at)
     VALUES ($1::uuid, $2, 'purge-integration', $3, 'purge-integration', $4::timestamptz)`,
    [id, `content-${id}`, NAMESPACE, deletedAt],
  );
}

async function resetScenario(owner: pg.Client): Promise<void> {
  await owner.query('DROP TRIGGER IF EXISTS purge_fail_audit ON public.audit_log');
  await owner.query('DROP FUNCTION IF EXISTS public.purge_fail_audit()');
  await owner.query(
    `TRUNCATE TABLE public.purge_dynamic_references, public.media_events,
       public.audit_log, public.memories RESTART IDENTITY CASCADE`,
  );
}

test('hard purge safety holds against real PostgreSQL', { timeout: 60_000 }, async t => {
  if (!dockerAvailable()) { t.skip('Docker is unavailable'); return; }

  const container = execFileSync('docker', [
    'run', '--rm', '-d',
    '-e', 'POSTGRES_PASSWORD=postgres',
    '-p', '127.0.0.1::5432',
    process.env.PURGE_DELETED_TEST_IMAGE || 'pgvector/pgvector:pg16',
  ], { encoding: 'utf8' }).trim();
  t.after(() => {
    try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch {}
  });

  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)!;
  const ownerUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  const appUrl = `postgresql://${APP_ROLE}:${APP_PASSWORD}@127.0.0.1:${port}/postgres`;
  const bypassUrl = `postgresql://${BYPASS_ROLE}:${BYPASS_PASSWORD}@127.0.0.1:${port}/postgres`;
  const owner = await connectWhenReady(ownerUrl);
  t.after(() => owner.end().catch(() => undefined));

  await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
  await owner.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'`);
  const migrationDirectory = join(process.cwd(), 'migrations');
  for (const file of readdirSync(migrationDirectory).filter(file => /^\d+_.*\.sql$/.test(file)).sort()) {
    await owner.query(readFileSync(join(migrationDirectory, file), 'utf8'));
  }
  await owner.query(`CREATE ROLE ${BYPASS_ROLE} LOGIN PASSWORD '${BYPASS_PASSWORD}' BYPASSRLS`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${BYPASS_ROLE}`);
  await owner.query(`GRANT SELECT ON public.memories TO ${BYPASS_ROLE}`);
  await owner.query(`
    CREATE TABLE public.purge_dynamic_references (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      memory_id uuid NOT NULL,
      CONSTRAINT purge_dynamic_memory_fk
        FOREIGN KEY (memory_id) REFERENCES public.memories(id)
    )
  `);

  await t.test('owner and BYPASSRLS identities pass all-row preflight while the app role fails closed', async () => {
    assert.equal((await prepareAllRowMaintenance(owner)).user, 'postgres');

    const bypass = await connectWhenReady(bypassUrl);
    const app = await connectWhenReady(appUrl);
    try {
      assert.equal((await prepareAllRowMaintenance(bypass)).user, BYPASS_ROLE);
      await assert.rejects(
        prepareAllRowMaintenance(app),
        /all-row maintenance preflight failed.*owner or a BYPASSRLS role/i,
      );
    } finally {
      await Promise.all([bypass.end(), app.end()]);
    }
  });

  await t.test('preview includes only expired tombstones and retains media plus dynamically discovered FK references', async () => {
    await resetScenario(owner);
    await insertMemory(owner, IDS.active, null);
    await insertMemory(owner, IDS.recent, '2020-01-01T00:00:00Z');
    await owner.query(
      'UPDATE public.memories SET deleted_at = statement_timestamp() - INTERVAL \'29 days\' WHERE id = $1',
      [IDS.recent],
    );
    for (const id of [IDS.eligible, IDS.mediaBlocked, IDS.dynamicBlocked]) {
      await insertMemory(owner, id, '2020-01-01T00:00:00Z');
    }
    await owner.query(
      `INSERT INTO public.media_events
         (service, service_id, event_type, title, played_at, memory_id)
       VALUES ('purge-test', 'media-block', 'play', 'blocked', statement_timestamp(), $1::uuid)`,
      [IDS.mediaBlocked],
    );
    await owner.query(
      'INSERT INTO public.purge_dynamic_references (memory_id) VALUES ($1::uuid)',
      [IDS.dynamicBlocked],
    );

    const preview = await previewDeletedWithClient(owner, [NAMESPACE]);
    assert.deepEqual(preview.candidates.map(row => row.id), [IDS.eligible]);
    assert.deepEqual(
      new Map(preview.blocked.map(row => [row.id, row.reason])),
      new Map([
        [IDS.mediaBlocked, 'media_events'],
        [IDS.dynamicBlocked, 'foreign_key:purge_dynamic_memory_fk'],
      ]),
    );
    assert.ok(!preview.candidates.some(row => row.id === IDS.active || row.id === IDS.recent));
  });

  await t.test('successful apply hard-deletes the tombstone and commits one content-free memory.purge audit', async () => {
    await resetScenario(owner);
    await insertMemory(owner, IDS.eligible, '2020-01-01T00:00:00Z');
    const preview = await previewDeletedWithClient(owner, [NAMESPACE]);

    assert.deepEqual(await applyDeletedWithClient(owner, [NAMESPACE], preview), { purged: 1, blocked: 0 });
    assert.equal((await owner.query('SELECT count(*)::int AS count FROM public.memories')).rows[0].count, 0);
    const audit = await owner.query(
      `SELECT client_id, action, namespace, memory_id::text, query_text, result_count
       FROM public.audit_log ORDER BY id`,
    );
    assert.deepEqual(audit.rows, [{
      client_id: 'maintenance:memory-purge',
      action: 'memory.purge',
      namespace: NAMESPACE,
      memory_id: IDS.eligible,
      query_text: null,
      result_count: null,
    }]);
  });

  await t.test('audit insertion failure rolls back the hard delete', async () => {
    await resetScenario(owner);
    await insertMemory(owner, IDS.auditRollback, '2020-01-01T00:00:00Z');
    const preview = await previewDeletedWithClient(owner, [NAMESPACE]);
    await owner.query(`
      CREATE FUNCTION public.purge_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'memory.purge' THEN RAISE EXCEPTION 'forced purge audit failure'; END IF;
        RETURN NEW;
      END $$
    `);
    await owner.query(
      'CREATE TRIGGER purge_fail_audit BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.purge_fail_audit()',
    );

    await assert.rejects(
      applyDeletedWithClient(owner, [NAMESPACE], preview),
      /forced purge audit failure/,
    );
    assert.equal((await owner.query('SELECT count(*)::int AS count FROM public.memories')).rows[0].count, 1);
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM public.audit_log WHERE action = 'memory.purge'")).rows[0].count, 0);
  });

  await t.test('a reference committed after initial validation is rechecked before delete', async () => {
    await resetScenario(owner);
    await insertMemory(owner, IDS.concurrentBlocked, '2020-01-01T00:00:00Z');
    const preview = await previewDeletedWithClient(owner, [NAMESPACE]);
    const concurrent = await connectWhenReady(ownerUrl);
    let inserted = false;
    const interleavedClient: QueryClient = {
      async query<T = any>(sql: string, values?: unknown[]) {
        if (!inserted && /FOR UPDATE/i.test(sql)) {
          inserted = true;
          await concurrent.query(
            'INSERT INTO public.purge_dynamic_references (memory_id) VALUES ($1::uuid)',
            [IDS.concurrentBlocked],
          );
        }
        const result = await owner.query(sql, values as any[] | undefined);
        return result as { rows: T[]; rowCount: number | null };
      },
    };

    try {
      await assert.rejects(
        applyDeletedWithClient(interleavedClient, [NAMESPACE], preview),
        /drifted or became referenced/i,
      );
    } finally {
      await concurrent.end();
    }
    assert.equal(inserted, true);
    assert.equal((await owner.query('SELECT count(*)::int AS count FROM public.memories')).rows[0].count, 1);
    assert.equal((await owner.query('SELECT count(*)::int AS count FROM public.purge_dynamic_references')).rows[0].count, 1);
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM public.audit_log WHERE action = 'memory.purge'")).rows[0].count, 0);
  });

  await t.test('a competing session advisory lock rejects apply before audit or deletion', async () => {
    await resetScenario(owner);
    await insertMemory(owner, IDS.lockBlocked, '2020-01-01T00:00:00Z');
    const preview = await previewDeletedWithClient(owner, [NAMESPACE]);
    const blocker = await connectWhenReady(ownerUrl);
    try {
      await blocker.query('SELECT pg_advisory_lock($1)', [PURGE_LOCK_KEY]);
      await assert.rejects(
        applyDeletedWithClient(owner, [NAMESPACE], preview),
        /another memory purge is already running/i,
      );
      assert.equal((await owner.query('SELECT count(*)::int AS count FROM public.memories')).rows[0].count, 1);
      assert.equal((await owner.query("SELECT count(*)::int AS count FROM public.audit_log WHERE action = 'memory.purge'")).rows[0].count, 0);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1)', [PURGE_LOCK_KEY]).catch(() => undefined);
      await blocker.end();
    }
  });
});
