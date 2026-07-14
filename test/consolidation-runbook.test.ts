import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseConsolidationCli } from '../scripts/consolidate-memories.js';
import { parseDeconsolidationCli } from '../scripts/deconsolidate-memories.js';

test('consolidation CLI modes and scope are explicit', () => {
  assert.deepEqual(parseConsolidationCli(['--namespace', 'work', '--access-level', 'normal', '--selection-only']), {
    namespace: 'work', mode: 'selection-only', anchorLimit: undefined, clusterLimit: undefined, previewOutput: undefined, cursor: undefined,
  });
  assert.throws(() => parseConsolidationCli(['--namespace', 'work', '--dry-run']), /preview-output/);
  assert.throws(() => parseConsolidationCli(['--namespace', 'work', '--selection-only', '--apply']), /mutually exclusive/);
  assert.throws(() => parseConsolidationCli(['--namespace', 'work', '--access-level', 'sensitive', '--selection-only']), /only/);
});

test('deconsolidation is manifest-based and preview is the default approval boundary', () => {
  assert.equal(parseDeconsolidationCli(['--namespace', 'work', '--manifest', 'approval.json', '--canonical-id', '00000000-0000-4000-8000-000000000001']).mode, 'preview');
  assert.throws(() => parseDeconsolidationCli(['--namespace', 'work', '--apply', '--manifest', 'approval.json']), /approve-policy-hash/);
});

test('no public route, MCP registration, or in-process schedule is added', async () => {
  const [register, server, openapi, pkg] = await Promise.all([
    readFile('src/tools/register.ts', 'utf8'), readFile('src/server.ts', 'utf8'),
    readFile('openapi.yaml', 'utf8'), readFile('package.json', 'utf8'),
  ]);
  assert.doesNotMatch(register, /consolidat/i);
  assert.doesNotMatch(server, /consolidat/i);
  assert.doesNotMatch(openapi, /operationId:.*consolidat|\/api\/consolidat/i);
  assert.match(pkg, /"consolidate":/);
  assert.doesNotMatch(pkg, /node-cron|agenda|bullmq/);
});

test('selection module uses the side-effect-free embedding descriptor', async () => {
  const consolidation = await readFile('src/consolidation.ts', 'utf8');
  assert.match(consolidation, /embedding-descriptor\.js/);
  assert.match(consolidation, /await import\('\.\/embedding\.js'\)/);
  assert.doesNotMatch(consolidation.split("await import('./embedding.js')")[0], /from '\.\/embedding\.js'/);
});
