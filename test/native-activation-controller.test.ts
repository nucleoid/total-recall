import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  buildRemoteCommand,
  isAcceptedNotificationReceipt,
  notificationIdempotencyKey,
  notifyFailure,
  parseNativeActivationCli,
  quoteRemoteArg,
  reserveDailyGenerationCalls,
  runNativeActivation,
} from '../scripts/native-activation-controller.js';

const execFileAsync = promisify(execFile);

const NOW = new Date('2026-11-24T12:00:00.000Z');
const approval = { approved: true as const, approvedBy: 'owner', approvedAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-12-31T00:00:00Z' };
const sessionPolicy = {
  version: 1, feature: 'memory-session-distillation', environment: 'test',
  generation: { provider: 'openclaw-adapter', model: 'openclaw/total-recall-synthesis',
    endpoint: 'https://example.invalid/generate', credentialEnv: 'GENERATION_API_KEY' },
  terms: { reference: 'review', privacyApproved: true, retentionApproved: true, trainingApproved: true },
  scope: { namespaces: ['shared'], accessLevel: 'normal' },
  budget: { mode: 'subscription', maxInputBytesPerSession: 1024,
    maxOutputBytesPerSession: 1024, usageControlReference: 'subscription-control' },
  providerModelApproval: approval, termsApproval: approval, scopeApproval: approval, budgetApproval: approval,
};
const sessionPolicyJson = JSON.stringify(sessionPolicy);
const sessionPolicySha256 = createHash('sha256').update(sessionPolicyJson).digest('hex');

async function fixture(t: test.TestContext, feature = 'session') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-activation-'));
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })); });
  const configFile = path.join(root, 'config.json');
  const profile = feature === 'session' ? 'queued-session' : 'delivery';
  const mode = 'once';
  const generation = feature === 'session';
  const value: any = {
    version: 1, feature, enabled: true, container: 'total-recall-ingestion-1',
    environmentFile: '/etc/total-recall/private/native.env', timeoutSeconds: 120,
    dailyGenerationCallCap: 6,
    approval: { reference: 'approval-12', approvedBy: 'owner', approvedAt: '2026-11-24T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z' },
    lanes: [{ namespace: 'shared', accessLevel: 'normal', profile, mode }],
  };
  if (generation) Object.assign(value, { policyFile: '/app/policies/session.json',
    policySha256: sessionPolicySha256, policyEnvironment: 'test',
    adapterProfile: 'openclaw-main-subscription' });
  await writeFile(configFile, JSON.stringify(value));
  await chmod(configFile, 0o600);
  return { root, configFile, value };
}

test('remote command quoting cannot turn validated argv into shell syntax', () => {
  assert.equal(quoteRemoteArg("a'b"), "'a'\\''b'");
  assert.equal(buildRemoteCommand(['/usr/bin/printf', '%s', '$(id); rm -rf /']),
    "'/usr/bin/printf' '%s' '$(id); rm -rf /'");
  assert.throws(() => quoteRemoteArg('bad\narg'), /control/);
});

test('CLI defaults to planning and requires an absolute config path', () => {
  assert.deepEqual(parseNativeActivationCli(['--config', '/etc/native.json']), {
    configFile: '/etc/native.json', execute: false, notificationDryRun: false,
  });
  assert.throws(() => parseNativeActivationCli(['--config', 'relative.json']), /absolute/);
});

test('daily generation reservation is durable, shared, and never exceeds cap', async t => {
  const { root } = await fixture(t);
  assert.deepEqual(await reserveDailyGenerationCalls(root, '2026-11-24', 6, 4), { used: 4, cap: 6 });
  assert.deepEqual(await reserveDailyGenerationCalls(root, '2026-11-24', 6, 2), { used: 6, cap: 6 });
  await assert.rejects(reserveDailyGenerationCalls(root, '2026-11-24', 6, 1), /budget_exhausted/);
  await assert.rejects(reserveDailyGenerationCalls(root, '2026-11-24', 5, 0), /state_invalid/);
});

test('default plan performs no SSH, Docker, notification, or invocation', async t => {
  const { root, configFile } = await fixture(t);
  let calls = 0;
  const receipt = await runNativeActivation({ configFile, execute: false, notificationDryRun: false }, {
    stateRoot: path.join(root, 'state'), now: () => NOW,
    runFile: async () => { calls += 1; throw new Error('must not run'); },
  });
  assert.equal(receipt.status, 'planned');
  assert.equal(receipt.scopeBinding, 'unverified');
  assert.equal(calls, 0);
  const ledger = await readFile(path.join(root, 'state', 'ledger.jsonl'), 'utf8');
  assert.equal(ledger.includes('source content'), false);
});

