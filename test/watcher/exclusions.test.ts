import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chunkMarkdown } from '../../src/watcher/chunking.js';
import {
  exclusionReason,
  fileSizeExclusionReason,
  formatExclusionLog,
} from '../../src/watcher/paths.js';

const watcherSource = await fs.readFile(new URL('../../src/watcher.ts', import.meta.url), 'utf8');
const readme = await fs.readFile(new URL('../../README.md', import.meta.url), 'utf8');

test('DELIVERABLE body text is never an exclusion signal', () => {
  assert.doesNotMatch(watcherSource, /content\.includes\(['"]DELIVERABLE['"]\)/);

  const fixtures = [
    'Ordinary prose names a DELIVERABLE and remains syncable.',
    '---\ntags: [DELIVERABLE]\n---\nFrontmatter value does not suppress this body.',
    '## DELIVERABLE\nHeading body remains syncable.',
    '```text\nDELIVERABLE client text\n```',
  ];
  for (const [index, content] of fixtures.entries()) {
    const chunks = chunkMarkdown(content, 'test-source', `notes/fixture-${index}.md`);
    assert.ok(chunks.length > 0, `fixture ${index} should produce a chunk`);
    if (index === 1) {
      assert.ok(chunks.some(chunk => chunk.tags.includes('DELIVERABLE')));
    } else {
      assert.ok(chunks.some(chunk => chunk.content.includes('DELIVERABLE')));
    }
  }
});

test('all policy exclusions have stable codes and safe canonical-path logs', () => {
  for (const implementation of [path.posix, path.win32]) {
    const sep = implementation.sep;
    assert.deepEqual(exclusionReason(`notes${sep}plain.txt`, implementation), { code: 'not-markdown' });
    assert.deepEqual(exclusionReason(`notes${sep}.env.secret`, implementation), { code: 'environment-file' });
    assert.deepEqual(exclusionReason(`notes${sep}DELIVERABLES${sep}plan.md`, implementation), { code: 'deliverables-directory' });
    assert.equal(exclusionReason(`notes${sep}my-deliverables${sep}DELIVERABLE-notes.md`, implementation), null);
  }
  assert.deepEqual(fileSizeExclusionReason(1_000_001), { code: 'file-too-large' });
  assert.equal(fileSizeExclusionReason(1_000_000), null);

  const body = 'private DELIVERABLE client text';
  const absolute = 'C:/secret/workspace/memory/day.md';
  const log = formatExclusionLog('memory/day.md', { code: 'file-too-large' });
  assert.equal(log, '[watcher] Skipped memory/day.md: file-too-large');
  assert.doesNotMatch(log, new RegExp(body));
  assert.doesNotMatch(log, new RegExp(absolute.replaceAll('/', '\\/')));
});

test('watcher documentation defines every exclusion without a body marker', () => {
  assert.match(readme, /non-`\.md`/);
  assert.match(readme, /`\.env\*`/);
  assert.match(readme, /exact.*`deliverables`.*directory segment/i);
  assert.match(readme, /larger than 1,000,000 bytes/);
  assert.match(readme, /body text.*not.*exclusion signal/i);
});
