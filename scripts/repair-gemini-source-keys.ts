import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { createGeminiSourceKey } from './preseed-gemini.js';

const LEGACY_KEY = /^gemini-conv:\d+:.+$/;
const CLIENT_ID = 'preseed-gemini';
const SOURCE = 'gemini-conversation';
const ADVISORY_LOCK_KEY = 430043;
const DEFAULT_PREVIEW_LIMIT = 100;

export interface RepairRow {
  id: string;
  source_key: string;
  content: string;
  created_at: string | Date;
  source: string;
  client_id: string;
  namespace: string;
  tags: unknown;
  metadata: unknown;
  updated_at?: string | Date | null;
  embedding?: unknown;
  event_at?: string | Date | null;
  access_level?: string | null;
  agent_id?: string | null;
}

export interface RepairCandidate {
  id: string;
  sourceKey: string;
  targetKey: string;
  fingerprint: string;
}

export interface RepairCollision {
  targetKey: string;
  ids: string[];
  byteEquivalent: boolean;
  oldestId: string;
}

export interface RepairPreview {
  totalCandidates: number;
  candidates: RepairCandidate[];
  candidatesTruncated: boolean;
  collisions: RepairCollision[];
}

export interface Approval {
  id: string;
  expectedFingerprint: string;
  targetKey: string;
  action: 'rekey' | 'retain' | 'delete' | 'leave';
  retainId?: string;
}

export interface ApprovalManifest {
  version: 1;
  backupVerified: boolean;
  approvals: Approval[];
}

export interface RepairQueryResult { rows: RepairRow[]; rowCount: number }
export interface RepairQueryClient { query(text: string, values?: unknown[]): Promise<RepairQueryResult> }
export interface RepairResult { rekeyed: string[]; deleted: string[]; retained: string[] }

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid created_at for repair row`);
  return date.toISOString();
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function stateForFingerprint(row: RepairRow): unknown {
  return {
    id: row.id,
    source_key: row.source_key,
    content: row.content,
    created_at: iso(row.created_at),
    source: row.source,
    client_id: row.client_id,
    namespace: row.namespace,
    tags: row.tags,
    metadata: row.metadata,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ?? null,
    embedding: row.embedding ?? null,
    event_at: row.event_at instanceof Date ? row.event_at.toISOString() : row.event_at ?? null,
    access_level: row.access_level ?? null,
    agent_id: row.agent_id ?? null,
  };
}

export function repairRowFingerprint(row: RepairRow): string {
  return createHash('sha256').update(stable(stateForFingerprint(row)), 'utf8').digest('hex');
}

function inLegacyScope(row: RepairRow): boolean {
  return row.client_id === CLIENT_ID && row.source === SOURCE && LEGACY_KEY.test(row.source_key);
}

function targetKey(row: RepairRow): string {
  return createGeminiSourceKey(row.content, iso(row.created_at));
}

function equivalentPayload(left: RepairRow, right: RepairRow): boolean {
  // ID, positional source key and update audit time are expected to differ. All persisted payload is not.
  return stable({
    content: left.content, created_at: iso(left.created_at), source: left.source, client_id: left.client_id,
    namespace: left.namespace, tags: left.tags, metadata: left.metadata, embedding: left.embedding ?? null,
    event_at: left.event_at instanceof Date ? left.event_at.toISOString() : left.event_at ?? null,
    access_level: left.access_level ?? null, agent_id: left.agent_id ?? null,
  }) === stable({
    content: right.content, created_at: iso(right.created_at), source: right.source, client_id: right.client_id,
    namespace: right.namespace, tags: right.tags, metadata: right.metadata, embedding: right.embedding ?? null,
    event_at: right.event_at instanceof Date ? right.event_at.toISOString() : right.event_at ?? null,
    access_level: right.access_level ?? null, agent_id: right.agent_id ?? null,
  });
}

function oldest(rows: RepairRow[]): RepairRow {
  const auditTime = (row: RepairRow) => row.updated_at ? iso(row.updated_at) : iso(row.created_at);
  return [...rows].sort((a, b) => auditTime(a).localeCompare(auditTime(b)) || a.id.localeCompare(b.id))[0];
}

export function buildGeminiRepairPreview(rows: RepairRow[], limit = DEFAULT_PREVIEW_LIMIT): RepairPreview {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Preview limit must be a non-negative integer');
  const scoped = rows.filter(inLegacyScope);
  const allById = new Map(rows.map(row => [row.id, row]));
  const internal = scoped.map(row => ({ id: row.id, sourceKey: row.source_key, targetKey: targetKey(row), fingerprint: repairRowFingerprint(row) }));
  const grouped = new Map<string, RepairRow[]>();
  for (const candidate of internal) {
    const affected = grouped.get(candidate.targetKey) ?? [];
    affected.push(allById.get(candidate.id)!);
    grouped.set(candidate.targetKey, affected);
  }
  // Include a pre-existing v2 target in collision analysis; unrelated v2 rows stay untouched.
  for (const row of rows) {
    if (row.client_id !== CLIENT_ID || row.source !== SOURCE || !grouped.has(row.source_key) || inLegacyScope(row)) continue;
    grouped.get(row.source_key)!.push(row);
  }
  const collisions = [...grouped.entries()].filter(([, group]) => group.length > 1).map(([key, group]) => ({
    targetKey: key,
    ids: group.map(row => row.id).sort(),
    byteEquivalent: group.every(row => equivalentPayload(group[0], row)),
    oldestId: oldest(group).id,
  }));
  return {
    totalCandidates: internal.length,
    candidates: internal.slice(0, limit),
    candidatesTruncated: internal.length > limit,
    collisions,
  };
}

const SELECT_SCOPE_SQL = `SELECT id, source_key, content, created_at, source, client_id, namespace, tags, metadata, updated_at, embedding::text AS embedding, event_at, access_level, agent_id
FROM memories
WHERE client_id = 'preseed-gemini' AND source = 'gemini-conversation'
  AND source_key ~ '^gemini-conv:[0-9]+:'`;

async function loadRows(client: RepairQueryClient, lock: boolean): Promise<RepairRow[]> {
  const legacy = await client.query(`${SELECT_SCOPE_SQL}${lock ? ' FOR UPDATE' : ''}`);
  const targets = [...new Set(legacy.rows.map(targetKey))];
  if (targets.length === 0) return legacy.rows;
  const existing = await client.query(`SELECT id, source_key, content, created_at, source, client_id, namespace, tags, metadata, updated_at, embedding::text AS embedding, event_at, access_level, agent_id
