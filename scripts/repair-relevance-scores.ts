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
    AND superseded_at IS NULL AND valid_to IS NULL
    AND (valid_from IS NULL OR valid_from <= $1::timestamptz)
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
        AND superseded_at IS NULL AND valid_to IS NULL
        AND (valid_from IS NULL OR valid_from <= $2::timestamptz)
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
        WHERE id = $1::uuid AND deleted_at IS NULL AND relevance_base_score IS NULL`,
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
  if (!output) throw new Error('Use bounded --calibration-preview/--calibration-apply, explicit --finalize-calibration, or legacy --preview/--apply');
  const candidates = await previewRelevanceRepair(connectionString);
  await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), candidates }, null, 2));
  console.log(JSON.stringify({ dryRun: true, writes: 0, candidates: candidates.length, output }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('Relevance repair failed:', error); process.exit(1); });
}
