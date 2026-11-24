import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { validateKeyReadOnly } from '../src/auth.js';
import {
  classifyContradiction,
  contradictionPolicyFromEnv,
  type ContradictionPolicy,
} from '../src/contradictions.js';
import { dbScopeFromAuth, shutdown, withScopedClient } from '../src/db.js';
import {
  GenerationLimitError,
  GenerationTimeoutError,
  HttpJsonGenerationProvider,
  type GenerationProvider,
} from '../src/generation.js';
import type { AuthContext } from '../src/types.js';

const PRIVATE_PROVIDER = 'openclaw-adapter';
const PRIVATE_MODEL = 'openclaw/total-recall-synthesis';

export interface ContradictionAuditCliOptions {
  once: true;
  namespace: string;
  accessLevel: 'normal';
  expectedPolicyHash: string;
}

const candidateSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string(),
  similarity: z.number().finite().min(0).max(1),
}).strict();

const claimSchema = z.object({
  claim_id: z.string().uuid(),
  status: z.enum(['claimed', 'no_candidates']),
  subject_content: z.string().nullable(),
  candidates: z.array(candidateSchema).max(5),
  subject_content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  evidence_hash: z.string().regex(/^[a-f0-9]{64}$/),
  candidate_set_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export function parseContradictionAuditCli(args: string[]): ContradictionAuditCliOptions {
  let once = false;
  let namespace = '';
  let accessLevel = '';
  let expectedPolicyHash = '';
  const value = (index: number, option: string): string => {
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${option} requires a value`);
    return next;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--once') once = true;
    else if (arg === '--namespace') namespace = value(index++, arg);
    else if (arg === '--access-level') accessLevel = value(index++, arg);
    else if (arg === '--expected-policy-hash') expectedPolicyHash = value(index++, arg);
    else throw new Error(`Unknown contradiction audit option: ${arg}`);
  }
  if (!once) throw new Error('--once is required');
  if (!namespace.trim() || namespace.includes(',') || namespace !== namespace.trim()) {
    throw new Error('--namespace must name exactly one namespace');
  }
  if (accessLevel !== 'normal') throw new Error('--access-level must be exactly normal');
  if (!/^[a-f0-9]{64}$/.test(expectedPolicyHash)) throw new Error('--expected-policy-hash must be lowercase SHA-256');
  return { once: true, namespace, accessLevel: 'normal', expectedPolicyHash };
}

export function contradictionAuditPolicyHash(policy: ContradictionPolicy): string {
  if (!policy.classificationEnabled || !policy.budget || !policy.provider || !policy.model || !policy.namespace) {
    throw new Error('contradiction_audit_policy_disabled');
  }
  // budget.fingerprint contains NUL separators. Hash the imported value before
  // it reaches PostgreSQL text parameters.
  return createHash('sha256').update(JSON.stringify([
    policy.provider,
    policy.model,
    policy.namespace,
    policy.timeoutMs,
    policy.budget.fingerprint,
  ])).digest('hex');
}

export function assertContradictionAuditAuthority(
  auth: AuthContext,
  policy: ContradictionPolicy,
  options: ContradictionAuditCliOptions,
): void {
  if (!policy.classificationEnabled || policy.provider !== PRIVATE_PROVIDER || policy.model !== PRIVATE_MODEL ||
      policy.namespace !== options.namespace || options.accessLevel !== 'normal') {
    throw new Error('contradiction_audit_policy_mismatch');
  }
  if (contradictionAuditPolicyHash(policy) !== options.expectedPolicyHash) {
    throw new Error('contradiction_audit_policy_hash_mismatch');
  }
  const permissions = [...auth.permissions].sort();
  if (auth.namespaces.length !== 1 || auth.namespaces[0] !== options.namespace ||
      auth.maxAccessLevel !== options.accessLevel ||
      permissions.length !== 2 || permissions[0] !== 'contradiction_resolve' || permissions[1] !== 'read') {
    throw new Error('contradiction_audit_authority_mismatch');
  }
}

export interface ContradictionAuditResult {
  status: 'idle' | 'no_candidates' | 'classified' | 'stale_evidence';
  providerCalls: 0 | 1;
  classification?: 'duplicate' | 'refinement' | 'contradiction' | 'no_match';
  confidence?: number;
  policyHash: string;
  subjectContentSha256?: string;
  evidenceHash?: string;
  candidateSetHash?: string;
}

export async function runContradictionShadowAudit(
  options: ContradictionAuditCliOptions,
  supplied: { policy?: ContradictionPolicy; auth?: AuthContext; provider?: GenerationProvider } = {},
): Promise<ContradictionAuditResult> {
  const policy = supplied.policy ?? contradictionPolicyFromEnv();
  const rawKey = process.env.CONTRADICTION_REVIEW_API_KEY?.trim();
  const auth = supplied.auth ?? (rawKey ? await validateKeyReadOnly(rawKey) : null);
  if (!auth) throw new Error('CONTRADICTION_REVIEW_API_KEY is required and must be valid');
  assertContradictionAuditAuthority(auth, policy, options);
  const policyHash = contradictionAuditPolicyHash(policy);
  const claimResult = await withScopedClient(dbScopeFromAuth(auth), client => client.query(
    'SELECT * FROM public.contradiction_shadow_claim($1,$2,$3)',
    [options.namespace, options.accessLevel, policyHash],
  ));
  if (claimResult.rows.length === 0) return { status: 'idle', providerCalls: 0, policyHash };
  const claim = claimSchema.parse(claimResult.rows[0]);
  const hashes = {
    policyHash,
    subjectContentSha256: claim.subject_content_sha256,
    evidenceHash: claim.evidence_hash,
    candidateSetHash: claim.candidate_set_hash,
  };
  if (claim.status === 'no_candidates') return { status: 'no_candidates', providerCalls: 0, ...hashes };
  if (claim.subject_content === null || claim.candidates.length === 0) throw new Error('contradiction_audit_claim_invalid');

  let providerCalls: 0 | 1 = 0;
  const configuredProvider = supplied.provider ?? new HttpJsonGenerationProvider({
    name: policy.provider!, endpoint: policy.endpoint!, apiKey: policy.apiKey,
  });
  if (configuredProvider.name !== PRIVATE_PROVIDER) throw new Error('contradiction_audit_provider_mismatch');
  const oneCallProvider: GenerationProvider = {
    name: configuredProvider.name,
    async generate(request) {
      if (providerCalls !== 0) throw new Error('contradiction_audit_call_limit');
      providerCalls = 1;
      return configuredProvider.generate(request);
    },
  };

  let classification: Awaited<ReturnType<typeof classifyContradiction>>;
  try {
    classification = await classifyContradiction(
      claim.subject_content,
      claim.candidates.map(candidate => ({ id: candidate.id, content: candidate.content,
        similarity: candidate.similarity })),
      oneCallProvider,
      policy.model!,
      policy.timeoutMs,
    );
  } catch (error) {
    const status = classifyAuditFailure(error);
    await appendOutcome(auth, claim.claim_id, status, null, null, null, providerCalls);
    throw new Error(`contradiction_audit_${status}`);
  }
  // A post-generation receipt failure is not a provider failure and must not
  // be rewritten as one. The durable claim still prevents an unchanged retry.
  const outcome = await appendOutcome(auth, claim.claim_id, 'classified', classification.classification,
    classification.confidence, classification.candidate_id, providerCalls);
  if (outcome === 'stale_evidence') return { status: 'stale_evidence', providerCalls, ...hashes };
  return { status: 'classified', providerCalls, classification: classification.classification,
    confidence: classification.confidence, ...hashes };
}

async function appendOutcome(
  auth: AuthContext,
  claimId: string,
  status: string,
  classification: string | null,
  confidence: number | null,
  candidateId: string | null,
  providerCalls: 0 | 1,
): Promise<string> {
  const result = await withScopedClient(dbScopeFromAuth(auth), client => client.query<{ outcome: string }>(
    'SELECT public.contradiction_shadow_append_outcome($1,$2,$3,$4,$5,$6) AS outcome',
    [claimId, status, classification, confidence, candidateId, providerCalls],
  ));
  return result.rows[0]?.outcome ?? 'receipt_missing';
}

function classifyAuditFailure(error: unknown): 'input_too_large' | 'provider_timeout' | 'provider_error' | 'invalid_output' {
  if (error instanceof GenerationLimitError && error.message.includes('input exceeds')) return 'input_too_large';
  if (error instanceof GenerationTimeoutError) return 'provider_timeout';
  if (error instanceof Error && (error.message === 'invalid_classifier_output' || error.message === 'unknown_candidate_id')) {
    return 'invalid_output';
  }
  return 'provider_error';
}

async function main(): Promise<void> {
  try {
    const result = await runContradictionShadowAudit(parseContradictionAuditCli(process.argv.slice(2)));
    console.log('[contradiction-shadow-audit] stopped', result);
  } catch (error) {
    const code = error instanceof Error && /^contradiction_audit_[a-z_]+$/.test(error.message)
      ? error.message : 'contradiction_audit_failed';
    console.error(`[contradiction-shadow-audit] failed status=${code}`);
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
