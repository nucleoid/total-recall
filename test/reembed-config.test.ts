import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  connectMaintenanceClient,
  resolveMaintenanceDatabaseConfig,
  resolveMaintenanceDatabaseUrl,
  withMaintenanceClient,
} from '../scripts/lib/maintenance-db.js';

test('maintenance URL keeps #35 aliases and identifies the exact runtime DATABASE_URL fallback', () => {
  const encoded = 'postgres://operator:p%40ss%2Fword@db.example:5432/selected';
  assert.equal(resolveMaintenanceDatabaseUrl({
    MAINTENANCE_DATABASE_URL: 'postgres://maintenance/first',
    MIGRATION_DATABASE_URL: 'postgres://migration/compatible',
    OWNER_DATABASE_URL: 'postgres://owner/compatible',
    DATABASE_URL: encoded,
  }), 'postgres://maintenance/first');
  assert.equal(resolveMaintenanceDatabaseUrl({
    MIGRATION_DATABASE_URL: 'postgres://migration/compatible',
    OWNER_DATABASE_URL: 'postgres://owner/compatible',
    DATABASE_URL: encoded,
  }), 'postgres://migration/compatible');
  assert.equal(resolveMaintenanceDatabaseUrl({
    OWNER_DATABASE_URL: 'postgres://owner/compatible',
    DATABASE_URL: encoded,
  }, () => undefined), 'postgres://owner/compatible');
  assert.equal(resolveMaintenanceDatabaseUrl({ DATABASE_URL: encoded }), encoded);
  assert.deepEqual(resolveMaintenanceDatabaseConfig({ DATABASE_URL: encoded }), {
    connectionString: encoded,
    source: 'DATABASE_URL',
  });
});

test('missing or blank maintenance configuration fails before client construction without leaking values', async () => {
  let constructions = 0;
  const secret = 'postgres://operator:do-not-print@db/private';
  for (const env of [{}, { DATABASE_URL: '  ' }]) {
    await assert.rejects(
      connectMaintenanceClient(env, (() => {
        constructions++;
        throw new Error(secret);
      }) as never),
      error => {
        assert.match(String(error), /DATABASE_URL/);
        assert.doesNotMatch(String(error), /do-not-print|postgres:\/\//);
        return true;
      },
    );
  }
  assert.equal(constructions, 0);
});

test('process DATABASE_URL wins over dotenv before and after importing live embedding code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reembed-config-'));
  await writeFile(join(directory, '.env'), 'DATABASE_URL=postgres://dotenv/incorrect\n');
  const maintenanceModule = new URL('../scripts/lib/maintenance-db.ts', import.meta.url).href;
  const embeddingModule = new URL('../src/embedding.ts', import.meta.url).href;
  const script = `
    import { resolveMaintenanceDatabaseUrl } from ${JSON.stringify(maintenanceModule)};
    console.log('BEFORE=' + resolveMaintenanceDatabaseUrl(process.env));
    await import(${JSON.stringify(embeddingModule)});
    console.log('AFTER=' + resolveMaintenanceDatabaseUrl(process.env));
  `;
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script], {
    cwd: directory,
    env: { ...process.env, DATABASE_URL: 'postgres://process/selected' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BEFORE=postgres:\/\/process\/selected/);
  assert.match(result.stdout, /AFTER=postgres:\/\/process\/selected/);
  assert.doesNotMatch(result.stdout + result.stderr, /postgres:\/\/dotenv\/incorrect/);
});

test('withMaintenanceClient passes the exact selected URL and closes once on success and failure', async () => {
  for (const shouldFail of [false, true]) {
    let selected = '';
    let ended = 0;
    const client = {
      async connect() {},
      async query(sql: string) {
        if (/current_database/i.test(sql)) return { rows: [{ database: 'selected', user: 'owner', server: 'db:5432' }] };
        return { rows: [{ count: '0' }] };
      },
      async end() { ended++; },
    };
    const operation = withMaintenanceClient(
      { DATABASE_URL: 'postgres://custom/nondefault' },
      async (_client, identity) => {
        assert.equal(identity.database, 'selected');
        if (shouldFail) throw new Error('operation failed');
        return 'done';
      },
      (url => { selected = url; return client; }) as never,
    );
    if (shouldFail) await assert.rejects(operation, /operation failed/);
    else assert.equal(await operation, 'done');
    assert.equal(selected, 'postgres://custom/nondefault');
    assert.equal(ended, 1);
  }
});

test('reembed source contains no literal development connection string', async () => {
  const source = await readFile(new URL('../scripts/reembed-all.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /postgres(?:ql)?:\/\//i);
});

test('DATABASE_URL fallback completes the all-row capability gate before invoking maintenance work', async () => {
  let operationCalls = 0;
  let ended = 0;
  const client = {
    async connect() {},
    async query(sql: string) {
      if (/current_database/i.test(sql)) return { rows: [{ database: 'selected', user: 'runtime', server: 'db:5432' }] };
      if (/FROM public\.memories/i.test(sql)) throw new Error('query would be affected by row-level security policy');
      return { rows: [] };
    },
    async end() { ended++; },
  };

  await assert.rejects(
    withMaintenanceClient(
      { DATABASE_URL: 'postgres://runtime/selected' },
      async () => { operationCalls++; },
      (() => client) as never,
    ),
    /all-row maintenance preflight failed/i,
  );
  assert.equal(operationCalls, 0);
  assert.equal(ended, 1);
});

test('operator configuration and runbook document audited, immediate safe reembedding', async () => {
  const envExample = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(envExample, /DATABASE_URL=/);
  assert.match(envExample, /# MAINTENANCE_DATABASE_URL=/);
  assert.match(envExample, /MAINTENANCE_DATABASE_URL[^\n]*optional/i);
  assert.doesNotMatch(envExample, /^MAINTENANCE_DATABASE_URL=\S+/m);

  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /verified restorable backup/i);
  assert.match(readme, /current_database\(\).*current_user/is);
  assert.match(readme, /DATABASE_URL=.*npm run reembed/);
  assert.match(readme, /DATABASE_URL[^.]*only when no maintenance alias[^.]*printed `source`/is);
  assert.match(readme, /DATABASE_URL[^.]*owner|owner[^.]*DATABASE_URL/is);
  assert.match(readme, /BYPASSRLS/);
  assert.match(readme, /noninteractive[^.]*immediate|immediate[^.]*noninteractive/i);
  assert.match(readme, /audit[^.]*GEMINI_API_KEY[^.]*EMBEDDING_MODEL[^.]*EMBEDDING_DIMENSIONS[^.]*OLLAMA_/is);
  assert.match(readme, /must not|never[^.]*deploy-time|deploy-time[^.]*never/i);
});