test('planning startup does not require embedding configuration or the test setup importer', async t => {
  const { root, configFile } = await fixture(t);
  const env = { ...process.env, NATIVE_ACTIVATION_STATE_DIR: path.join(root, 'standalone-state') };
  for (const key of ['EMBEDDING_PROVIDER', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS', 'GEMINI_API_KEY',
    'EMBEDDING_CURRENT_PROFILE', 'EMBEDDING_PROFILES_JSON']) delete env[key];
  const result = await execFileAsync(process.execPath,
    ['--import', 'tsx', 'scripts/native-activation-controller.ts', '--config', configFile],
    { cwd: path.resolve('.'), env, timeout: 15_000, encoding: 'utf8' });
  assert.equal(JSON.parse(result.stdout).status, 'planned');
  assert.equal(result.stderr, '');
});

test('kernel lock prevents global overlap without PID state', async t => {
  const { root, configFile } = await fixture(t, 'webhook');
  const stateRoot = path.join(root, 'state');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const runFile = async (_file: string, args: readonly string[]) => {
    const remote = args.at(-1) ?? '';
    if (remote.includes("'/usr/bin/stat'")) return { stdout: '600\n', stderr: '' };
    entered();
    await held;
    return { stdout: '[webhook-delivery] stopped { processed: 0 }', stderr: '' };
  };
  const first = runNativeActivation({ configFile, execute: true, notificationDryRun: false },
    { stateRoot, now: () => NOW, runFile });
  await started;
  await assert.rejects(runNativeActivation({ configFile, execute: true, notificationDryRun: false },
    { stateRoot, now: () => NOW, runFile }), /native_activation_overlap/);
  release();
  assert.equal((await first).status, 'succeeded');
});

test('failure hook uses official CLI once, retains refusal, and blocks unchanged failure', async t => {
  const { root, configFile } = await fixture(t);
  const stateRoot = path.join(root, 'state');
  let notifications = 0;
  let remoteInvocations = 0;
  const runFile = async (file: string, args: readonly string[], timeoutMs?: number) => {
    if (file.endsWith('/openclaw')) {
      notifications += 1;
      assert.equal(timeoutMs, 30_000);
      assert.deepEqual(args.slice(0, 7), ['gateway', 'call', 'send', '--json', '--timeout', '15000', '--params']);
      const params = JSON.parse(args[7]);
      assert.equal(params.to, '1478120981435383808');
      assert.equal(params.channel, 'discord');
      assert.equal(params.accountId, 'default');
      assert.match(params.idempotencyKey, /^total-recall-native-failure-[a-f0-9]{64}$/);
      const persisted = JSON.parse(await readFile(path.join(stateRoot, 'session.state.json'), 'utf8'));
      assert.equal(persisted.blockedFailure.errorCode, 'native_cli_failed');
      assert.equal(params.idempotencyKey,
        notificationIdempotencyKey('session', persisted.blockedFailure.fingerprint));
      throw new Error('capability refused');
    }
    const remote = args.at(-1) ?? '';
    if (remote.includes("'/usr/bin/docker'") && remote.includes("'/usr/bin/stat'")) {
      return { stdout: `${Buffer.byteLength(sessionPolicyJson)}\n`, stderr: '' };
    }
    if (remote.includes("'/usr/bin/stat'")) return { stdout: '600\n', stderr: '' };
    if (remote.includes("'/usr/bin/sha256sum'")) return { stdout: `${sessionPolicySha256}  /app/policies/session.json\n`, stderr: '' };
    if (remote.includes("'/usr/bin/cat'")) return { stdout: sessionPolicyJson, stderr: '' };
    remoteInvocations += 1;
    throw new Error('native command failed');
  };
  let failure: any;
  try {
    await runNativeActivation({ configFile, execute: true, notificationDryRun: false },
      { stateRoot, now: () => NOW, runFile });
  } catch (error) { failure = error; }
  assert.equal(failure.receipt.status, 'failed');
  assert.deepEqual(failure.receipt.notification, { status: 'refused', code: 'official_cli_refused' });
  const budget = JSON.parse(await readFile(path.join(stateRoot, 'generation-budget-2026-11-24.json'), 'utf8'));
  assert.equal(budget.used, 1, 'ambiguous or failed invocation retains its full reservation');
  assert.equal(notifications, 1);
  const blocked = await runNativeActivation({ configFile, execute: true, notificationDryRun: false },
    { stateRoot, now: () => NOW, runFile });
  assert.equal(blocked.status, 'blocked');
  assert.equal(notifications, 1);
  assert.equal(remoteInvocations, 1);
});