FROM memories
WHERE client_id = 'preseed-gemini' AND source = 'gemini-conversation' AND source_key = ANY($1)${lock ? ' FOR UPDATE' : ''}`, [targets]);
  return [...new Map([...legacy.rows, ...existing.rows].map(row => [row.id, row])).values()];
}

function validateManifest(rows: RepairRow[], manifest: ApprovalManifest): { preview: RepairPreview; approvals: Map<string, Approval> } {
  if (manifest.version !== 1) throw new Error('Unsupported approval manifest version');
  if (manifest.backupVerified !== true) throw new Error('Apply requires an explicit verified, restorable backup acknowledgement');
  if (!Array.isArray(manifest.approvals)) throw new Error('Approval manifest requires exact row approvals');
  const approvals = new Map<string, Approval>();
  for (const approval of manifest.approvals) {
    if (!approval.id || approvals.has(approval.id)) throw new Error(`Duplicate or broad approval is not permitted: ${approval.id || '<missing id>'}`);
    approvals.set(approval.id, approval);
  }
  const preview = buildGeminiRepairPreview(rows, Number.MAX_SAFE_INTEGER);
  const candidateIds = new Set(preview.candidates.map(candidate => candidate.id));
  for (const candidate of preview.candidates) {
    const approval = approvals.get(candidate.id);
    if (!approval) throw new Error(`Incomplete manifest: unapproved candidate ${candidate.id}`);
    if (approval.expectedFingerprint !== candidate.fingerprint) throw new Error(`State drift or fingerprint mismatch for ${candidate.id}`);
    if (approval.targetKey !== candidate.targetKey) throw new Error(`Target key mismatch for ${candidate.id}`);
  }
  for (const approval of approvals.values()) {
    const row = rows.find(item => item.id === approval.id);
    if (!row) throw new Error(`Approved row is missing: ${approval.id}`);
    if (repairRowFingerprint(row) !== approval.expectedFingerprint) throw new Error(`State drift or fingerprint mismatch for ${approval.id}`);
    const expectedTarget = inLegacyScope(row) ? targetKey(row) : row.source_key;
    if (approval.targetKey !== expectedTarget) throw new Error(`Target key mismatch for ${approval.id}`);
    if (!candidateIds.has(approval.id) && !preview.collisions.some(group => group.ids.includes(approval.id))) {
      throw new Error(`Approval affects an unrelated row: ${approval.id}`);
    }
  }
  for (const collision of preview.collisions) {
    for (const id of collision.ids) if (!approvals.has(id)) throw new Error(`Unapproved affected collision row ${id}`);
    const groupApprovals = collision.ids.map(id => approvals.get(id)!);
    const retained = groupApprovals.filter(item => item.action === 'retain');
    const deleted = groupApprovals.filter(item => item.action === 'delete');
    if (!collision.byteEquivalent && deleted.length > 0) throw new Error(`Collision ${collision.targetKey} is not byte-equivalent`);
    if (collision.byteEquivalent) {
      if (retained.length !== 1 || retained[0].id !== collision.oldestId) throw new Error(`Collision must retain oldest ID ${collision.oldestId}`);
      if (deleted.length !== collision.ids.length - 1) throw new Error(`Collision approval is incomplete for ${collision.targetKey}`);
      if (groupApprovals.some(item => item.retainId !== collision.oldestId)) throw new Error(`Collision retainId must be oldest ID ${collision.oldestId}`);
    } else if (groupApprovals.some(item => item.action !== 'leave')) {
      throw new Error(`Non-equivalent collision requires exact leave approvals and must remain unchanged`);
    }
  }
  return { preview, approvals };
}

export async function applyGeminiKeyRepair(client: RepairQueryClient, manifest: ApprovalManifest): Promise<RepairResult> {
  if (manifest.backupVerified !== true) throw new Error('Apply requires an explicit verified, restorable backup acknowledgement');
  let began = false;
  try {
    await client.query('BEGIN'); began = true;
    await client.query(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`);
    const rows = await loadRows(client, true);
    const { preview, approvals } = validateManifest(rows, manifest);
    const result: RepairResult = { rekeyed: [], deleted: [], retained: [] };
    const collisionIds = new Set(preview.collisions.flatMap(group => group.ids));
    for (const collision of preview.collisions) {
      if (!collision.byteEquivalent) continue; // Explicitly approved rekeys cannot be unique; leave uncertain group wholly unchanged.
      const retain = approvals.get(collision.oldestId)!;
      const retainedRow = rows.find(row => row.id === retain.id)!;
      result.retained.push(retain.id);
      // Free a target held by an approved v2 duplicate before rekeying; the transaction restores deletes if rekey fails.
      for (const id of collision.ids.filter(id => id !== retain.id)) {
        const deleted = await client.query('DELETE FROM memories WHERE id = $1', [id]);
        if (deleted.rowCount !== 1) throw new Error(`Failed to delete approved duplicate ${id}`);
        result.deleted.push(id);
      }
      if (inLegacyScope(retainedRow)) {
        const updated = await client.query('UPDATE memories SET source_key = $1 WHERE id = $2', [collision.targetKey, retain.id]);
        if (updated.rowCount !== 1) throw new Error(`Failed to rekey ${retain.id}`);
        result.rekeyed.push(retain.id);
      }
    }
    for (const candidate of preview.candidates) {
      if (collisionIds.has(candidate.id)) continue;
      if (approvals.get(candidate.id)!.action !== 'rekey') throw new Error(`Ordinary candidate ${candidate.id} requires rekey action`);
      const updated = await client.query('UPDATE memories SET source_key = $1 WHERE id = $2', [candidate.targetKey, candidate.id]);
      if (updated.rowCount !== 1) throw new Error(`Failed to rekey ${candidate.id}`);
      result.rekeyed.push(candidate.id);
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (began) try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    throw error;
  }
}

