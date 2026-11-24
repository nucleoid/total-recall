import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { MaintenanceQueryClient } from '../src/maintenance.js';
import {
  executeNativeMaintenancePage,
  NATIVE_MAINTENANCE_PAGE_SIZE,
  stateForInvocation,
  validateNativeMaintenanceState,
  writePrivateJsonAtomic,
  type NativeMaintenanceState,
} from '../scripts/native-maintenance-owner.js';

const now = new Date('2026-11-24T12:00:00.000Z');
const preflightClient = {
  async query<T>() {
    return { rows: [{ database: 'total_recall', role: 'postgres', null_bases: '0', base_not_null: true }] as T[] };
  },
} satisfies MaintenanceQueryClient;

const summary = (selected: number, updated: number, nextCursor: string | null) => ({
  count: updated, selected, updated, nextCursor, asOf: now.toISOString(), dryRun: false,
  byNamespace: updated ? { personal: updated } : {},
});

test('native maintenance state starts once, continues unfinished work, and starts a new pass only after a later UTC day', () => {
  const initial = stateForInvocation(null, now);
  assert.deepEqual(initial, { version: 1, passDay: '2026-11-24', asOf: now.toISOString(), afterId: null, complete: false, completedDay: null });
  const unfinished: NativeMaintenanceState = { ...initial, afterId: '00000000-0000-4000-8000-000000000001' };
  assert.deepEqual(stateForInvocation(unfinished, new Date('2026-11-25T01:00:00Z')), unfinished);
  const completed: NativeMaintenanceState = { ...unfinished, complete: true, completedDay: '2026-11-25' };
  assert.deepEqual(stateForInvocation(completed, new Date('2026-11-25T23:59:59Z')), completed);
  const next = stateForInvocation(completed, new Date('2026-11-26T00:00:01Z'));
  assert.equal(next.passDay, '2026-11-26'); assert.equal(next.afterId, null); assert.equal(next.complete, false);
  assert.throws(() => validateNativeMaintenanceState({ ...initial, complete: true }), /invalid/i);
});

test('one invocation is fixed to 100 rows and same-asOf replay is a score no-op', async () => {
  let calls = 0;
  const update = async (_client: unknown, options: { asOf: string; afterId?: string | null; limit: number; apply: boolean }) => {
    calls += 1;
    assert.equal(options.limit, NATIVE_MAINTENANCE_PAGE_SIZE); assert.equal(options.apply, true);
    assert.equal(options.asOf, now.toISOString()); assert.equal(options.afterId, null);
    return summary(100, calls === 1 ? 100 : 0, '00000000-0000-4000-8000-000000000100');
  };
  const first = await executeNativeMaintenancePage(preflightClient, null, now, update as never);
  assert.equal(first.receipt.status, 'page_applied'); assert.equal(first.state.complete, false);
  const replay = await executeNativeMaintenancePage(preflightClient, null, now, update as never);
  assert.equal(replay.receipt.updated, 0); assert.equal(replay.receipt.asOf, first.receipt.asOf);
  const completed = await executeNativeMaintenancePage(preflightClient, first.state, now,
    (async () => summary(1, 1, '00000000-0000-4000-8000-000000000101')) as never);
  assert.equal(completed.receipt.status, 'pass_complete'); assert.equal(completed.state.completedDay, '2026-11-24');
  const noOp = await executeNativeMaintenancePage(preflightClient, completed.state, now,
    (async () => { throw new Error('must not update'); }) as never);
  assert.equal(noOp.receipt.status, 'already_complete_today'); assert.equal(noOp.summary, null);
});

test('owner preflight failure prevents the page callback', async () => {
  let called = false;
  const badClient = { async query<T>() { return { rows: [{ database: 'total_recall', role: 'total_recall_app', null_bases: '0', base_not_null: true }] as T[] }; } } satisfies MaintenanceQueryClient;
  await assert.rejects(executeNativeMaintenancePage(badClient, null, now,
    (async () => { called = true; return summary(0, 0, null); }) as never), /exact postgres owner/i);
  assert.equal(called, false);
});

test('state and receipt writes are atomic private files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-maintenance-owner-'));
  const path = join(directory, 'state.json');
  await writePrivateJsonAtomic(path, { safe: true });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { safe: true });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writePrivateJsonAtomic(path, { safe: 'replaced' });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).safe, 'replaced');
});

test('fixed host launcher has no shell input and enforces the resource and namespace contract', async () => {
  const path = new URL('../scripts/native-maintenance-owner-launcher.py', import.meta.url);
  const source = await readFile(path, 'utf8');
  execFileSync('python3', ['-c', `compile(open(${JSON.stringify(path.pathname)}).read(), ${JSON.stringify(path.pathname)}, 'exec')`]);
  assert.match(source, /len\(sys\.argv\) != 1/);
  assert.match(source, /flock\(lock_fd, fcntl\.LOCK_EX \| fcntl\.LOCK_NB\)/);
  assert.match(source, /"--read-only"/); assert.match(source, /"--cap-drop=ALL"/);
  assert.match(source, /"--memory=256m"/); assert.match(source, /"--cpus=0\.25"/);
  assert.match(source, /"--pids-limit=64"/); assert.match(source, /size=32m/);
  assert.match(source, /"--env", "GOMAXPROCS=2"/);
  assert.match(source, /"--env", "UV_THREADPOOL_SIZE=1"/);
  assert.match(source, /"node", "--v8-pool-size=1"/);
  assert.match(source, /container:\{DATABASE_CONTAINER\}/);
  assert.match(source, /postgresql:\/\/postgres@127\.0\.0\.1:5432\/total_recall/);
  assert.match(source, /inspect_value\(INGESTION_CONTAINER, "\{\{\.Image\}\}"\)/);
  assert.doesNotMatch(source, /shell\s*=\s*True|os\.system|Popen/);
});

test('native page uses bounded ordinary locks and never cursor-skipping locks or destructive SQL', async () => {
  const source = await readFile(new URL('../scripts/native-maintenance-owner.ts', import.meta.url), 'utf8');
  assert.match(source, /SET LOCAL lock_timeout = '5s'/);
  assert.match(source, /SET LOCAL statement_timeout = '30s'/);
  assert.match(source, /FOR UPDATE\n/);
  assert.doesNotMatch(source, /SKIP LOCKED|DELETE FROM|ALTER TABLE|purgeExpiredMemories/);
});

test('runbook forbids password distribution, purge, busy loops, and arbitrary controller commands', async () => {
  const runbook = await readFile(new URL('../docs/native-maintenance-owner-runbook.md', import.meta.url), 'utf8');
  assert.match(runbook, /does not distribute an owner password/i);
  assert.match(runbook, /at most 100/i); assert.match(runbook, /no internal loop/i);
  assert.match(runbook, /must not expose a generic remote command/i);
  assert.match(runbook, /never calls TTL purge/i); assert.match(runbook, /mode 0600/i);
});
