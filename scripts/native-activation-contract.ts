import { createHash } from 'node:crypto';

export const NATIVE_FEATURES = [
  'reflection', 'consolidation', 'session', 'entity', 'taste',
  'contradiction-shadow', 'maintenance', 'webhook',
] as const;
export type NativeFeature = typeof NATIVE_FEATURES[number];
export type AccessLevel = 'normal' | 'sensitive' | 'secret';

export interface NativeLane {
  namespace: string;
  accessLevel: AccessLevel;
  profile: string;
  mode: string;
  category?: 'music' | 'viewing';
  period?: string;
  artifactPath?: string;
  maxAnchors?: number;
  maxClusters?: number;
  binding?: NativeLaneBinding;
}

export interface NativeLaneBinding {
  environmentFile: string;
  policyFile?: string;
  policySha256?: string;
  policyEnvironment?: string;
}

export interface NativeActivationConfig {
  version: 1;
  feature: NativeFeature;
  enabled: boolean;
  container: string;
  environmentFile?: string;
  policyFile?: string;
  policySha256?: string;
  policyEnvironment?: string;
  adapterProfile?: 'openclaw-main-subscription';
  timeoutSeconds: number;
  dailyGenerationCallCap: number;
  approval: { reference: string; approvedBy: string; approvedAt: string; expiresAt: string };
  lanes: NativeLane[];
  entityHistoricalRecovery?: { completedBefore: string; limit: number };
}

export interface NativeCommand {
  argv: string[];
  receiptKind: NativeFeature | 'entity-requeue';
  transport: 'container' | 'host';
}

export interface InvocationPlan {
  feature: NativeFeature;
  laneIndex: number;
  lane: NativeLane;
  commands: NativeCommand[];
  scopeBinding: 'exact-lane' | 'policy-broader' | 'not-applicable';
  sourceGraphCoverage: 'pending' | 'not-applicable';
}

export interface NativePolicyBinding {
  generationCallHardMax: number;
  scopeBinding: 'exact-lane' | 'policy-broader';
}

const GENERATION_FEATURES = new Set<NativeFeature>([
  'reflection', 'consolidation', 'session', 'entity', 'taste', 'contradiction-shadow',
]);
const PROFILE: Record<NativeFeature, readonly string[]> = {
  reflection: ['weekly'], consolidation: ['bounded-clusters'], session: ['queued-session'],
  entity: ['entity-enrichment'], taste: ['monthly-media'],
  'contradiction-shadow': ['read-only-auditor'],
  maintenance: ['bounded-owner'], webhook: ['delivery'],
};
const MODE: Record<NativeFeature, readonly string[]> = {
  reflection: ['dry-run', 'run'], consolidation: ['selection-only', 'preview', 'apply'],
  session: ['once'], entity: ['once'], taste: ['dry-run', 'preview', 'apply', 'run-reviewed'],
  'contradiction-shadow': ['once'], maintenance: ['once'], webhook: ['once'],
};

