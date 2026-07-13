import path from 'node:path';

export type PathImplementation = typeof path.posix;

export const DEFAULT_OPENCLAW_WORKSPACE = '/home/fuego/.openclaw/workspace';

interface DirectoryStat {
  isDirectory(): boolean;
}

export function resolveWorkspaceRoot(
  configured: string | undefined,
  statSync: (candidate: string) => DirectoryStat,
  implementation: PathImplementation = path,
  fromDirectory?: string,
): string {
  if (configured !== undefined && configured.trim() === '') {
    throw new Error('OPENCLAW_WORKSPACE must not be blank');
  }
  const selected = configured ?? DEFAULT_OPENCLAW_WORKSPACE;
  const resolved = fromDirectory === undefined
    ? implementation.resolve(selected)
    : implementation.resolve(fromDirectory, selected);
  let stat: DirectoryStat;
  try {
    stat = statSync(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`OPENCLAW_WORKSPACE must be an existing directory: ${resolved}`);
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new Error(`OPENCLAW_WORKSPACE must be an existing directory: ${resolved}`);
  }
  return resolved;
}

export interface WatchSpec {
  path: string;
  kind: 'file' | 'directory';
  namespace: string;
  source: string;
}

const FILE_SPECS = [
  ['MEMORY.md', 'personal', 'openclaw-memory'],
  ['USER.md', 'personal', 'openclaw-user'],
  ['IDENTITY.md', 'personal', 'openclaw-identity'],
  ['TOOLS.md', 'projects', 'openclaw-tools'],
  ['HEARTBEAT.md', 'projects', 'openclaw-heartbeat'],
  ['AGENTS.md', 'projects', 'openclaw-agents'],
] as const;

const DIRECTORY_SPECS = [
  [['memory'], 'personal', 'openclaw-daily'],
  [['projects', 'cortex', 'content', 'journals'], 'personal', 'cortex-journal'],
  [['projects', 'cortex', 'content', 'concepts'], 'projects', 'cortex-concept'],
  [['projects', 'cortex', 'content', 'projects'], 'projects', 'cortex-project'],
  [['projects', 'cortex', 'content', 'documents'], 'shared', 'cortex-document'],
] as const;

export function buildWatchSpecs(
  workspace: string,
  implementation: PathImplementation = path,
): WatchSpec[] {
  const root = implementation.resolve(workspace);
  return [
    ...FILE_SPECS.map(([name, namespace, source]) => ({
      path: implementation.join(root, name), kind: 'file' as const, namespace, source,
    })),
    ...DIRECTORY_SPECS.map(([segments, namespace, source]) => ({
      path: implementation.join(root, ...segments), kind: 'directory' as const, namespace, source,
    })),
  ];
}

function containedRelative(
  parent: string,
  candidate: string,
  implementation: PathImplementation,
): string | null {
  const relative = implementation.relative(
    implementation.resolve(parent),
    implementation.resolve(candidate),
  );
  if (
    implementation.isAbsolute(relative)
    || relative === '..'
    || relative.startsWith(`..${implementation.sep}`)
  ) return null;
  return relative;
}

export function matchWatchSpec(
  candidate: string,
  specs: WatchSpec[],
  implementation: PathImplementation = path,
): WatchSpec | null {
  const matches = specs.filter((spec) => {
    const relative = containedRelative(spec.path, candidate, implementation);
    return relative !== null && (relative === '' || spec.kind === 'directory');
  });
  matches.sort((left, right) => {
    const lengthDifference = implementation.resolve(right.path).length - implementation.resolve(left.path).length;
    return lengthDifference || left.path.localeCompare(right.path);
  });
  return matches[0] ?? null;
}

export interface WorkspaceFileIdentity {
  absolutePath: string;
  relativePath: string;
}

export function resolveWorkspaceFile(
  workspace: string,
  candidate: string,
  implementation: PathImplementation = path,
): WorkspaceFileIdentity {
  const absolutePath = implementation.resolve(candidate);
  const relative = containedRelative(workspace, absolutePath, implementation);
  if (relative === null) throw new Error(`Watcher candidate is outside the workspace: ${candidate}`);
  if (relative === '') throw new Error('Watcher candidate must identify a file inside the workspace');
  return {
    absolutePath,
    relativePath: relative.split(implementation.sep).join('/'),
  };
}

export function canonicalWorkspaceFile(
  workspace: string,
  candidate: string,
  implementation: PathImplementation = path,
): string {
  return resolveWorkspaceFile(workspace, candidate, implementation).relativePath;
}

export type ExclusionCode =
  | 'not-markdown'
  | 'environment-file'
  | 'deliverables-directory'
  | 'file-too-large';

export interface ExclusionReason {
  code: ExclusionCode;
}

export const MAX_WATCHED_FILE_BYTES = 1_000_000;

export function exclusionReason(
  canonicalRelativePath: string,
  implementation: PathImplementation = path,
): ExclusionReason | null {
  const segments = canonicalRelativePath.split(implementation.sep);
  const basename = segments.at(-1) ?? '';
  if (basename.startsWith('.env')) return { code: 'environment-file' };
  if (!basename.endsWith('.md')) return { code: 'not-markdown' };
  if (segments.slice(0, -1).some(segment => segment.toLocaleLowerCase('en-US') === 'deliverables')) {
    return { code: 'deliverables-directory' };
  }
  return null;
}

export function fileSizeExclusionReason(size: number): ExclusionReason | null {
  return size > MAX_WATCHED_FILE_BYTES ? { code: 'file-too-large' } : null;
}

export function formatExclusionLog(
  canonicalRelativePath: string,
  reason: ExclusionReason,
): string {
  return `[watcher] Skipped ${canonicalRelativePath}: ${reason.code}`;
}
