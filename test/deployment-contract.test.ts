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