test('policy scope mismatch fails before reservation or native feature dispatch', async t => {
  const { root, configFile } = await fixture(t);
  const stateRoot = path.join(root, 'state');
  const mismatched = JSON.stringify({ ...sessionPolicy,
    scope: { namespaces: ['other'], accessLevel: 'normal' } });
  const mismatchedSha256 = createHash('sha256').update(mismatched).digest('hex');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.policySha256 = mismatchedSha256;
  await writeFile(configFile, JSON.stringify(config));
  let featureInvocations = 0;
  const runFile = async (file: string, args: readonly string[]) => {
    if (file.endsWith('/openclaw')) return { stdout: '{"ok":true}', stderr: '' };
    const remote = args.at(-1) ?? '';
    if (remote.includes("'/usr/bin/docker'") && remote.includes("'/usr/bin/stat'")) {
      return { stdout: `${Buffer.byteLength(mismatched)}\n`, stderr: '' };
    }
    if (remote.includes("'/usr/bin/stat'")) return { stdout: '600\n', stderr: '' };
    if (remote.includes("'/usr/bin/sha256sum'")) {
      return { stdout: `${mismatchedSha256}  /app/policies/session.json\n`, stderr: '' };
    }
    if (remote.includes("'/usr/bin/cat'")) return { stdout: mismatched, stderr: '' };
    featureInvocations += 1;
    throw new Error('must not dispatch');
  };
  let failure: any;
  try {
    await runNativeActivation({ configFile, execute: true, notificationDryRun: true },
      { stateRoot, now: () => NOW, runFile });
  } catch (error) { failure = error; }
  assert.equal(failure.receipt.errorCode, 'policy_scope_mismatch');
  assert.equal(failure.receipt.scopeBinding, 'unverified');
  assert.equal(failure.receipt.generationCallsReserved, 0);
  assert.equal(featureInvocations, 0);
  await assert.rejects(readFile(path.join(stateRoot, 'generation-budget-2026-11-24.json')), /ENOENT/);
});

test('one owner rotates lanes and uses the same selected binding for preflight and dispatch', async t => {
  const { root, configFile, value } = await fixture(t);
  const workPolicy = JSON.stringify({ ...sessionPolicy, scope: { namespaces: ['work'], accessLevel: 'normal' } });
  const workSha = createHash('sha256').update(workPolicy).digest('hex');
  delete value.environmentFile;
  delete value.policyFile;
  delete value.policySha256;
  delete value.policyEnvironment;
  value.lanes = [
    { namespace: 'shared', accessLevel: 'normal', profile: 'queued-session', mode: 'once', binding: {
      environmentFile: '/private/session-shared.env', policyFile: '/policies/shared.json',
      policySha256: sessionPolicySha256, policyEnvironment: 'test',
    } },
    { namespace: 'work', accessLevel: 'normal', profile: 'queued-session', mode: 'once', binding: {
      environmentFile: '/private/session-work.env', policyFile: '/policies/work.json',
      policySha256: workSha, policyEnvironment: 'test',
    } },
  ];
  await writeFile(configFile, JSON.stringify(value));
  const dispatched: string[] = [];
  const runFile = async (_file: string, args: readonly string[]) => {
    const remote = args.at(-1) ?? '';
    if (remote.includes("'/usr/bin/stat'") && !remote.includes("'/usr/bin/docker'")) return { stdout: '600\n', stderr: '' };
    if (remote.includes("'/usr/bin/docker'") && remote.includes("'/usr/bin/stat'")) {
      return { stdout: `${Buffer.byteLength(remote.includes('work.json') ? workPolicy : sessionPolicyJson)}\n`, stderr: '' };
    }
    if (remote.includes("'/usr/bin/sha256sum'")) return {
      stdout: `${remote.includes('work.json') ? workSha : sessionPolicySha256}  policy.json\n`, stderr: '',
    };
    if (remote.includes("'/usr/bin/cat'")) return {
      stdout: remote.includes('work.json') ? workPolicy : sessionPolicyJson, stderr: '',
    };
    dispatched.push(remote);
    return { stdout: '[session-distill] stopped { processed: 1 }', stderr: '' };
  };
  const stateRoot = path.join(root, 'bound-state');
  const first = await runNativeActivation({ configFile, execute: true, notificationDryRun: false },
    { stateRoot, now: () => NOW, runFile });
  const second = await runNativeActivation({ configFile, execute: true, notificationDryRun: false },
    { stateRoot, now: () => NOW, runFile });
  assert.equal(first.policyHash, sessionPolicySha256);
  assert.equal(second.policyHash, workSha);
  assert.match(dispatched[0], /session-shared\.env/);
  assert.match(dispatched[0], /SESSION_DISTILLATION_POLICY_FILE=\/policies\/shared\.json/);
  assert.doesNotMatch(dispatched[0], /session-work\.env|work\.json/);
  assert.match(dispatched[1], /session-work\.env/);
  assert.match(dispatched[1], /SESSION_DISTILLATION_POLICY_FILE=\/policies\/work\.json/);
});

