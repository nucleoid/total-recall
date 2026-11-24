import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('systemd templates are resource-bounded and planning-only', async () => {
  const [service, timer] = await Promise.all([
    readFile('deploy/systemd/total-recall-native-activation@.service', 'utf8'),
    readFile('deploy/systemd/total-recall-native-activation@.timer', 'utf8'),
  ]);
  assert.match(service, /CPUQuota=25%/);
  assert.match(service, /MemoryMax=384M/);
  assert.match(service, /MemorySwapMax=0/);
  assert.match(service, /RuntimeMaxSec=240/);
  assert.doesNotMatch(service, /ExecStart=.*--execute/);
  assert.match(timer, /Persistent=false/);
  assert.doesNotMatch(service + timer, /openclaw.*automation|cron/);
});

test('runbook keeps product scheduling separate from conversation continuation and documents failure canary', async () => {
  const runbook = await readFile('docs/native-activation-owner-runbook.md', 'utf8');
  assert.match(runbook, /does not create an OpenClaw automation, model turn, task continuation/i);
  assert.match(runbook, /official command only/i);
  assert.match(runbook, /openclaw gateway call send --json --timeout 15000/);
  assert.match(runbook, /stable idempotency key derived from the feature and durable failure fingerprint/i);
  assert.match(runbook, /parent must read back the channel independently/i);
  assert.match(runbook, /notification\.status="refused"/);
  assert.match(runbook, /completedBefore/);
  assert.match(runbook, /sourceGraphCoverage: "pending"/);
  assert.match(runbook, /zero generation reservation, and zero native CLI invocation/i);
  assert.match(runbook, /Success never sends a notification/i);
  assert.match(runbook, /do not create one service or timer per lane/i);
  assert.match(runbook, /native-maintenance-owner-launcher\.py/);
  assert.match(runbook, /run-reviewed/);
  assert.match(runbook, /official_cli_timeout|timeout, nonzero exit/i);
});
