import { randomBytes } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { appendFile, chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  buildInvocationPlan,
  configHash,
  parseNativeActivationConfig,
  resolveLaneBinding,
  validateNativePolicyForLane,
  validateKnownCliReceipt,
  type NativeActivationConfig,
  type NativeCommand,
  type NativeFeature,
  type NativeLaneBinding,
} from './native-activation-contract.js';

const execFile = promisify(execFileCallback);
const SSH = '/usr/bin/ssh';
const SSH_IDENTITY = '/home/fuego/.ssh/id_ed25519_dappnode';
const SSH_TARGET = 'cass@10.0.0.21';
const OPENCLAW_CLI = '/home/fuego/.npm-global/bin/openclaw';
const DISCORD_CHANNEL = '1478120981435383808';
const GATEWAY_SEND_TIMEOUT_MS = 15_000;
const GATEWAY_PROCESS_TIMEOUT_MS = 30_000;

interface Cli { configFile: string; execute: boolean; notificationDryRun: boolean }
interface ExecResult { stdout: string; stderr: string }
export interface ControllerDependencies {
  runFile?: (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;
  now?: () => Date;
  stateRoot?: string;
}

interface FeatureState {
  version: 1;
  nextLane: number;
  blockedFailure?: { fingerprint: string; configHash: string; errorCode: string; stateToken?: string };
}

interface Receipt {
  version: 1;
  feature: NativeFeature;
  status: 'planned' | 'disabled' | 'blocked' | 'succeeded' | 'failed';
  errorCode?: string;
  configHash: string;
  policyHash?: string;
  approvalReference: string;
  lane: { namespace: string; accessLevel: string; profile: string; mode: string };
  scopeBinding: 'unverified' | 'exact-lane' | 'policy-broader' | 'not-applicable';
  generationCallsReserved: number;
  sourceGraphCoverage: 'pending' | 'not-applicable';
  commandsCompleted: number;
  startedAt: string;
  finishedAt: string;
  notification?: { status: 'cli_accepted' | 'dry_run_accepted' | 'refused'; code?: string };
}

export function parseNativeActivationCli(args: string[]): Cli {
  let configFile = '';
  let execute = false;
  let notificationDryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--config') configFile = required(args[++index], arg);
    else if (arg === '--execute') execute = true;
    else if (arg === '--notification-dry-run') notificationDryRun = true;
    else throw new Error(`Unknown native activation option: ${arg}`);
  }
  if (!configFile.startsWith('/')) throw new Error('--config requires an absolute path');
  return { configFile, execute, notificationDryRun };
}

export function quoteRemoteArg(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) throw new Error('remote argument contains control characters');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildRemoteCommand(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error('remote command must not be empty');
  return argv.map(quoteRemoteArg).join(' ');
}

function defaultRunFile(file: string, args: readonly string[], timeoutMs: number): Promise<ExecResult> {
  return execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 256 * 1024, encoding: 'utf8',
    killSignal: 'SIGTERM' }) as Promise<ExecResult>;
}

export async function reserveDailyGenerationCalls(
  stateRoot: string,
  day: string,
  cap: number,
  requested: number,
): Promise<{ used: number; cap: number }> {
  const file = path.join(stateRoot, `generation-budget-${day}.json`);
  let current: { version: 1; day: string; cap: number; used: number } = { version: 1, day, cap, used: 0 };
  try { current = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (current.version !== 1 || current.day !== day || current.cap !== cap ||
      !Number.isSafeInteger(current.used) || current.used < 0 || current.used > cap) {
    throw new Error('generation_budget_state_invalid');
  }
  if (current.used + requested > cap) throw new Error('generation_budget_exhausted');
  current.used += requested;
  await atomicJson(file, current);
  return { used: current.used, cap };
}

export async function notifyFailure(
  feature: NativeFeature,
  errorCode: string,
  failureFingerprint: string,
  dryRun: boolean,
  runFile: NonNullable<ControllerDependencies['runFile']> = defaultRunFile,
): Promise<Receipt['notification']> {
  // The gateway send method has no dry-run contract. Never turn a notification
  // canary into a live send by silently dropping the caller's dry-run request.
  if (dryRun) return { status: 'refused', code: 'official_gateway_dry_run_unsupported' };
  const message = `Total Recall native feature failure: feature=${feature} error=${errorCode}. Feature is stopped until its configuration or state changes.`;
  const params = JSON.stringify({
    to: DISCORD_CHANNEL,
    message,
    channel: 'discord',
    accountId: 'default',
    idempotencyKey: notificationIdempotencyKey(feature, failureFingerprint),
  });
  const args = ['gateway', 'call', 'send', '--json', '--timeout', String(GATEWAY_SEND_TIMEOUT_MS),
    '--params', params];
  try {
    const result = await runFile(OPENCLAW_CLI, args, GATEWAY_PROCESS_TIMEOUT_MS);
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isAcceptedNotificationReceipt(parsed)) throw new Error('notification_receipt_invalid');
    return { status: 'cli_accepted' };
  } catch (error) {
    return { status: 'refused', code: classifyNotificationFailure(error) };
  }
}

