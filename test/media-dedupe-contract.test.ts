import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('operator contract exposes preview-first duplicate repair without enabling automatic reconciliation', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string,string> };
  assert.equal(pkg.scripts['repair:media-event-duplicates'], 'tsx scripts/repair-media-event-duplicates.ts');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(readme, /repair:media-event-duplicates[^\n]+--max-groups/i);
  assert.match(readme, /verified restorable backup/i);
  assert.match(readme, /explicit approval manifest/i);
  assert.match(readme, /stop all media ingestion/i);
  assert.match(readme, /mixed versions/i);
  assert.match(readme, /pgcrypto/i);
  assert.match(readme, /migration 022/i);
  assert.match(readme, /unverified groups[^.]+unchanged[^.]+block/i);
  assert.match(readme, /--group-key[^\n]+--target-max-events-per-group/i);
  assert.match(readme, /roll-forward-only/i);
  assert.match(readme, /emergency binary rollback to #8/i);
  assert.match(readme, /drop `media_events_effective_identity_uidx`[^.]+only then deploy and start the #8 binary/i);
  assert.match(readme, /do not drop[^.]+`media_events_client_service_identity_key`/i);
  assert.doesNotMatch(readme, /CREATE UNIQUE INDEX[^;]+\(service, service_id, played_at\)/i);
  assert.doesNotMatch(pkg.scripts['migrate'], /repair-media-event-duplicates/);
});
