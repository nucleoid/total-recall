import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';
import { resolveMaintenanceDatabaseUrl, verifyAllRowMaintenanceRole } from './maintenance-database.js';

dotenv.config();

export type Approval = {
  id: string;
  fingerprint: string;
  action: 'reset-managed' | 'preserve-custom';
  baseScore?: number;
};
export type ApprovalManifest = { backupVerified: boolean; approvals: Approval[] };
type RepairCandidateFacts = {
  id: string;
  namespace: string;
  relevance_score: number | null;
  decay_rate: number | null;
  accessed_at: Date | null;
  access_count: number | null;
  updated_at: Date | null;
};
export type RepairCandidate = RepairCandidateFacts & { fingerprint: string };

function canonicalTimestamp(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function fingerprintRepairCandidate(candidate: RepairCandidateFacts): string {
  const facts = [
    candidate.id,
    candidate.namespace,
    candidate.relevance_score,
    candidate.decay_rate,
    canonicalTimestamp(candidate.accessed_at),
    candidate.access_count,
    canonicalTimestamp(candidate.updated_at),
  ];
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

function withFingerprint(candidate: RepairCandidateFacts): RepairCandidate {
  return { ...candidate, fingerprint: fingerprintRepairCandidate(candidate) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[0-9a-f]{64}$/i;

export function validateApprovalManifest(value: ApprovalManifest): ApprovalManifest {
  if (!value || value.backupVerified !== true) throw new Error('A verified restorable backup acknowledgement is required');
  if (!Array.isArray(value.approvals)) throw new Error('Exact row approvals must be an array');
  const ids = new Set<string>();
  for (const approval of value.approvals) {
    if (!UUID.test(approval.id)) throw new Error(`Approval id must be an exact UUID: ${approval.id}`);
    if (ids.has(approval.id)) throw new Error(`Duplicate approval id: ${approval.id}`);
    ids.add(approval.id);
    if (!FINGERPRINT.test(approval.fingerprint)) throw new Error(`Invalid fingerprint for ${approval.id}`);
    if (approval.action !== 'reset-managed' && approval.action !== 'preserve-custom') {
      throw new Error(`Invalid approval action for ${approval.id}`);
    }
    if (approval.action === 'reset-managed') {
      if (approval.baseScore !== undefined && approval.baseScore !== 1) throw new Error('Managed base must be 1.0');
      approval.baseScore = 1;
    } else if (typeof approval.baseScore !== 'number' || !Number.isFinite(approval.baseScore) || approval.baseScore < 0) {
      throw new Error(`Custom base for ${approval.id} must be finite and nonnegative`);
    }
  }
  return value;
}

const CANDIDATE_SQL = `
  SELECT id, namespace, relevance_score, decay_rate, accessed_at, access_count, updated_at
  FROM public.memories
  WHERE deleted_at IS NULL
    AND relevance_base_score IS NULL
  ORDER BY id`;

export async function previewRelevanceRepair(connectionString: string): Promise<RepairCandidate[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await verifyAllRowMaintenanceRole(client);
    await client.query('BEGIN READ ONLY');
    const result = await client.query<RepairCandidateFacts>(CANDIDATE_SQL);
    await client.query('ROLLBACK');
    return result.rows.map(withFingerprint);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export async function applyRelevanceRepair(connectionString: string, raw: ApprovalManifest) {
  const manifest = validateApprovalManifest(raw);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await verifyAllRowMaintenanceRole(client);
    await client.query('BEGIN');
    const candidateResult = await client.query<RepairCandidateFacts>(`${CANDIDATE_SQL} FOR UPDATE`);
    const candidates = candidateResult.rows.map(withFingerprint);

    if (candidates.length === 0) {
      // The locked database preflight, not the empty manifest itself, proves that
      // there is nothing to classify. Non-empty manifests remain idempotent only
      // when every referenced row already has its approved base.
      if (manifest.approvals.length > 0) {
        const existing = await client.query<{ id: string; relevance_base_score: number }>(
          `SELECT id, relevance_base_score FROM public.memories
           WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
          [manifest.approvals.map(a => a.id)]
        );
        const expected = new Map(manifest.approvals.map(a => [a.id, a.baseScore!]));
        if (existing.rows.length !== manifest.approvals.length ||
            existing.rows.some(row => Number(row.relevance_base_score) !== expected.get(row.id))) {
          throw new Error('Approval manifest does not match the already repaired rows');
        }
      }
      await client.query('ALTER TABLE public.memories VALIDATE CONSTRAINT memories_relevance_base_score_valid');
      await client.query('ALTER TABLE public.memories ALTER COLUMN relevance_base_score SET NOT NULL');
      await client.query('COMMIT');
      return { updated: 0, alreadyApplied: manifest.approvals.length, finalized: true };
    }

    const approved = new Map(manifest.approvals.map(item => [item.id, item]));
    if (approved.size !== candidates.length || candidates.some(row => !approved.has(row.id))) {
      throw new Error('Incomplete or broad approval: every currently unclassified row must be approved by exact ID');
    }
    for (const row of candidates) {
      const approval = approved.get(row.id)!;
      if (approval.fingerprint !== row.fingerprint) throw new Error(`State drift detected for ${row.id}`);
      await client.query(
        `UPDATE public.memories
         SET relevance_base_score = $2,
             relevance_score = public.calculate_relevance($2, decay_rate, accessed_at, access_count),
             updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL`,
        [row.id, approval.baseScore]
      );
    }

    await client.query('ALTER TABLE public.memories VALIDATE CONSTRAINT memories_relevance_base_score_valid');
    await client.query('ALTER TABLE public.memories ALTER COLUMN relevance_base_score SET NOT NULL');
    await client.query('COMMIT');
    return { updated: candidates.length, alreadyApplied: 0, finalized: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}


export type CalibrationCandidate = RepairCandidate & {
  derivedBaseScore: number | null;
  preservedEffectiveScore: number | null;
  rejectionReason?: string;
};
export type CalibrationApproval = {
  id: string;
  fingerprint: string;
  derivedBaseScore: number;
  preservedEffectiveScore: number;
};
export type CalibrationManifest = {
  version: 1;
  backupVerified: boolean;
  backupEvidenceReference: string;
  asOf: string;
  approvals: CalibrationApproval[];
};

const MAX_CALIBRATION_BATCH = 1_000;
const SCORE_TOLERANCE = 1e-10;

function canonicalAsOf(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || parsed.getTime() > Date.now()) {
    throw new Error('Calibration requires an explicit non-future UTC asOf timestamp');
  }
  return parsed.toISOString();
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CALIBRATION_BATCH) {
    throw new Error(`Calibration limit must be an integer from 1 to ${MAX_CALIBRATION_BATCH}`);
  }
  return value;
}

export function deriveCalibratedBase(candidate: RepairCandidateFacts, asOfValue: string): CalibrationCandidate {
  const asOf = new Date(canonicalAsOf(asOfValue));
  const fingerprint = fingerprintRepairCandidate(candidate);
  const score = Number(candidate.relevance_score);
  const rate = candidate.decay_rate === null ? 0.01 : Number(candidate.decay_rate);
  const count = candidate.access_count === null ? 0 : Number(candidate.access_count);
  const rejected = (reason: string): CalibrationCandidate => ({ ...candidate, fingerprint,
    derivedBaseScore: null, preservedEffectiveScore: Number.isFinite(score) ? score : null, rejectionReason: reason });
  if (candidate.relevance_score === null || !Number.isFinite(score)) return rejected('effective_score_not_finite');
  if (!Number.isFinite(rate)) return rejected('decay_rate_not_finite');
  if (!Number.isFinite(count)) return rejected('access_count_not_finite');
  const accessed = candidate.accessed_at?.getTime() ?? asOf.getTime();
  if (!Number.isFinite(accessed)) return rejected('accessed_at_not_finite');
  const days = Math.max(0, (asOf.getTime() - accessed) / 86_400_000);
  const factor = Math.exp(-rate * days);
  const bonus = Math.min(Math.max(count * 0.1, 0), 1);
  const numerator = score - bonus;
  if (!Number.isFinite(factor) || factor <= 0) return rejected('decay_factor_not_positive_finite');
  if (numerator < -SCORE_TOLERANCE) return rejected('effective_score_below_access_bonus');
  const baseScore = Math.max(0, numerator) / factor;
  if (!Number.isFinite(baseScore) || baseScore < 0) return rejected('derived_base_not_finite_nonnegative');
  const reconstructed = baseScore * factor + bonus;
  if (Math.abs(reconstructed - score) > SCORE_TOLERANCE * Math.max(1, Math.abs(score))) {
    return rejected('effective_score_reconstruction_drift');
  }
  return { ...candidate, fingerprint, derivedBaseScore: baseScore, preservedEffectiveScore: score };
}

const CALIBRATION_CANDIDATE_SQL = `
  SELECT id, namespace, relevance_score, decay_rate, accessed_at, access_count, updated_at
  FROM public.memories
  WHERE relevance_base_score IS NULL AND deleted_at IS NULL
    AND (expires_at IS NULL OR expires_at > $1::timestamptz)
    AND (expires_at IS NULL OR expires_at > statement_timestamp())
    AND superseded_at IS NULL AND valid_to IS NULL
    AND (valid_from IS NULL OR valid_from <= $1::timestamptz)
    AND (valid_from IS NULL OR valid_from <= statement_timestamp())
    AND consolidated_into_id IS NULL
    AND id > COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
  ORDER BY id LIMIT $3`;

export async function previewCalibrationBatch(
  connectionString: string, asOfValue: string, afterId: string | null, limit: number,
): Promise<{ asOf: string; afterId: string | null; nextCursor: string | null; candidates: CalibrationCandidate[] }> {
  const asOf = canonicalAsOf(asOfValue);
  if (afterId && !UUID.test(afterId)) throw new Error('Calibration cursor must be a UUID');
  boundedLimit(limit);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await verifyAllRowMaintenanceRole(client);
    await client.query('BEGIN READ ONLY');
    const result = await client.query<RepairCandidateFacts>(CALIBRATION_CANDIDATE_SQL, [asOf, afterId, limit]);
    await client.query('ROLLBACK');
    const candidates = result.rows.map(row => deriveCalibratedBase(row, asOf));
    return { asOf, afterId, nextCursor: result.rows.at(-1)?.id ?? null, candidates };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}

export function validateCalibrationManifest(value: CalibrationManifest): CalibrationManifest {
  if (!value || value.version !== 1 || value.backupVerified !== true) {
    throw new Error('Calibration requires version 1 and a verified restorable backup acknowledgement');
  }
  if (typeof value.backupEvidenceReference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$/.test(value.backupEvidenceReference)) {
    throw new Error('Calibration requires a non-secret backup evidence reference');
  }
  value.asOf = canonicalAsOf(value.asOf);
  if (!Array.isArray(value.approvals) || value.approvals.length > MAX_CALIBRATION_BATCH) {
    throw new Error(`Calibration approvals must contain at most ${MAX_CALIBRATION_BATCH} exact rows`);
  }
  const ids = new Set<string>();
  for (const approval of value.approvals) {
    if (!UUID.test(approval.id) || !FINGERPRINT.test(approval.fingerprint)) throw new Error('Calibration approval has invalid identity or fingerprint');
    if (ids.has(approval.id)) throw new Error(`Duplicate calibration approval id: ${approval.id}`);
    ids.add(approval.id);
    if (!Number.isFinite(approval.derivedBaseScore) || approval.derivedBaseScore < 0 ||
        !Number.isFinite(approval.preservedEffectiveScore)) throw new Error(`Calibration approval has unsafe score for ${approval.id}`);
  }
  return value;
}

function scoreClose(left: number, right: number): boolean {
  return Math.abs(left - right) <= SCORE_TOLERANCE * Math.max(1, Math.abs(left), Math.abs(right));
}

export async function applyCalibrationBatch(connectionString: string, raw: CalibrationManifest) {
  const manifest = validateCalibrationManifest(raw);
  if (manifest.approvals.length === 0) throw new Error('Calibration apply requires at least one exact approval');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await verifyAllRowMaintenanceRole(client);
    await client.query('BEGIN');
    const result = await client.query<(RepairCandidateFacts & { relevance_base_score: number | null })>(`
      SELECT id, namespace, relevance_score, relevance_base_score, decay_rate, accessed_at, access_count, updated_at
      FROM public.memories WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > $2::timestamptz)
        AND (expires_at IS NULL OR expires_at > statement_timestamp())
        AND superseded_at IS NULL AND valid_to IS NULL
        AND (valid_from IS NULL OR valid_from <= $2::timestamptz)
        AND (valid_from IS NULL OR valid_from <= statement_timestamp())
        AND consolidated_into_id IS NULL
      ORDER BY id FOR UPDATE`, [manifest.approvals.map(item => item.id), manifest.asOf]);
    if (result.rows.length !== manifest.approvals.length) throw new Error('Calibration approval rows are missing or tombstoned');
    const byId = new Map(result.rows.map(row => [row.id, row]));
    let updated = 0, alreadyApplied = 0;
    for (const approval of manifest.approvals) {
      const row = byId.get(approval.id)!;
      if (row.relevance_base_score !== null) {
        if (!scoreClose(Number(row.relevance_base_score), approval.derivedBaseScore) ||
            !scoreClose(Number(row.relevance_score), approval.preservedEffectiveScore)) {
          throw new Error(`Already-calibrated row does not match approval: ${approval.id}`);
        }
        alreadyApplied += 1;
        continue;
      }
      const derived = deriveCalibratedBase(row, manifest.asOf);
      if (derived.rejectionReason || derived.fingerprint !== approval.fingerprint ||
          !scoreClose(derived.derivedBaseScore!, approval.derivedBaseScore) ||
          !scoreClose(derived.preservedEffectiveScore!, approval.preservedEffectiveScore)) {
        throw new Error(`Calibration state drift or unsafe derivation for ${approval.id}`);
      }
      const applied = await client.query(`UPDATE public.memories SET relevance_base_score = $2
        WHERE id = $1::uuid AND deleted_at IS NULL AND relevance_base_score IS NULL
          AND (expires_at IS NULL OR expires_at > statement_timestamp())
          AND superseded_at IS NULL AND valid_to IS NULL
          AND (valid_from IS NULL OR valid_from <= statement_timestamp())
          AND consolidated_into_id IS NULL`,
      [approval.id, approval.derivedBaseScore]);
      if (applied.rowCount !== 1) throw new Error(`Calibration write race for ${approval.id}`);
      updated += 1;
    }
    const drift = await client.query<{ id: string; relevance_score: number }>(
      'SELECT id,relevance_score FROM public.memories WHERE id=ANY($1::uuid[]) ORDER BY id',
      [manifest.approvals.map(item => item.id)]);
    const approvals = new Map(manifest.approvals.map(item => [item.id, item]));
    if (drift.rows.some(row => !scoreClose(Number(row.relevance_score), approvals.get(row.id)!.preservedEffectiveScore))) {
      throw new Error('Calibration changed an effective score');
    }
    await client.query(`INSERT INTO public.audit_log(client_id,action,result_count)
      VALUES('system:maintenance','relevance_base_calibration',$1)`, [updated]);
    const remaining = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM public.memories WHERE relevance_base_score IS NULL');
    await client.query('COMMIT');
    return { updated, alreadyApplied, remaining: Number(remaining.rows[0]?.count ?? 0), finalized: false, asOf: manifest.asOf };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}


export type FloorExceptionCandidate = {
  id: string;
  namespace: string;
  accessLevel: string;
  beforeFingerprint: string;
  guardFingerprint: string;
  currentScore: number | null;
  earnedBonus: number | null;
  proposedBaseScore: 0;
  proposedScore: number | null;
  rejectionReason?: string;
};
export type FloorExceptionApproval = Omit<FloorExceptionCandidate, 'namespace' | 'accessLevel' | 'rejectionReason'> & {
  currentScore: number;
  earnedBonus: number;
  proposedScore: number;
};
export type FloorExceptionManifest = {
  version: 1;
  kind: 'access_bonus_floor_exception';
  operatorApproved: true;
  operatorReviewReference: string;
  backupVerified: true;
  backupEvidenceReference: string;
  approvals: FloorExceptionApproval[];
};

type FloorExceptionFacts = {
  id: string;
  namespace: string;
  access_level: string;
  client_id: string;
  source: string;
  memory_kind: string;
  content_hash: string;
  relevance_score: number | null;
  relevance_base_score: number | null;
  decay_rate: number | null;
  accessed_at: Date | null;
  access_count: number | null;
  updated_at: Date | null;
  expires_at: Date | null;
  valid_from: Date | null;
  valid_to: Date | null;
  deleted_at: Date | null;
  superseded_at: Date | null;
  consolidated_into_id: string | null;
  dispatched_at: Date;
};

const FLOOR_EXCEPTION_KIND = 'access_bonus_floor_exception' as const;

function floorGuardFacts(row: FloorExceptionFacts): unknown[] {
  return [row.id, row.namespace, row.access_level, row.client_id, row.source, row.memory_kind, row.content_hash,
    row.decay_rate, canonicalTimestamp(row.accessed_at), row.access_count, canonicalTimestamp(row.expires_at),
    canonicalTimestamp(row.valid_from), canonicalTimestamp(row.valid_to), canonicalTimestamp(row.deleted_at),
    canonicalTimestamp(row.superseded_at), row.consolidated_into_id];
}

function floorGuardFingerprint(row: FloorExceptionFacts): string {
  return createHash('sha256').update(JSON.stringify(floorGuardFacts(row))).digest('hex');
}

function floorBeforeFingerprint(row: FloorExceptionFacts): string {
  return createHash('sha256').update(JSON.stringify([
    ...floorGuardFacts(row), row.relevance_score, row.relevance_base_score, canonicalTimestamp(row.updated_at),
  ])).digest('hex');
}

function earnedAccessBonus(value: number | null): number | null {
  const count = value === null ? 0 : Number(value);
  return Number.isFinite(count) ? Math.min(Math.max(count * 0.1, 0), 1) : null;
}

export function validateFloorExceptionIds(value: unknown): string[] {
  const ids = Array.isArray(value) ? value : (value as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_CALIBRATION_BATCH) {
    throw new Error(`Floor exception preview requires 1 to ${MAX_CALIBRATION_BATCH} exact IDs`);
  }
  const unique = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Floor exception IDs must be exact UUIDs');
    if (unique.has(id)) throw new Error(`Duplicate floor exception id: ${id}`);
    unique.add(id);
  }
  return [...unique];
}

export function deriveFloorExceptionCandidate(row: FloorExceptionFacts): FloorExceptionCandidate {
  const score = row.relevance_score === null ? Number.NaN : Number(row.relevance_score);
  const bonus = earnedAccessBonus(row.access_count);
  const dispatched = row.dispatched_at.getTime();
  const reject = (rejectionReason: string): FloorExceptionCandidate => ({
    id: row.id, namespace: row.namespace, accessLevel: row.access_level,
    beforeFingerprint: floorBeforeFingerprint(row), guardFingerprint: floorGuardFingerprint(row),
    currentScore: Number.isFinite(score) ? score : null, earnedBonus: bonus,
    proposedBaseScore: 0, proposedScore: bonus, rejectionReason,
  });
  if (!Number.isFinite(dispatched)) return reject('dispatch_time_not_finite');
  if (row.relevance_base_score !== null) return reject('relevance_base_already_classified');
  if (row.deleted_at !== null || row.superseded_at !== null || row.valid_to !== null || row.consolidated_into_id !== null) {
    return reject('memory_not_current');
  }
  if (row.expires_at !== null && row.expires_at.getTime() <= dispatched) return reject('memory_expired_at_dispatch');
  if (row.valid_from !== null && row.valid_from.getTime() > dispatched) return reject('memory_not_yet_valid_at_dispatch');
  if (!['normal', 'sensitive', 'secret'].includes(row.access_level) || !row.namespace) return reject('memory_acl_invalid');
  if (!Number.isFinite(score)) return reject('effective_score_not_finite');
  if (bonus === null) return reject('access_count_not_finite');
  if (score >= bonus - SCORE_TOLERANCE) return reject('effective_score_not_below_access_bonus');
  return {
    id: row.id, namespace: row.namespace, accessLevel: row.access_level,
    beforeFingerprint: floorBeforeFingerprint(row), guardFingerprint: floorGuardFingerprint(row),
    currentScore: score, earnedBonus: bonus, proposedBaseScore: 0, proposedScore: bonus,
  };
}

const FLOOR_EXCEPTION_SQL = `
  SELECT id,namespace,access_level,client_id,source,memory_kind,encode(sha256(convert_to(content, 'UTF8')), 'hex') AS content_hash,
    relevance_score,relevance_base_score,decay_rate,accessed_at,access_count,updated_at,
    expires_at,valid_from,valid_to,deleted_at,superseded_at,consolidated_into_id,
    statement_timestamp() AS dispatched_at
  FROM public.memories
  WHERE id = ANY($1::uuid[])
  ORDER BY id`;

export async function previewFloorExceptionBatch(connectionString: string, rawIds: unknown) {
  const ids = validateFloorExceptionIds(rawIds);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await verifyAllRowMaintenanceRole(client);
    await client.query('BEGIN READ ONLY');
    const result = await client.query<FloorExceptionFacts>(FLOOR_EXCEPTION_SQL, [ids]);
    await client.query('ROLLBACK');
    if (result.rows.length !== ids.length) throw new Error('One or more exact floor exception IDs do not exist');
    return { version: 1 as const, kind: FLOOR_EXCEPTION_KIND, candidates: result.rows.map(deriveFloorExceptionCandidate) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}

function validateEvidenceReference(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$/.test(value)) {
    throw new Error(`Floor exception requires a non-secret ${label}`);
  }
  return value;
}

export function validateFloorExceptionManifest(value: FloorExceptionManifest): FloorExceptionManifest {
  if (!value || value.version !== 1 || value.kind !== FLOOR_EXCEPTION_KIND || value.operatorApproved !== true) {
    throw new Error('Floor exception requires a version 1 explicitly operator-approved manifest');
  }
  if (value.backupVerified !== true) throw new Error('Floor exception requires a verified restorable backup acknowledgement');
  validateEvidenceReference(value.operatorReviewReference, 'operator review reference');
  validateEvidenceReference(value.backupEvidenceReference, 'backup evidence reference');
  if (!Array.isArray(value.approvals) || value.approvals.length < 1 || value.approvals.length > MAX_CALIBRATION_BATCH) {
    throw new Error(`Floor exception approvals must contain 1 to ${MAX_CALIBRATION_BATCH} exact rows`);
  }
  const ids = new Set<string>();
  for (const approval of value.approvals) {
    if (!UUID.test(approval.id) || !FINGERPRINT.test(approval.beforeFingerprint) || !FINGERPRINT.test(approval.guardFingerprint)) {
      throw new Error('Floor exception approval has invalid identity or fingerprint');
    }
    if (ids.has(approval.id)) throw new Error(`Duplicate floor exception approval id: ${approval.id}`);
    ids.add(approval.id);
    if (approval.proposedBaseScore !== 0 || !Number.isFinite(approval.currentScore) ||
        !Number.isFinite(approval.earnedBonus) || !Number.isFinite(approval.proposedScore) ||
        !scoreClose(approval.proposedScore, approval.earnedBonus) ||
        approval.currentScore >= approval.earnedBonus - SCORE_TOLERANCE) {
      throw new Error(`Floor exception approval is not a minimal earned-bonus floor for ${approval.id}`);
    }
  }
  return value;
}

export async function applyFloorExceptionBatch(connectionString: string, raw: FloorExceptionManifest) {
  const manifest = validateFloorExceptionManifest(raw);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await verifyAllRowMaintenanceRole(client);
    await client.query('BEGIN');
    const ids = manifest.approvals.map(item => item.id);
    const result = await client.query<FloorExceptionFacts>(`${FLOOR_EXCEPTION_SQL} FOR UPDATE`, [ids]);
    if (result.rows.length !== ids.length) throw new Error('Floor exception approval rows are missing');
    const byId = new Map(result.rows.map(row => [row.id, row]));
    let updated = 0, alreadyApplied = 0;
    for (const approval of manifest.approvals) {
      const row = byId.get(approval.id)!;
      if (floorGuardFingerprint(row) !== approval.guardFingerprint) throw new Error(`Floor exception guard drift for ${approval.id}`);
      const currentBonus = earnedAccessBonus(row.access_count);
      if (row.relevance_base_score !== null) {
        if (!scoreClose(Number(row.relevance_base_score), 0) || currentBonus === null ||
            !scoreClose(currentBonus, approval.earnedBonus) || !scoreClose(Number(row.relevance_score), approval.proposedScore)) {
          throw new Error(`Already-classified floor exception row does not match approval: ${approval.id}`);
        }
        alreadyApplied += 1;
        continue;
      }
      const candidate = deriveFloorExceptionCandidate(row);
      if (candidate.rejectionReason || candidate.beforeFingerprint !== approval.beforeFingerprint ||
          candidate.guardFingerprint !== approval.guardFingerprint || !scoreClose(candidate.currentScore!, approval.currentScore) ||
          !scoreClose(candidate.earnedBonus!, approval.earnedBonus) || !scoreClose(candidate.proposedScore!, approval.proposedScore)) {
        throw new Error(`Floor exception state drift or ineligible row for ${approval.id}`);
      }
      const applied = await client.query(`UPDATE public.memories
        SET relevance_base_score = 0, relevance_score = $2, updated_at = statement_timestamp()
        WHERE id = $1::uuid AND relevance_base_score IS NULL AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > statement_timestamp())
          AND superseded_at IS NULL AND valid_to IS NULL
          AND (valid_from IS NULL OR valid_from <= statement_timestamp())
          AND consolidated_into_id IS NULL`, [approval.id, approval.proposedScore]);
      if (applied.rowCount !== 1) throw new Error(`Floor exception write race or lifecycle drift for ${approval.id}`);
      updated += 1;
    }
    await client.query(`INSERT INTO public.audit_log(client_id,action,result_count)
      VALUES('system:maintenance','relevance_base_floor_exception',$1)`, [updated]);
    const remaining = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM public.memories WHERE relevance_base_score IS NULL');
    await client.query('COMMIT');
    return { updated, alreadyApplied, remaining: Number(remaining.rows[0]?.count ?? 0), finalized: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}


export async function rollbackFloorExceptionBatch(connectionString: string, raw: FloorExceptionManifest) {
  const manifest = validateFloorExceptionManifest(raw);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await verifyAllRowMaintenanceRole(client);
    await client.query('BEGIN');
    const ids = manifest.approvals.map(item => item.id);
    const result = await client.query<FloorExceptionFacts>(`${FLOOR_EXCEPTION_SQL} FOR UPDATE`, [ids]);
    if (result.rows.length !== ids.length) throw new Error('Floor exception rollback rows are missing');
    const byId = new Map(result.rows.map(row => [row.id, row]));
    let restored = 0, alreadyRestored = 0;
    for (const approval of manifest.approvals) {
      const row = byId.get(approval.id)!;
      if (floorGuardFingerprint(row) !== approval.guardFingerprint) throw new Error(`Floor exception rollback guard drift for ${approval.id}`);
      const dispatched = row.dispatched_at.getTime();
      if (row.deleted_at !== null || row.superseded_at !== null || row.valid_to !== null || row.consolidated_into_id !== null ||
          (row.expires_at !== null && row.expires_at.getTime() <= dispatched) ||
          (row.valid_from !== null && row.valid_from.getTime() > dispatched)) {
        throw new Error(`Floor exception rollback lifecycle drift for ${approval.id}`);
      }
      if (row.relevance_base_score === null) {
        if (!scoreClose(Number(row.relevance_score), approval.currentScore)) {
          throw new Error(`Already-restored floor exception row does not match approval: ${approval.id}`);
        }
        alreadyRestored += 1;
        continue;
      }
      if (!scoreClose(Number(row.relevance_base_score), 0) || !scoreClose(Number(row.relevance_score), approval.proposedScore)) {
        throw new Error(`Floor exception rollback state drift for ${approval.id}`);
      }
      const restoredResult = await client.query(`UPDATE public.memories
        SET relevance_base_score = NULL, relevance_score = $2, updated_at = statement_timestamp()
        WHERE id = $1::uuid AND relevance_base_score = 0 AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > statement_timestamp())
          AND superseded_at IS NULL AND valid_to IS NULL
          AND (valid_from IS NULL OR valid_from <= statement_timestamp())
          AND consolidated_into_id IS NULL`, [approval.id, approval.currentScore]);
      if (restoredResult.rowCount !== 1) throw new Error(`Floor exception rollback race or lifecycle drift for ${approval.id}`);
      restored += 1;
    }
    await client.query(`INSERT INTO public.audit_log(client_id,action,result_count)
      VALUES('system:maintenance','relevance_base_floor_exception_rollback',$1)`, [restored]);
    await client.query('COMMIT');
    return { restored, alreadyRestored, finalized: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}

export async function finalizeCalibratedRelevanceBase(connectionString: string, backupVerified: boolean) {
  if (backupVerified !== true) throw new Error('Finalization requires a verified restorable backup acknowledgement');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await verifyAllRowMaintenanceRole(client);
    await client.query('BEGIN');
    const remaining = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM public.memories WHERE relevance_base_score IS NULL');
    if (Number(remaining.rows[0]?.count ?? 0) !== 0) throw new Error('Cannot finalize while unclassified relevance bases remain');
    await client.query('ALTER TABLE public.memories VALIDATE CONSTRAINT memories_relevance_base_score_valid');
    await client.query('ALTER TABLE public.memories ALTER COLUMN relevance_base_score SET NOT NULL');
    await client.query('COMMIT');
    return { finalized: true, remaining: 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.end(); }
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main() {
  const connectionString = resolveMaintenanceDatabaseUrl(process.env);
  const calibrationPreview = flag('--calibration-preview');
  if (calibrationPreview) {
    const asOf = flag('--as-of');
    if (!asOf) throw new Error('--as-of is required for calibration preview');
    const limit = Number(flag('--limit') ?? '100');
    const preview = await previewCalibrationBatch(connectionString, asOf, flag('--after') ?? null, limit);
    await writeFile(calibrationPreview, JSON.stringify(preview, null, 2));
    console.log(JSON.stringify({ dryRun: true, writes: 0, candidates: preview.candidates.length,
      rejected: preview.candidates.filter(item => item.rejectionReason).length, nextCursor: preview.nextCursor }));
    return;
  }
  const calibrationApply = flag('--calibration-apply');
  if (calibrationApply) {
    const manifest = JSON.parse(await readFile(calibrationApply, 'utf8')) as CalibrationManifest;
    console.log(JSON.stringify(await applyCalibrationBatch(connectionString, manifest)));
    return;
  }
  const floorPreview = flag('--floor-exception-preview');
  if (floorPreview) {
    const idsFile = flag('--ids');
    if (!idsFile) throw new Error('--ids is required for floor exception preview');
    const preview = await previewFloorExceptionBatch(connectionString, JSON.parse(await readFile(idsFile, 'utf8')));
    await writeFile(floorPreview, JSON.stringify(preview, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ dryRun: true, writes: 0, candidates: preview.candidates.length,
      rejected: preview.candidates.filter(item => item.rejectionReason).length }));
    return;
  }
  const floorApply = flag('--floor-exception-apply');
  if (floorApply) {
    const manifest = JSON.parse(await readFile(floorApply, 'utf8')) as FloorExceptionManifest;
    console.log(JSON.stringify(await applyFloorExceptionBatch(connectionString, manifest)));
    return;
  }
  const floorRollback = flag('--floor-exception-rollback');
  if (floorRollback) {
    const manifest = JSON.parse(await readFile(floorRollback, 'utf8')) as FloorExceptionManifest;
    console.log(JSON.stringify(await rollbackFloorExceptionBatch(connectionString, manifest)));
    return;
  }
  if (process.argv.includes('--finalize-calibration')) {
    console.log(JSON.stringify(await finalizeCalibratedRelevanceBase(connectionString,
      process.argv.includes('--backup-verified'))));
    return;
  }
  const applyFile = flag('--apply');
  if (applyFile) {
    const manifest = JSON.parse(await readFile(applyFile, 'utf8')) as ApprovalManifest;
    console.log(JSON.stringify(await applyRelevanceRepair(connectionString, manifest)));
    return;
  }
  const output = flag('--preview');
  if (!output) throw new Error('Use bounded --calibration-preview/--calibration-apply, reviewed --floor-exception-preview/--floor-exception-apply/--floor-exception-rollback, explicit --finalize-calibration, or legacy --preview/--apply');
  const candidates = await previewRelevanceRepair(connectionString);
  await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), candidates }, null, 2));
  console.log(JSON.stringify({ dryRun: true, writes: 0, candidates: candidates.length, output }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('Relevance repair failed:', error); process.exit(1); });
}