export function notificationIdempotencyKey(feature: NativeFeature, failureFingerprint: string): string {
  if (!/^[a-f0-9]{64}$/.test(failureFingerprint)) throw new Error('failure_fingerprint_invalid');
  return `total-recall-native-failure-${configHash(JSON.stringify([feature, failureFingerprint]))}`;
}

function classifyNotificationFailure(error: unknown): string {
  if (error instanceof Error && error.message === 'notification_receipt_invalid') return 'official_cli_invalid_receipt';
  if (error instanceof SyntaxError) return 'official_cli_invalid_receipt';
  const value = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
  if (value?.killed || value?.code === 'ETIMEDOUT' || value?.signal === 'SIGTERM') return 'official_cli_timeout';
  if (typeof value?.code === 'number' || (typeof value?.code === 'string' && /^\d+$/.test(value.code))) {
    return 'official_cli_exit_nonzero';
  }
  return 'official_cli_refused';
}

export function isAcceptedNotificationReceipt(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return receipt.channel === 'discord' && typeof receipt.messageId === 'string' &&
    /^\d{17,20}$/.test(receipt.messageId) && !('error' in receipt);
}

export async function runNativeActivation(cli: Cli, dependencies: ControllerDependencies = {}): Promise<Receipt> {
  const now = dependencies.now ?? (() => new Date());
  const runFile = dependencies.runFile ?? defaultRunFile;
  const startedAt = now().toISOString();
  const rawConfig = await readPrivateConfig(cli.configFile);
  const hash = configHash(rawConfig);
  const config = parseNativeActivationConfig(JSON.parse(rawConfig.toString('utf8')), now());
  const root = dependencies.stateRoot ?? process.env.NATIVE_ACTIVATION_STATE_DIR ??
    path.join(process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? '/home/fuego', '.local/state'),
      'total-recall-native-activation');
  await mkdir(path.join(root, 'locks'), { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
  const locks = await acquireLocks([
    path.join(root, 'locks', 'global.lock'), path.join(root, 'locks', `${config.feature}.lock`),
  ]);
  try {
    const stateFile = path.join(root, `${config.feature}.state.json`);
    const state = await readFeatureState(stateFile);
    const laneIndex = state.nextLane % config.lanes.length;
    const plan = buildInvocationPlan(config, laneIndex);
    const laneBinding = resolveLaneBinding(config, plan.lane);
    let receiptScopeBinding: Receipt['scopeBinding'] = 'unverified';
    const base = (): Omit<Receipt, 'status' | 'finishedAt'> => ({
      version: 1, feature: config.feature, configHash: hash, policyHash: laneBinding?.policySha256,
      approvalReference: config.approval.reference,
      lane: { namespace: plan.lane.namespace, accessLevel: plan.lane.accessLevel,
        profile: plan.lane.profile, mode: plan.lane.mode },
      scopeBinding: receiptScopeBinding,
      generationCallsReserved: 0, sourceGraphCoverage: plan.sourceGraphCoverage,
      commandsCompleted: 0, startedAt,
    });
    if (!cli.execute) return writeReceipt(root, { ...base(), status: 'planned', finishedAt: now().toISOString() });
    if (!config.enabled) return writeReceipt(root, { ...base(), status: 'disabled', finishedAt: now().toISOString() });
    const currentStateToken = now().toISOString().slice(0, 10);
    if (state.blockedFailure?.configHash === hash &&
        (state.blockedFailure.stateToken === undefined || state.blockedFailure.stateToken === currentStateToken)) {
      return writeReceipt(root, { ...base(), status: 'blocked', errorCode: state.blockedFailure.errorCode,
        finishedAt: now().toISOString() });
    }

    let reserved = 0;
    let completed = 0;
    try {
      const policyBinding = await preflight(config, plan.lane, laneBinding, now(), runFile);
      receiptScopeBinding = policyBinding.scopeBinding;
      const generationCallHardMax = policyBinding.generationCallHardMax;
      if (generationCallHardMax > config.dailyGenerationCallCap) {
        throw new Error('generation_reservation_exceeds_daily_cap');
      }
      if (generationCallHardMax > 0) {
        const day = now().toISOString().slice(0, 10);
        await reserveDailyGenerationCalls(root, day, config.dailyGenerationCallCap, generationCallHardMax);
        reserved = generationCallHardMax;
      }
      for (const command of plan.commands) {
        const result = await runRemoteFeature(config, laneBinding, command, runFile);
        validateKnownCliReceipt(command.receiptKind, result.stdout, result.stderr);
        completed += 1;
      }
      await atomicJson(stateFile, { version: 1, nextLane: (laneIndex + 1) % config.lanes.length } satisfies FeatureState);
      return writeReceipt(root, { ...base(), status: 'succeeded', generationCallsReserved: reserved,
        commandsCompleted: completed, finishedAt: now().toISOString() });
    } catch (error) {
      const errorCode = classifyControllerError(error);
      // Daily budget exhaustion may resume only after the UTC budget state rolls
      // to a new day. All other static failures require config or explicit state repair.
      const stateToken = errorCode === 'generation_budget_exhausted' ? currentStateToken : undefined;
      const fingerprint = configHash(`${config.feature}\0${errorCode}\0${hash}\0${laneBinding?.policySha256 ?? ''}\0${stateToken ?? ''}`);
      const duplicate = state.blockedFailure?.fingerprint === fingerprint;
      // Persist the stop decision before the external CLI attempt. A crash,
      // process timeout, or ambiguous send must never retry unchanged failure.
      await atomicJson(stateFile, { version: 1, nextLane: laneIndex,
        blockedFailure: { fingerprint, configHash: hash, errorCode, stateToken } } satisfies FeatureState);
      const notification = duplicate ? undefined : await notifyFailure(
        config.feature, errorCode, fingerprint, cli.notificationDryRun, runFile);
      const receipt = await writeReceipt(root, { ...base(), status: 'failed', errorCode,
        generationCallsReserved: reserved, commandsCompleted: completed,
        finishedAt: now().toISOString(), notification });
      throw Object.assign(new Error(errorCode), { receipt });
    }
  } finally {
    for (const lock of locks.reverse()) await lock.close();
  }
}

async function preflight(
  config: NativeActivationConfig,
  lane: ReturnType<typeof buildInvocationPlan>['lane'],
  binding: NativeLaneBinding | undefined,
  now: Date,
  runFile: NonNullable<ControllerDependencies['runFile']>,
): Promise<{ generationCallHardMax: number; scopeBinding: Receipt['scopeBinding'] }> {
  if (binding) {
    const mode = await runSsh(['/usr/bin/stat', '--format=%a', '--', binding.environmentFile], config.timeoutSeconds, runFile);
    if (!/^(?:400|600)\s*$/.test(mode.stdout)) throw new Error('private_env_permissions_invalid');
  }
  if (binding?.policyFile) {
    const sizeResult = await runSsh(['/usr/bin/docker', 'exec', config.container, '/usr/bin/stat',
      '--format=%s', '--', binding.policyFile], config.timeoutSeconds, runFile);
    const sizeText = sizeResult.stdout.trim();
    if (!/^\d+$/.test(sizeText) || Number(sizeText) < 2 || Number(sizeText) > 64 * 1024) {
      throw new Error('policy_size_invalid');
    }
    const result = await runSsh(['/usr/bin/docker', 'exec', config.container, '/usr/bin/sha256sum', '--', binding.policyFile],
      config.timeoutSeconds, runFile);
    const actual = result.stdout.trim().split(/\s+/)[0];
    if (actual !== binding.policySha256) throw new Error('policy_hash_mismatch');
    const policyResult = await runSsh(['/usr/bin/docker', 'exec', config.container, '/usr/bin/cat', '--', binding.policyFile],
      config.timeoutSeconds, runFile);
    if (configHash(policyResult.stdout) !== binding.policySha256) throw new Error('policy_hash_mismatch');
    let value: unknown;
    try { value = JSON.parse(policyResult.stdout); }
    catch { throw new Error('policy_json_invalid'); }
    return validateNativePolicyForLane({ ...config, policyEnvironment: binding.policyEnvironment }, lane, value, now);
  }
  if (config.feature === 'contradiction-shadow') {
    return { generationCallHardMax: 1, scopeBinding: 'exact-lane' };
  }
  return { generationCallHardMax: 0, scopeBinding: 'not-applicable' };
}

async function runRemoteFeature(
  config: NativeActivationConfig,
  binding: NativeLaneBinding | undefined,
  command: NativeCommand,
  runFile: NonNullable<ControllerDependencies['runFile']>,
): Promise<ExecResult> {
  if (command.transport === 'host') return runSsh(command.argv, config.timeoutSeconds + 30, runFile);
  if (!binding) throw new Error('lane_binding_missing');
  const argv = ['/usr/bin/docker', 'exec', '--env-file', binding.environmentFile];
  const policyKey = nativePolicyEnvironmentKey(config.feature);
  if (policyKey && binding.policyFile && binding.policyEnvironment) {
    argv.push('--env', `${policyKey}=${binding.policyFile}`, '--env', `DEPLOYMENT_ENVIRONMENT=${binding.policyEnvironment}`);
  }
  if (config.feature === 'taste') argv.push('--env', 'NODE_OPTIONS=--v8-pool-size=1');
  argv.push(config.container,
    '/usr/bin/timeout', '--signal=TERM', '--kill-after=15s', `${config.timeoutSeconds}s`, ...command.argv);
  return runSsh(argv, config.timeoutSeconds + 30, runFile);
}

function nativePolicyEnvironmentKey(feature: NativeFeature): string | undefined {
  return {
    reflection: 'REFLECTION_POLICY_FILE', consolidation: 'CONSOLIDATION_POLICY_FILE',
    session: 'SESSION_DISTILLATION_POLICY_FILE', entity: 'ENTITY_EXTRACTION_POLICY_FILE',
    taste: 'TASTE_PROFILE_POLICY_FILE',
  }[feature];
}

async function runSsh(
  remoteArgv: readonly string[],
  timeoutSeconds: number,
  runFile: NonNullable<ControllerDependencies['runFile']>,
): Promise<ExecResult> {
  return runFile(SSH, ['-i', SSH_IDENTITY, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=/home/fuego/.ssh/known_hosts',
    '-o', 'ConnectTimeout=10', '--', SSH_TARGET, buildRemoteCommand(remoteArgv)], timeoutSeconds * 1_000);
}

async function readPrivateConfig(file: string): Promise<Buffer> {
  const info = await stat(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('config_must_be_private_file');
  return readFile(file);
}

async function readFeatureState(file: string): Promise<FeatureState> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as FeatureState;
    if (value.version !== 1 || !Number.isSafeInteger(value.nextLane) || value.nextLane < 0) throw new Error('feature_state_invalid');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, nextLane: 0 };
    throw error;
  }
}