export function parseNativeActivationConfig(value: unknown, now = new Date()): NativeActivationConfig {
  const raw = object(value, 'config');
  exactKeys(raw, ['version', 'feature', 'enabled', 'container', 'environmentFile', 'policyFile',
    'policySha256', 'policyEnvironment', 'adapterProfile', 'timeoutSeconds', 'dailyGenerationCallCap',
    'approval', 'lanes', 'entityHistoricalRecovery'], 'config');
  if (raw.version !== 1) throw new Error('config.version must be 1');
  if (!NATIVE_FEATURES.includes(raw.feature as NativeFeature)) throw new Error('feature_not_allowed');
  const feature = raw.feature as NativeFeature;
  if (typeof raw.enabled !== 'boolean') throw new Error('config.enabled must be boolean');
  const container = token(raw.container, 'container', /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
  const environmentFile = raw.environmentFile === undefined ? undefined : absolutePath(raw.environmentFile, 'environmentFile');
  const timeoutSeconds = boundedInteger(raw.timeoutSeconds ?? 120, 'timeoutSeconds', 30, 600);
  const dailyGenerationCallCap = boundedInteger(raw.dailyGenerationCallCap ?? 6, 'dailyGenerationCallCap', 1, 24);

  let policyFile: string | undefined;
  let policySha256: string | undefined;
  let policyEnvironment: string | undefined;
  let adapterProfile: 'openclaw-main-subscription' | undefined;
  if (GENERATION_FEATURES.has(feature)) {
    if (raw.policyFile !== undefined) policyFile = absolutePath(raw.policyFile, 'policyFile');
    if (raw.policySha256 !== undefined) policySha256 = token(raw.policySha256, 'policySha256', /^[0-9a-f]{64}$/);
    if (raw.policyEnvironment !== undefined) policyEnvironment = text(raw.policyEnvironment, 'policyEnvironment', 1, 128);
    if (raw.adapterProfile !== 'openclaw-main-subscription') throw new Error('private_adapter_profile_required');
    adapterProfile = raw.adapterProfile;
  } else if (raw.policyFile !== undefined || raw.policySha256 !== undefined ||
      raw.policyEnvironment !== undefined || raw.adapterProfile !== undefined) {
    throw new Error('non-generation feature must not declare generation policy or adapter');
  }

  const approvalRaw = object(raw.approval, 'approval');
  exactKeys(approvalRaw, ['reference', 'approvedBy', 'approvedAt', 'expiresAt'], 'approval');
  const approval = {
    reference: text(approvalRaw.reference, 'approval.reference', 1, 256),
    approvedBy: text(approvalRaw.approvedBy, 'approval.approvedBy', 1, 128),
    approvedAt: timestamp(approvalRaw.approvedAt, 'approval.approvedAt'),
    expiresAt: timestamp(approvalRaw.expiresAt, 'approval.expiresAt'),
  };
  if (Date.parse(approval.approvedAt) > now.getTime() || Date.parse(approval.expiresAt) <= now.getTime()) {
    throw new Error('approval_not_current');
  }
  if (!Array.isArray(raw.lanes) || raw.lanes.length < 1 || raw.lanes.length > 64) {
    throw new Error('lanes must contain 1 to 64 exact lanes');
  }
  const lanes = raw.lanes.map((item, index) => parseLane(feature, item, index));
  const identities = lanes.map(lane => `${lane.namespace}\0${lane.accessLevel}\0${lane.profile}\0${lane.mode}\0${lane.category ?? ''}\0${lane.period ?? ''}`);
  if (new Set(identities).size !== identities.length) throw new Error('lanes must not contain duplicates');
  validateBindingLayout(feature, lanes, { environmentFile, policyFile, policySha256, policyEnvironment });

  let entityHistoricalRecovery: NativeActivationConfig['entityHistoricalRecovery'];
  if (raw.entityHistoricalRecovery !== undefined) {
    if (feature !== 'entity') throw new Error('historical recovery is entity-only');
    const recovery = object(raw.entityHistoricalRecovery, 'entityHistoricalRecovery');
    exactKeys(recovery, ['completedBefore', 'limit'], 'entityHistoricalRecovery');
    const completedBefore = timestamp(recovery.completedBefore, 'entityHistoricalRecovery.completedBefore');
    if (Date.parse(completedBefore) >= now.getTime()) throw new Error('completed-before must be fixed in the past');
    entityHistoricalRecovery = {
      completedBefore,
      limit: boundedInteger(recovery.limit ?? 1, 'entityHistoricalRecovery.limit', 1, 100),
    };
  }
  return { version: 1, feature, enabled: raw.enabled, container, environmentFile,
    policyFile, policySha256, policyEnvironment, adapterProfile, timeoutSeconds,
    dailyGenerationCallCap, approval, lanes, entityHistoricalRecovery };
}

function parseLane(feature: NativeFeature, value: unknown, index: number): NativeLane {
  const raw = object(value, `lanes[${index}]`);
  exactKeys(raw, ['namespace', 'accessLevel', 'profile', 'mode', 'category', 'period',
    'artifactPath', 'maxAnchors', 'maxClusters', 'binding'], `lanes[${index}]`);
  const namespace = text(raw.namespace, `lanes[${index}].namespace`, 1, 512);
  if (namespace.includes(',') || namespace.trim() !== namespace) throw new Error('lane namespace must be exact');
  if (!['normal', 'sensitive', 'secret'].includes(String(raw.accessLevel))) throw new Error('lane accessLevel is invalid');
  const accessLevel = raw.accessLevel as AccessLevel;
  const profile = text(raw.profile, `lanes[${index}].profile`, 1, 64);
  if (!PROFILE[feature].includes(profile)) throw new Error('feature_subprofile_not_allowed');
  const mode = text(raw.mode, `lanes[${index}].mode`, 1, 32);
  if (!MODE[feature].includes(mode)) throw new Error('feature_mode_not_allowed');
  const lane: NativeLane = { namespace, accessLevel, profile, mode };
  if (raw.binding !== undefined) lane.binding = parseLaneBinding(feature, raw.binding, index);
  if (feature === 'taste') {
    if (raw.category !== 'music' && raw.category !== 'viewing') throw new Error('taste lane requires one exact category');
    lane.category = raw.category;
    if (raw.period !== undefined) lane.period = token(raw.period, 'period', /^\d{4}-(?:0[1-9]|1[0-2])$/);
    if (mode === 'apply') lane.artifactPath = absolutePath(raw.artifactPath, 'taste selection artifact');
  } else if (feature === 'consolidation') {
    lane.maxAnchors = boundedInteger(raw.maxAnchors ?? 10, 'maxAnchors', 1, 100);
    lane.maxClusters = boundedInteger(raw.maxClusters ?? 1, 'maxClusters', 1, 10);
    if (mode === 'preview') lane.artifactPath = absolutePath(raw.artifactPath, 'consolidation preview artifact');
  } else if (raw.category !== undefined || raw.period !== undefined || raw.artifactPath !== undefined ||
      raw.maxAnchors !== undefined || raw.maxClusters !== undefined) {
    throw new Error('lane contains fields not supported by its feature');
  }
  return lane;
}

function parseLaneBinding(feature: NativeFeature, value: unknown, index: number): NativeLaneBinding {
  const raw = object(value, `lanes[${index}].binding`);
  exactKeys(raw, ['environmentFile', 'policyFile', 'policySha256', 'policyEnvironment'],
    `lanes[${index}].binding`);
  const binding: NativeLaneBinding = {
    environmentFile: absolutePath(raw.environmentFile, `lanes[${index}].binding.environmentFile`),
    policySha256: token(raw.policySha256, `lanes[${index}].binding.policySha256`, /^[0-9a-f]{64}$/),
  };
  if (feature === 'contradiction-shadow') {
    if (raw.policyFile !== undefined || raw.policyEnvironment !== undefined) {
      throw new Error('contradiction auditor lane binding uses its hash-bound runtime policy');
    }
  } else {
    binding.policyFile = absolutePath(raw.policyFile, `lanes[${index}].binding.policyFile`);
    binding.policyEnvironment = text(raw.policyEnvironment, `lanes[${index}].binding.policyEnvironment`, 1, 128);
  }
  return binding;
}

function validateBindingLayout(
  feature: NativeFeature,
  lanes: NativeLane[],
  legacy: { environmentFile?: string; policyFile?: string; policySha256?: string; policyEnvironment?: string },
): void {
  const boundCount = lanes.filter(lane => lane.binding).length;
  if (!GENERATION_FEATURES.has(feature)) {
    if (boundCount !== 0) throw new Error('lane bindings are generation-feature only');
    if (feature === 'webhook' && !legacy.environmentFile) throw new Error('webhook environmentFile is required');
    if (feature === 'maintenance' && legacy.environmentFile) throw new Error('maintenance uses only the fixed host launcher');
    return;
  }
  if (boundCount !== 0 && boundCount !== lanes.length) throw new Error('every lane must have an immutable binding');
  if (lanes.length > 1 && boundCount !== lanes.length) throw new Error('multi-lane generation config requires per-lane bindings');
  if (boundCount === lanes.length) {
    if (legacy.environmentFile || legacy.policyFile || legacy.policySha256 || legacy.policyEnvironment) {
      throw new Error('lane-bound config must not declare shared environment or policy fields');
    }
    return;
  }
  if (!legacy.environmentFile || !legacy.policySha256) throw new Error('single-lane generation config requires environment and policy hash');
  if (feature === 'contradiction-shadow') {
    if (legacy.policyFile || legacy.policyEnvironment) throw new Error('contradiction auditor uses its hash-bound runtime policy');
  } else if (!legacy.policyFile || !legacy.policyEnvironment) {
    throw new Error('single-lane generation config requires policy file and environment');
  }
}

export function resolveLaneBinding(config: NativeActivationConfig, lane: NativeLane): NativeLaneBinding | undefined {
  if (lane.binding) return lane.binding;
  if (!config.environmentFile) return undefined;
  if (!GENERATION_FEATURES.has(config.feature)) {
    return { environmentFile: config.environmentFile };
  }
  return {
    environmentFile: config.environmentFile,
    policyFile: config.policyFile,
    policySha256: config.policySha256!,
    policyEnvironment: config.policyEnvironment,
  };
}

export function buildInvocationPlan(config: NativeActivationConfig, laneIndex: number): InvocationPlan {
  if (!Number.isSafeInteger(laneIndex) || laneIndex < 0 || laneIndex >= config.lanes.length) throw new Error('invalid lane index');
  const lane = config.lanes[laneIndex];
  const command = (script: string, args: string[], receiptKind: NativeCommand['receiptKind'] = config.feature): NativeCommand => ({
    argv: ['/usr/local/bin/npm', 'run', script, '--', ...args], receiptKind, transport: 'container',
  });
  const exact = ['--namespace', lane.namespace, '--access-level', lane.accessLevel];
  let commands: NativeCommand[];
  switch (config.feature) {
    case 'reflection':
      commands = [command('reflect', ['--namespace', lane.namespace, ...(lane.mode === 'dry-run' ? ['--dry-run'] : [])])]; break;
    case 'consolidation': {
      const mode = lane.mode === 'selection-only' ? ['--selection-only'] : lane.mode === 'preview'
        ? ['--dry-run', '--preview-output', lane.artifactPath!] : ['--apply'];
      commands = [command('consolidate', [...exact, ...mode, '--max-anchors', String(lane.maxAnchors), '--max-clusters', String(lane.maxClusters)])]; break;
    }
    case 'session': commands = [command('session:distill', ['--once', '--max-jobs', '1', '--poll-ms', '100'])]; break;
    case 'entity': {
      commands = [];
      if (config.entityHistoricalRecovery) commands.push(command('entity:backfill', [...exact,
        '--requeue-completed-without-links', '--completed-before', config.entityHistoricalRecovery.completedBefore,
        '--limit', String(config.entityHistoricalRecovery.limit), '--execute'], 'entity-requeue'));
      commands.push(command('entity:enrich', ['--once', '--max-jobs', '1', '--poll-ms', '100']));
      break;
    }
    case 'taste': {
      const args = [`--${lane.mode}`, '--category', lane.category!, '--access-level', lane.accessLevel];
      if (lane.period) args.push('--period', lane.period);
      if (lane.mode === 'apply') args.push('--selection-file', lane.artifactPath!);
      commands = [command('taste-profile', args)]; break;
    }
    case 'contradiction-shadow': {
      const binding = resolveLaneBinding(config, lane);
      if (!binding?.policySha256) throw new Error('lane_binding_missing');
      commands = [command('contradiction:audit', ['--once',
        '--namespace', lane.namespace, '--access-level', lane.accessLevel,
        '--expected-policy-hash', binding.policySha256])]; break;
    }
    case 'maintenance': commands = [{
      argv: ['/usr/bin/python3', '/home/cass/total-recall-move-20261117/release/scripts/native-maintenance-owner-launcher.py'],
      receiptKind: 'maintenance', transport: 'host',
    }]; break;
    case 'webhook': commands = [command('webhooks:deliver',
      ['--once', '--max-jobs', '1', '--concurrency', '1', '--poll-ms', '100'])]; break;
  }
  return { feature: config.feature, laneIndex, lane, commands,
    scopeBinding: config.feature === 'taste' ? 'policy-broader' :
      GENERATION_FEATURES.has(config.feature) ? 'exact-lane' : 'not-applicable',
    sourceGraphCoverage: config.feature === 'entity' ? 'pending' : 'not-applicable' };
}

export function validateNativePolicyForLane(
  config: NativeActivationConfig,
  lane: NativeLane,
  value: unknown,
  now = new Date(),
): NativePolicyBinding {
  if (!GENERATION_FEATURES.has(config.feature) || !config.policyEnvironment) {
    throw new Error('policy_not_applicable');
  }
  try {
    const policy = nativePolicyEnvelope(value, config.policyEnvironment, now);
    switch (config.feature) {
      case 'reflection': {
        requireFeature(policy, 'memory-reflection');
        requirePrivateGeneration(policy);
        requireCurrentApprovals(policy, ['providerModelApproval', 'termsApproval', 'scopeApproval', 'budgetApproval'], now);
        exactPolicyLane(policy.scope.namespaces, policy.scope.accessLevel, lane);
        const hardMax = boundedPolicyInteger(policy.budget.maxCallsPerRun, 1, 10);
        return { generationCallHardMax: lane.mode === 'dry-run' ? 0 : hardMax,
          scopeBinding: 'exact-lane' };
      }
      case 'consolidation': {
        requireFeature(policy, 'memory-consolidation');
        requirePrivateGeneration(policy);
        requireCurrentApprovals(policy, ['generationApproval'], now);
        if (lane.mode === 'apply') requireCurrentApprovals(policy, ['writeApproval'], now);
        exactPolicyLane(policy.scope.namespaces, policy.scope.accessLevel, lane);
        const policyMax = boundedPolicyInteger(policy.budget.maxCallsPerInvocation, 1, 10);
        const hardMax = lane.mode === 'selection-only' ? 0 :
          Math.min(lane.maxClusters!, policyMax);
        return { generationCallHardMax: hardMax, scopeBinding: 'exact-lane' };
      }
      case 'session': {
        requireFeature(policy, 'memory-session-distillation');
        requirePrivateGeneration(policy);
        requireCurrentApprovals(policy, ['providerModelApproval', 'termsApproval', 'scopeApproval', 'budgetApproval'], now);
        exactPolicyLane(policy.scope.namespaces, policy.scope.accessLevel, lane);
        return { generationCallHardMax: 1, scopeBinding: 'exact-lane' };
      }
      case 'entity': {
        requireFeature(policy, 'memory-entity-extraction');
        requirePrivateGeneration(policy);
        requireCurrentApprovals(policy, ['providerModelApproval', 'termsApproval', 'scopeApproval', 'budgetApproval'], now);
        if (config.entityHistoricalRecovery) requireCurrentApprovals(policy, ['backfillApproval'], now);
        exactPolicyLane(policy.scope.namespaces, policy.scope.accessLevel, lane);
        boundedPolicyInteger(policy.budget.maxCallsPerInvocation, 1, 100_000);
        return { generationCallHardMax: 1, scopeBinding: 'exact-lane' };
      }
      case 'taste': {
        requireFeature(policy, 'media-taste-profile');
        if (policy.enabled !== true) throw new Error('policy_disabled');
        requirePrivateGeneration(policy);
        requireCurrentApprovals(policy, ['providerModelApproval', 'termsApproval', 'scopeApproval', 'budgetApproval'], now);
        if (!Array.isArray(policy.scope.namespaces) ||
            !policy.scope.namespaces.includes(policy.scope.sourceNamespace) ||
            !policy.scope.namespaces.includes(policy.scope.targetNamespace)) throw new Error('policy_scope_invalid');
        if (!Array.isArray(policy.scope.accessLevels)) throw new Error('policy_scope_invalid');
        if (policy.scope.sourceNamespace !== lane.namespace || !policy.scope.accessLevels.includes(lane.accessLevel)) {
          throw new Error('policy_scope_mismatch');
        }
        boundedPolicyInteger(policy.budget.maxCallsPerRun, 2, 2);
        if (lane.mode === 'run-reviewed') requireStandingTasteAutomation(policy, now);
        return { generationCallHardMax: lane.mode === 'preview' || lane.mode === 'run-reviewed' ? 2 : 0,
          scopeBinding: 'policy-broader' };
      }
      case 'contradiction-shadow': throw new Error('policy_not_applicable');
      default: throw new Error('policy_not_applicable');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'policy_scope_mismatch') throw error;
    throw new Error('policy_contract_invalid');
  }
}

function nativePolicyEnvelope(value: unknown, expectedEnvironment: string, now: Date): Record<string, any> {
  const policy = object(value, 'policy');
  if (policy.environment !== expectedEnvironment) throw new Error('policy_environment_mismatch');
  const terms = object(policy.terms, 'policy.terms');
  if (terms.privacyApproved !== true || terms.retentionApproved !== true || terms.trainingApproved !== true) {
    throw new Error('policy_terms_invalid');
  }
  object(policy.scope, 'policy.scope');
  object(policy.budget, 'policy.budget');
  if (policy.budget.mode !== 'subscription') throw new Error('policy_budget_mode_invalid');
  if (!Number.isFinite(now.getTime())) throw new Error('policy_clock_invalid');
  return policy;
}

function requireFeature(policy: Record<string, any>, feature: string): void {
  if (policy.feature !== feature) throw new Error('policy_feature_mismatch');
}

function requirePrivateGeneration(policy: Record<string, any>): void {
  const generation = object(policy.generation, 'policy.generation');
  if (generation.provider !== 'openclaw-adapter' || generation.model !== 'openclaw/total-recall-synthesis') {
    throw new Error('policy_generation_invalid');
  }
}

function requireCurrentApprovals(policy: Record<string, any>, names: string[], now: Date): void {
  for (const name of names) {
    const approval = object(policy[name], `policy.${name}`);
    if (approval.approved !== true || typeof approval.approvedBy !== 'string' || approval.approvedBy.trim() === '') {
      throw new Error('policy_approval_invalid');
    }
    const approvedAt = Date.parse(String(approval.approvedAt));
    const expiresAt = Date.parse(String(approval.expiresAt));
    if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || approvedAt > now.getTime() || expiresAt <= now.getTime()) {
      throw new Error('policy_approval_not_current');
    }
  }
}

function boundedPolicyInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error('policy_budget_invalid');
  }
  return Number(value);
}

function requireStandingTasteAutomation(policy: Record<string, any>, now: Date): void {
  const authority = object(policy.standingAutomation, 'policy.standingAutomation');
  if (authority.enabled !== true) throw new Error('standing_automation_disabled');
  const owner = object(authority.ownerInstruction, 'policy.standingAutomation.ownerInstruction');
  const operator = object(authority.operator, 'policy.standingAutomation.operator');
  if (typeof owner.reference !== 'string' || owner.reference.trim() === '' ||
      typeof operator.identity !== 'string' || operator.identity.trim() === '' ||
      typeof operator.authorizationReference !== 'string' || operator.authorizationReference.trim() === '') {
    throw new Error('standing_automation_invalid');
  }
  const ownerEffectiveAt = Date.parse(String(owner.effectiveAt));
  const operatorAuthorizedAt = Date.parse(String(operator.authorizedAt));
  const operatorExpiresAt = Date.parse(String(operator.expiresAt));
  if (!Number.isFinite(ownerEffectiveAt) || ownerEffectiveAt > now.getTime() ||
      !Number.isFinite(operatorAuthorizedAt) || operatorAuthorizedAt > now.getTime() ||
      !Number.isFinite(operatorExpiresAt) || operatorExpiresAt <= now.getTime()) {
    throw new Error('standing_automation_not_current');
  }
}

