import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { isDirectExecution } from '../src/entrypoint.js';

test('entrypoint identity follows an atomic current-release symlink', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'total-recall-entrypoint-'));
  try {
    const release = path.join(root, 'releases', 'abc123', 'dist');
    await fs.mkdir(release, { recursive: true });
    const entry = path.join(release, 'server.js');
    await fs.writeFile(entry, '');
    await fs.symlink(path.join(root, 'releases', 'abc123'), path.join(root, 'current'));

    assert.equal(
      isDirectExecution(pathToFileURL(entry).href, path.join(root, 'current', 'dist', 'server.js')),
      true,
    );
    assert.equal(isDirectExecution(pathToFileURL(entry).href, path.join(root, 'missing.js')), false);
    assert.equal(isDirectExecution(pathToFileURL(entry).href, undefined), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
