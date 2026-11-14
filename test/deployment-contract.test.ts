import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('mcporter uses the canonical HTTP service instead of a checkout stdio build', async () => {
  const config = JSON.parse(await fs.readFile(
    path.join(root, 'deploy', 'mcporter.local-http.example.json'),
    'utf8',
  ));
  const server = config.mcpServers?.['total-recall'];

  assert.equal(server?.baseUrl, 'http://127.0.0.1:3003/mcp');
  assert.equal(server?.command, undefined);
  assert.equal(server?.args, undefined);
  assert.doesNotMatch(JSON.stringify(server), /dist\/index\.js/);
  assert.match(server?.headers?.Authorization ?? '', /TOTAL_RECALL_API_KEY/);
});

test('HTTP service and watcher resolve through one atomic current release', async () => {
  const service = await fs.readFile(
    path.join(root, 'deploy', 'systemd', 'total-recall.service'),
    'utf8',
  );
  const watcher = await fs.readFile(
    path.join(root, 'deploy', 'systemd', 'total-recall-watcher.service'),
    'utf8',
  );

  assert.match(service, /current\/dist\/server\.js/);
  assert.match(watcher, /current\/dist\/watcher\.js/);
  assert.doesNotMatch(`${service}\n${watcher}`, /\.codex-|projects\/total-recall\/dist/);
});

test('daily sync pins one config and bounds mcporter stats calls', async () => {
  const script = await fs.readFile(path.join(root, 'scripts', 'daily-sync.sh'), 'utf8');
  assert.match(script, /--config "\$MCPORTER_CONFIG" call total-recall\.memory_stats/);
  assert.match(script, /timeout --signal=TERM/);
  assert.doesNotMatch(script, /"\$MCPORTER_BIN" call total-recall\.memory_stats/);
});

test('durable ingestion worker has a dedicated unit and bounded npm entrypoint', async () => {
  const service = await fs.readFile(path.join(root,'deploy/systemd/total-recall-ingestion.service'),'utf8');
  const manifest = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  assert.match(service,/current\/dist\/ingestion-worker\.js --concurrency 4/);
  assert.match(service,/EnvironmentFile=/);
  assert.ok(Number(service.match(/TimeoutStopSec=(\d+)/)?.[1]) >= 210, 'shutdown must cover the maximum provider/classifier lease budget');
  assert.equal(manifest.scripts['ingest:worker'],'tsx scripts/ingestion-worker.ts');
});


test('release ingestion worker imports under native Node without a TypeScript loader', () => {
  const result=spawnSync(process.execPath,['--input-type=module','--eval',"await import('./dist/ingestion-worker.js')"],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