function exactPolicyLane(namespaces: readonly string[], accessLevel: AccessLevel, lane: NativeLane): void {
  if (namespaces.length !== 1 || namespaces[0] !== lane.namespace || accessLevel !== lane.accessLevel) {
    throw new Error('policy_scope_mismatch');
  }
}

export function validateKnownCliReceipt(kind: NativeCommand['receiptKind'], stdout: string, stderr: string): void {
  const combined = `${stdout}\n${stderr}`;
  const accepted: Record<NativeCommand['receiptKind'], RegExp> = {
    reflection: /\[reflection\] (?:dry-run|already-completed|completed)/,
    consolidation: /\[consolidation\] (?:Sensitive preview written|Apply complete)|"anchorsExamined"/,
    session: /\[session-distill\] stopped/,
    entity: /\[entity-enrich\] stopped/,
    'entity-requeue': /"selection":"completed-without-links"/,
    taste: /\[taste-profile\]\s+\{/,
    'contradiction-shadow': /\[contradiction-shadow-audit\] stopped/,
    maintenance: /"kind":"bounded_native_decay"[\s\S]*"status":"(?:already_complete_today|pass_complete|page_applied)"[\s\S]*"classificationsFinalized":true/,
    webhook: /\[webhook-delivery\] stopped/,
  };
  if (!accepted[kind].test(combined)) throw new Error('cli_receipt_unparseable');
}

export function configHash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function object(value: unknown, name: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, any>;
}
function exactKeys(value: Record<string, unknown>, allowed: string[], name: string): void {
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`${name} has unknown fields: ${extra.join(',')}`);
}
function text(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}
function token(value: unknown, name: string, pattern: RegExp): string {
  const result = text(value, name, 1, 512);
  if (!pattern.test(result)) throw new Error(`${name} is invalid`);
  return result;
}
function absolutePath(value: unknown, name: string): string {
  const result = text(value, name, 1, 1024);
  if (!result.startsWith('/') || result.includes('/../') || result.endsWith('/..')) throw new Error(`${name} must be an absolute normalized path`);
  return result;
}
function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return Number(value);
}
function timestamp(value: unknown, name: string): string {
  const result = text(value, name, 20, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new Error(`${name} must be an explicit UTC timestamp`);
  }
  return new Date(result).toISOString();
}
