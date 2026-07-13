import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withMaintenanceClient } from './lib/maintenance-db.js';

export interface RepairClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface OrphanCandidate {
  filePath: string;
  memoryIds: string[];
  namespaces: string[];
  sourceKeys: Array<string | null>;
  syncStateHash: string | null;
  rowFingerprint: string;
}

export interface OrphanPreview {
  version: 1;
  workspaceRoot: string;
  generatedAt: string;
  candidates: OrphanCandidate[];
  skipped: Array<{ filePath: string; reason: 'non-canonical-path' }>;
  truncated: boolean;
  nextOffset: number | null;
}

export interface OrphanApproval {
  filePath: string;
  memoryIds: string[];
  rowFingerprint: string;
  syncStateHash: string | null;
}

export interface OrphanApprovalManifest {
  version: 1;
  backupVerified: boolean;
  workspaceVerified: boolean;
  workspaceRoot: string;
  approvals: OrphanApproval[];
}

interface CandidateRow {
  id: string;
  namespace: string;
  file_path: string;
  source_key: string | null;
  updated_at: string | Date;
  content_hash: string | null;
}

interface FileAccess {
  exists(filePath: string): Promise<boolean>;
}

function canonicalApprovalPath(filePath: string): string {
  if (!filePath || path.posix.isAbsolute(filePath) || filePath.includes('\\')) {
    throw new Error(`Approval filePath must be a canonical workspace-relative path: ${filePath}`);
  }
  const normalized = path.posix.normalize(filePath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized !== filePath) {
    throw new Error(`Approval filePath must be a canonical workspace-relative path: ${filePath}`);
  }
  return normalized;
}

