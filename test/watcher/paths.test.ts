import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  buildWatchSpecs,
  canonicalWorkspaceFile,
  exclusionReason,
  matchWatchSpec,
  resolveWorkspaceRoot,
} from '../../src/watcher/paths.js';

const winRoot = 'C:\\Users\\me\\.openclaw\\workspace';

test('win32 maps native and alias paths to the daily spec and one portable identity', () => {
  const specs = buildWatchSpecs(winRoot, path.win32);
  const native = 'C:\\Users\\me\\.openclaw\\workspace\\memory\\day.md';
  const aliases = [native, 'C:/Users/me/.openclaw/workspace/memory/./day.md'];

  assert.equal(matchWatchSpec(native, specs, path.win32)?.source, 'openclaw-daily');
  assert.deepEqual(aliases.map(candidate => canonicalWorkspaceFile(winRoot, candidate, path.win32)), [
    'memory/day.md',
    'memory/day.md',
  ]);

  // Containment follows Windows semantics, but identity spelling is not blindly lowercased.
  assert.equal(canonicalWorkspaceFile(winRoot.toUpperCase(), native, path.win32), 'memory/day.md');
  assert.equal(canonicalWorkspaceFile(winRoot, native.toUpperCase(), path.win32), 'MEMORY/DAY.MD');
});

test('POSIX identities remain workspace-relative and use forward slashes', () => {
  const root = '/home/fuego/.openclaw/workspace';
  const candidate = '/home/fuego/.openclaw/workspace/memory/2026-01-01.md';
  assert.equal(matchWatchSpec(candidate, buildWatchSpecs(root, path.posix), path.posix)?.source, 'openclaw-daily');
  assert.equal(canonicalWorkspaceFile(root, candidate, path.posix), 'memory/2026-01-01.md');
});

test('containment rejects sibling prefixes, traversal, other drives and UNC shares', () => {
  const specs = buildWatchSpecs(winRoot, path.win32);
  for (const candidate of [
    'C:\\Users\\me\\.openclaw\\workspace-old\\memory\\day.md',
    'C:\\Users\\me\\.openclaw\\workspace\\memory\\..\\..\\outside.md',
    'D:\\Users\\me\\.openclaw\\workspace\\memory\\day.md',
    '\\\\server\\share\\workspace\\memory\\day.md',
  ]) {
    assert.equal(matchWatchSpec(candidate, specs, path.win32), null, candidate);
    assert.throws(() => canonicalWorkspaceFile(winRoot, candidate, path.win32), /outside|file/i, candidate);
  }

  const uncRoot = '\\\\server\\share\\workspace';
  assert.equal(
    canonicalWorkspaceFile(uncRoot, '\\\\server\\share\\workspace\\memory\\day.md', path.win32),
    'memory/day.md',
  );
  assert.throws(
    () => canonicalWorkspaceFile(uncRoot, '\\\\server\\other\\workspace\\memory\\day.md', path.win32),
    /outside/i,
  );
});

test('exact-file specs reject descendants and the most-specific overlap wins', () => {
  const specs = buildWatchSpecs(winRoot, path.win32);
  assert.equal(matchWatchSpec(`${winRoot}\\MEMORY.md\\child.md`, specs, path.win32), null);

  const overlapping = [
    { path: `${winRoot}\\memory`, kind: 'directory' as const, namespace: 'personal', source: 'broad' },
    { path: `${winRoot}\\memory\\special`, kind: 'directory' as const, namespace: 'projects', source: 'specific' },
  ];
  assert.equal(matchWatchSpec(`${winRoot}\\memory\\special\\x.md`, overlapping, path.win32)?.source, 'specific');
});

test('workspace config defaults only when absent and validates the root directory', () => {
  const seen: string[] = [];
  const directoryStat = (candidate: string) => {
    seen.push(candidate);
    return { isDirectory: () => true };
  };

  assert.equal(
    resolveWorkspaceRoot(undefined, directoryStat, path.posix),
    '/home/fuego/.openclaw/workspace',
  );
  assert.equal(
    resolveWorkspaceRoot('./workspace', directoryStat, path.win32, 'C:\\service'),
    'C:\\service\\workspace',
  );
  assert.throws(() => resolveWorkspaceRoot('  ', directoryStat, path.win32), /blank/i);
  assert.throws(
    () => resolveWorkspaceRoot('missing', () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, path.posix),
    /existing directory/i,
  );
  assert.throws(
    () => resolveWorkspaceRoot('/tmp/file', () => ({ isDirectory: () => false }), path.posix),
    /existing directory/i,
  );
  assert.throws(
    () => resolveWorkspaceRoot('/restricted', () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }, path.posix),
    (error: unknown) => error instanceof Error
      && (error as NodeJS.ErrnoException).code === 'EACCES'
      && /permission denied/.test(error.message),
  );
  assert.equal(seen.length, 2, 'only the selected workspace root is statted; optional targets are not');
});

test('environment files retain their specific exclusion reason before extension checks', () => {
  for (const implementation of [path.posix, path.win32]) {
    assert.deepEqual(exclusionReason('.env', implementation), { code: 'environment-file' });
    assert.deepEqual(exclusionReason('.env.local', implementation), { code: 'environment-file' });
  }
});

test('deliverables exclusion uses exact case-insensitive directory segments', () => {
  for (const implementation of [path.posix, path.win32]) {
    const sep = implementation.sep;
    for (const value of [`notes${sep}deliverables${sep}x.md`, `notes${sep}DELIVERABLES${sep}x.md`]) {
      assert.deepEqual(exclusionReason(value, implementation), { code: 'deliverables-directory' });
    }
    for (const value of [`notes${sep}my-deliverables${sep}x.md`, `notes${sep}DELIVERABLE-notes.md`]) {
      assert.equal(exclusionReason(value, implementation), null);
    }
  }
});