test('maintenance dispatches only the fixed host launcher without container credentials', async t => {
  const { root, configFile, value } = await fixture(t, 'webhook');
  value.feature = 'maintenance';
  delete value.environmentFile;
  value.lanes = [{ namespace: 'shared', accessLevel: 'normal', profile: 'bounded-owner', mode: 'once' }];
  await writeFile(configFile, JSON.stringify(value));
  let remote = '';
  const receipt = await runNativeActivation({ configFile, execute: true, notificationDryRun: false }, {
    stateRoot: path.join(root, 'maintenance-state'), now: () => NOW,
    runFile: async (_file, args) => {
      remote = args.at(-1) ?? '';
      return { stdout: JSON.stringify({ version: 1, kind: 'bounded_native_decay', status: 'pass_complete',
        classificationsFinalized: true }), stderr: '' };
    },
  });
  assert.equal(receipt.status, 'succeeded');
  assert.equal(remote, "'/usr/bin/python3' '/home/cass/total-recall-move-20261117/release/scripts/native-maintenance-owner-launcher.py'");
  assert.doesNotMatch(remote, /docker|env-file|DATABASE_URL/);
});

test('official gateway notification uses fixed route, stable idempotency, and strict receipt', async () => {
  let sent: readonly string[] = [];
  let timeout = 0;
  const fingerprint = 'a'.repeat(64);
  const result = await notifyFailure('webhook', 'native_cli_failed', fingerprint, false,
    async (file, args, timeoutMs) => {
      assert.equal(file, '/home/fuego/.npm-global/bin/openclaw');
      sent = args;
      timeout = timeoutMs;
      return { stdout: JSON.stringify({ runId: 'bounded-test', messageId: '1574776696404578336',
        channel: 'discord' }), stderr: '' };
  });
  assert.equal(result?.status, 'cli_accepted');
  assert.equal(timeout, 30_000);
  assert.deepEqual(sent.slice(0, 7), ['gateway', 'call', 'send', '--json', '--timeout', '15000', '--params']);
  const params = JSON.parse(sent[7]);
  assert.deepEqual(params, {
    to: '1478120981435383808',
    message: 'Total Recall native feature failure: feature=webhook error=native_cli_failed. Feature is stopped until its configuration or state changes.',
    channel: 'discord', accountId: 'default',
    idempotencyKey: notificationIdempotencyKey('webhook', fingerprint),
  });
  assert.equal(params.message.includes('stderr'), false);
  assert.equal(notificationIdempotencyKey('webhook', fingerprint),
    notificationIdempotencyKey('webhook', fingerprint));
  assert.notEqual(notificationIdempotencyKey('webhook', fingerprint),
    notificationIdempotencyKey('webhook', 'b'.repeat(64)));
});

test('official gateway receipt rejects malformed, wrong-channel, and error responses', () => {
  assert.equal(isAcceptedNotificationReceipt({ ok: true }), false);
  assert.equal(isAcceptedNotificationReceipt({ channel: 'discord', messageId: '1' }), false);
  assert.equal(isAcceptedNotificationReceipt({ channel: 'slack', messageId: '1574776696404578336' }), false);
  assert.equal(isAcceptedNotificationReceipt({ channel: 'discord', messageId: '1574776696404578336',
    error: 'refused' }), false);
  assert.equal(isAcceptedNotificationReceipt({ channel: 'discord', messageId: '1574776696404578336' }), true);
});

test('notification failures retain safe timeout and invalid-receipt classifications', async () => {
  const fingerprint = 'a'.repeat(64);
  assert.deepEqual(await notifyFailure('webhook', 'native_cli_failed', fingerprint, false, async () => {
    throw Object.assign(new Error('private detail'), { code: 'ETIMEDOUT', killed: true });
  }), { status: 'refused', code: 'official_cli_timeout' });
  assert.deepEqual(await notifyFailure('webhook', 'native_cli_failed', fingerprint, false, async () => ({
    stdout: '{"ok":true}', stderr: 'private detail',
  })), { status: 'refused', code: 'official_cli_invalid_receipt' });
  assert.deepEqual(await notifyFailure('webhook', 'native_cli_failed', fingerprint, false, async () => ({
    stdout: JSON.stringify({ channel: 'slack', messageId: '1574776696404578336' }), stderr: '',
  })), { status: 'refused', code: 'official_cli_invalid_receipt' });
});

test('notification dry-run fails closed without invoking the live gateway method', async () => {
  let invoked = false;
  assert.deepEqual(await notifyFailure('webhook', 'native_cli_failed', 'a'.repeat(64), true, async () => {
    invoked = true;
    throw new Error('must not run');
  }), { status: 'refused', code: 'official_gateway_dry_run_unsupported' });
  assert.equal(invoked, false);
});