function candidateFingerprint(rows: CandidateRow[]): string {
  const facts = rows
    .map(row => ({
      id: row.id,
      namespace: row.namespace,
      filePath: row.file_path,
      sourceKey: row.source_key,
      updatedAt: new Date(row.updated_at).toISOString(),
      syncStateHash: row.content_hash,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

function groupCandidate(rows: CandidateRow[]): OrphanCandidate {
  const ordered = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  return {
    filePath: ordered[0].file_path,
    memoryIds: ordered.map(row => row.id),
    namespaces: [...new Set(ordered.map(row => row.namespace))].sort(),
    sourceKeys: ordered.map(row => row.source_key),
    syncStateHash: ordered[0].content_hash,
    rowFingerprint: candidateFingerprint(ordered),
  };
}

const defaultAccess: FileAccess = {
  async exists(filePath) {
    try { await fs.stat(filePath); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
};

export async function previewWatcherOrphans(
  client: RepairClient,
  workspaceRoot: string,
  options: FileAccess & { limit: number; offset?: number } = { ...defaultAccess, limit: 100 },
): Promise<OrphanPreview> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
    throw new Error('Preview limit must be an integer from 1 to 1000');
  }
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Preview offset must be a nonnegative integer');
  const result = await client.query(`
SELECT m.id, m.namespace, m.metadata->>'file' AS file_path, m.source_key,
       m.updated_at, s.content_hash
FROM memories m
LEFT JOIN sync_state s ON s.file_path = m.metadata->>'file'
WHERE m.client_id = 'file-sync'
  AND m.metadata->>'file' IS NOT NULL
  AND m.metadata->>'file' IN (
    SELECT DISTINCT metadata->>'file'
    FROM memories
    WHERE client_id = 'file-sync' AND metadata->>'file' IS NOT NULL
    ORDER BY metadata->>'file'
    LIMIT $1 OFFSET $2
  )
ORDER BY file_path, m.id
`, [options.limit + 1, offset]);

  const rawGroups = new Map<string, CandidateRow[]>();
  for (const row of result.rows as CandidateRow[]) {
    const rows = rawGroups.get(row.file_path) ?? [];
    rows.push(row);
    rawGroups.set(row.file_path, rows);
  }
  const page = [...rawGroups.entries()].slice(0, options.limit);
  const candidates: OrphanCandidate[] = [];
  const skipped: OrphanPreview['skipped'] = [];
  for (const [rawFilePath, rows] of page) {
    let filePath: string;
    try {
      filePath = canonicalApprovalPath(rawFilePath);
    } catch {
      skipped.push({ filePath: rawFilePath, reason: 'non-canonical-path' });
      continue;
    }
    if (!await options.exists(path.resolve(workspaceRoot, ...filePath.split('/')))) {
      candidates.push(groupCandidate(rows));
    }
  }
  const truncated = rawGroups.size > options.limit;
  return {
    version: 1,
    workspaceRoot: path.resolve(workspaceRoot),
    generatedAt: new Date().toISOString(),
    candidates,
    skipped,
    truncated,
    nextOffset: truncated ? offset + options.limit : null,
  };
}

function validateManifest(manifest: OrphanApprovalManifest): void {
  if (manifest.version !== 1) throw new Error('Unsupported approval manifest version');
  if (manifest.backupVerified !== true) throw new Error('A verified restorable backup acknowledgement is required');
  if (manifest.workspaceVerified !== true) throw new Error('Authoritative workspace verification is required');
  if (!manifest.workspaceRoot?.trim()) throw new Error('Authoritative workspaceRoot is required');
  if (!Array.isArray(manifest.approvals)) throw new Error('approvals must be an array');
  const paths = new Set<string>();
  for (const approval of manifest.approvals) {
    canonicalApprovalPath(approval.filePath);
    if (paths.has(approval.filePath)) throw new Error(`Duplicate approval path: ${approval.filePath}`);
    paths.add(approval.filePath);
    if (!Array.isArray(approval.memoryIds) || approval.memoryIds.length === 0) {
      throw new Error(`Approval memoryIds must contain exact IDs for ${approval.filePath}`);
    }
    if (new Set(approval.memoryIds).size !== approval.memoryIds.length || approval.memoryIds.some(id => !/^[0-9a-f-]{36}$/i.test(id))) {
      throw new Error(`Approval memoryIds are invalid or duplicated for ${approval.filePath}`);
    }
    if (!/^[a-f0-9]{64}$/.test(approval.rowFingerprint)) {
      throw new Error(`Approval rowFingerprint is invalid for ${approval.filePath}`);
    }
  }
}

export async function applyApprovedOrphans(
  client: RepairClient,
  manifest: OrphanApprovalManifest,
  access: FileAccess = defaultAccess,
): Promise<{ pathsDeleted: number; memoriesDeleted: number }> {
  validateManifest(manifest);
  const root = path.resolve(manifest.workspaceRoot);
  for (const approval of manifest.approvals) {
    const absolute = path.resolve(root, ...approval.filePath.split('/'));
    if (await access.exists(absolute)) {
      throw new Error(`Candidate is present in the authoritative workspace: ${approval.filePath}`);
    }
  }

  await client.query('BEGIN');
  let memoriesDeleted = 0;
  try {
    for (const approval of manifest.approvals) {
      const locked = await client.query(`
SELECT m.id, m.namespace, m.metadata->>'file' AS file_path, m.source_key,
       m.updated_at, s.content_hash
FROM memories m
LEFT JOIN sync_state s ON s.file_path = m.metadata->>'file'
WHERE m.client_id = 'file-sync' AND m.metadata->>'file' = $1
ORDER BY m.id
FOR UPDATE OF m
`, [approval.filePath]);
      const rows = locked.rows as CandidateRow[];
      const actualIds = rows.map(row => row.id).sort();
      const approvedIds = [...approval.memoryIds].sort();
      if (JSON.stringify(actualIds) !== JSON.stringify(approvedIds)) {
        throw new Error(`Unapproved rows or approved-row drift for ${approval.filePath}`);
      }
      const state = await client.query(
        'SELECT content_hash FROM sync_state WHERE file_path = $1 FOR UPDATE',
        [approval.filePath],
      );
      const actualStateHash = state.rows[0]?.content_hash ?? null;
      if (actualStateHash !== approval.syncStateHash || candidateFingerprint(rows) !== approval.rowFingerprint) {
        throw new Error(`Fingerprint drift for ${approval.filePath}`);
      }
      const deleted = await client.query(`DELETE FROM memories
WHERE client_id = 'file-sync'
  AND metadata->>'file' = $1
  AND id = ANY($2::uuid[])`, [approval.filePath, approval.memoryIds]);
      if (deleted.rowCount !== approval.memoryIds.length) throw new Error(`Delete count drift for ${approval.filePath}`);
      memoriesDeleted += deleted.rowCount ?? 0;
      await client.query('DELETE FROM sync_state WHERE file_path = $1 AND content_hash IS NOT DISTINCT FROM $2', [
        approval.filePath,
        approval.syncStateHash,
      ]);
    }
    await client.query('COMMIT');
    return { pathsDeleted: manifest.approvals.length, memoriesDeleted };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const workspace = argument('--workspace') ?? process.env.OPENCLAW_WORKSPACE;
  if (!workspace) throw new Error('--workspace or OPENCLAW_WORKSPACE is required');
  const previewPath = argument('--preview');
  const applyPath = argument('--apply');
  if ((previewPath ? 1 : 0) + (applyPath ? 1 : 0) !== 1) {
    throw new Error('Choose exactly one of --preview <output.json> or --apply <manifest.json>');
  }
  await fs.stat(path.resolve(workspace));
  await withMaintenanceClient(process.env, async (client, identity) => {
    console.error(`[repair-watcher-orphans] database=${identity.database} user=${identity.user} server=${identity.server}`);
    if (previewPath) {
      const limit = Number(argument('--limit') ?? '100');
      const offset = Number(argument('--offset') ?? '0');
      const preview = await previewWatcherOrphans(client, workspace, { ...defaultAccess, limit, offset });
      await fs.writeFile(previewPath, `${JSON.stringify(preview, null, 2)}\n`, { flag: 'wx' });
      console.log(JSON.stringify({ mode: 'preview', candidates: preview.candidates.length, output: previewPath }));
      return;
    }
    const manifest = JSON.parse(await fs.readFile(applyPath!, 'utf8')) as OrphanApprovalManifest;
    if (path.resolve(manifest.workspaceRoot) !== path.resolve(workspace)) {
      throw new Error('Manifest workspaceRoot does not match the explicitly verified workspace');
    }
    const result = await applyApprovedOrphans(client, manifest);
    console.log(JSON.stringify({ mode: 'apply', ...result }));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(`[repair-watcher-orphans] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
