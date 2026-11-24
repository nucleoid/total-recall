import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { loadMigrationInventory, runMigrations } from '../scripts/migrate.js';
import {
  executeNativeMaintenancePage,
  verifyNativeMaintenanceOwner,
  type NativeMaintenanceState,
} from '../scripts/native-maintenance-owner.js';
import { provisionDatabase } from '../scripts/provision-db.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

test('native owner processes one current page, safely replays, completes, and preserves source history', { timeout: 240_000 }, async t => {
  const port = await freePort();
  const container = execFileSync('docker', ['run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=test-only',
    '-p', `127.0.0.1:${port}:5432`, process.env.POSTGRES_TEST_IMAGE || 'pgvector/pgvector:pg16'], { encoding: 'utf8' }).trim();
  let bootstrap: pg.Client | undefined; let owner: pg.Client | undefined;
  t.after(async () => {
    if (owner) await owner.end(); if (bootstrap) await bootstrap.end();
    try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch {}
  });
  const postgresUrl = `postgresql://postgres:test-only@127.0.0.1:${port}/postgres`;
  for (let index = 0; index < 150; index += 1) {
    const candidate = new pg.Client({ connectionString: postgresUrl, connectionTimeoutMillis: 2_000 });
    try { await candidate.connect(); bootstrap = candidate; break; }
    catch { await candidate.end(); await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(bootstrap); await bootstrap.query('CREATE DATABASE total_recall'); await bootstrap.end(); bootstrap = undefined;
  const ownerUrl = `postgresql://postgres:test-only@127.0.0.1:${port}/total_recall`;
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  await owner.query('CREATE EXTENSION vector');
  await provisionDatabase(owner, { appPassword: 'app-test-only', rotateAppPassword: false });
  await runMigrations(owner, loadMigrationInventory(fileURLToPath(new URL('../migrations', import.meta.url))), { lockTimeoutMs: 5_000 });

  const now = new Date(Date.now() - 1_000);
  const asOf = new Date(now.getTime() - 600_000);
  for (let index = 1; index <= 101; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    await owner.query(`INSERT INTO memories(id,content,source,namespace,access_level,client_id,memory_kind,valid_from,
      relevance_score,relevance_base_score,decay_rate,accessed_at,access_count)
      VALUES($1,$2,'synthetic','personal','secret','legacy-owner','semantic',$3,0,1,0.01,$3,7)`,
    [id, `source-${index}`, asOf]);
  }
  const expiredId = '10000000-0000-4000-8000-000000000001';
  await owner.query(`INSERT INTO memories(id,content,source,namespace,access_level,client_id,memory_kind,valid_from,
    relevance_score,relevance_base_score,decay_rate,accessed_at,access_count,expires_at)
    VALUES($1,'expired-source','synthetic','personal','secret','legacy-owner','semantic',$2,0,1,0.01,$2,7,$3)`,
  [expiredId, asOf, new Date(asOf.getTime() + 300_000)]);

  await assert.rejects(verifyNativeMaintenanceOwner(owner), /finalized relevance classifications/i);
  await owner.query('ALTER TABLE memories ALTER COLUMN relevance_base_score SET NOT NULL');
  await verifyNativeMaintenanceOwner(owner);
  const before = (await owner.query(`SELECT count(*)::int AS count, sum(access_count)::int AS accesses,
    md5(string_agg(id::text||content||source||namespace||access_level||client_id||accessed_at::text, '' ORDER BY id)) AS source_hash
    FROM memories`)).rows[0];
  const initial: NativeMaintenanceState = { version: 1, passDay: asOf.toISOString().slice(0, 10),
    asOf: asOf.toISOString(), afterId: null, complete: false, completedDay: null };

  const locker = new pg.Client({ connectionString: ownerUrl }); await locker.connect();
  await locker.query('BEGIN');
  await locker.query('SELECT id FROM memories WHERE id=$1 FOR UPDATE', ['00000000-0000-4000-8000-000000000001']);
  await assert.rejects(executeNativeMaintenancePage(owner, initial, now), /lock timeout|canceling statement due to lock timeout/i);
  assert.equal((await owner.query('SELECT count(*)::int AS count FROM memories WHERE relevance_score<>0')).rows[0].count, 0);
  await locker.query('ROLLBACK'); await locker.end();

  const first = await executeNativeMaintenancePage(owner, initial, now);
  assert.equal(first.receipt.selected, 100); assert.equal(first.receipt.updated, 100);
  assert.equal(first.receipt.complete, false); assert.ok(first.state.afterId);
  const replay = await executeNativeMaintenancePage(owner, initial, now);
  assert.equal(replay.receipt.selected, 100); assert.equal(replay.receipt.updated, 0);
  assert.equal(replay.receipt.asOf, first.receipt.asOf);
  const second = await executeNativeMaintenancePage(owner, first.state, now);
  assert.equal(second.receipt.selected, 1); assert.equal(second.receipt.updated, 1);
  assert.equal(second.receipt.complete, true);
  const completeNoOp = await executeNativeMaintenancePage(owner, second.state, now);
  assert.equal(completeNoOp.receipt.status, 'already_complete_today'); assert.equal(completeNoOp.summary, null);

  const after = (await owner.query(`SELECT count(*)::int AS count, sum(access_count)::int AS accesses,
    md5(string_agg(id::text||content||source||namespace||access_level||client_id||accessed_at::text, '' ORDER BY id)) AS source_hash
    FROM memories`)).rows[0];
  assert.deepEqual(after, before);
  assert.equal((await owner.query('SELECT count(*)::int AS count FROM memories WHERE id<>$1 AND relevance_score>0', [expiredId])).rows[0].count, 101);
  const expired = (await owner.query('SELECT relevance_score FROM memories WHERE id=$1', [expiredId])).rows[0];
  assert.equal(Number(expired.relevance_score), 0);
});