async function acquireLocks(files: string[]): Promise<Awaited<ReturnType<typeof open>>[]> {
  const held: Awaited<ReturnType<typeof open>>[] = [];
  try {
    for (const file of files) {
      const handle = await open(file, 'a', 0o600);
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn('/usr/bin/flock', ['--nonblock', '3'], {
          stdio: ['ignore', 'ignore', 'ignore', handle.fd],
        });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      if (code !== 0) { await handle.close(); throw new Error('native_activation_overlap'); }
      held.push(handle);
    }
    return held;
  } catch (error) {
    for (const lock of held.reverse()) await lock.close();
    throw error;
  }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

async function writeReceipt(root: string, receipt: Receipt): Promise<Receipt> {
  const ledger = path.join(root, 'ledger.jsonl');
  await appendFile(ledger, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  const handle = await open(ledger, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  return receipt;
}

function classifyControllerError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const known = new Set(['generation_budget_exhausted', 'generation_budget_state_invalid',
    'generation_reservation_exceeds_daily_cap', 'private_env_permissions_invalid',
    'policy_size_invalid', 'policy_hash_mismatch', 'policy_json_invalid',
    'policy_scope_mismatch', 'policy_contract_invalid', 'cli_receipt_unparseable',
    'native_activation_overlap']);
  if (known.has(message)) return message;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ETIMEDOUT' || (error as any)?.killed) return 'execution_timeout';
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output_limit_exceeded';
  return 'native_cli_failed';
}

function required(value: string | undefined, option: string): string {
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

async function main(): Promise<void> {
  try {
    const receipt = await runNativeActivation(parseNativeActivationCli(process.argv.slice(2)));
    // Executed success is intentionally silent; the fsynced ledger is the
    // durable receipt. Planning mode may be inspected interactively.
    if (receipt.status === 'planned') console.log(JSON.stringify(receipt));
  } catch (error) {
    const receipt = (error as any)?.receipt as Receipt | undefined;
    console.error(JSON.stringify(receipt ?? { version: 1, status: 'failed', errorCode: classifyControllerError(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
