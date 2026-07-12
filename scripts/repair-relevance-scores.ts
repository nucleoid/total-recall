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
  WHERE relevance_base_score IS NULL
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
          `SELECT id, relevance_base_score FROM public.memories WHERE id = ANY($1::uuid[])`,
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
         WHERE id = $1`,
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

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main() {
  const connectionString = resolveMaintenanceDatabaseUrl(process.env);
  const applyFile = flag('--apply');
  if (applyFile) {
    const manifest = JSON.parse(await readFile(applyFile, 'utf8')) as ApprovalManifest;
    console.log(JSON.stringify(await applyRelevanceRepair(connectionString, manifest)));
    return;
  }
  const output = flag('--preview');
  if (!output) throw new Error('Use --preview <export.json> or --apply <approved-manifest.json>');
  const candidates = await previewRelevanceRepair(connectionString);
  await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), candidates }, null, 2));
  console.log(JSON.stringify({ dryRun: true, writes: 0, candidates: candidates.length, output }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('Relevance repair failed:', error); process.exit(1); });
}