export async function previewGeminiKeyRepair(client: RepairQueryClient, limit = DEFAULT_PREVIEW_LIMIT): Promise<RepairPreview> {
  return buildGeminiRepairPreview(await loadRows(client, false), limit);
}

export function parseRepairArguments(args: string[]): { applyManifest?: string; limit: number } {
  let applyManifest: string | undefined;
  let limit = DEFAULT_PREVIEW_LIMIT;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') applyManifest = args[++index];
    else if (args[index] === '--limit') limit = Number(args[++index]);
    else throw new Error(`Unknown option: ${args[index]}`);
  }
  if (applyManifest !== undefined && !applyManifest) throw new Error('--apply requires an approval manifest path');
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('--limit requires a non-negative integer');
  return { applyManifest, limit };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const connectionString = process.env.MIGRATION_DATABASE_URL?.trim();
  if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required; the app-role DATABASE_URL is never used for historical repair');
  const options = parseRepairArguments(args);
  const pool = new pg.Pool({ connectionString, max: 1 });
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    if (!options.applyManifest) {
      const preview = await previewGeminiKeyRepair(client, options.limit);
      console.log(JSON.stringify(preview, null, 2));
      console.error('PREVIEW ONLY: no rows were changed. Apply requires a verified backup and exact approval manifest.');
      return;
    }
    const manifest = JSON.parse(await readFile(options.applyManifest, 'utf8')) as ApprovalManifest;
    console.log(JSON.stringify(await applyGeminiKeyRepair(client, manifest), null, 2));
  } finally {
    client?.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('Fatal:', error); process.exitCode = 1; });
}
