import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('media event identity migration', () => {
  it('follows the current migration ledger and compares catalog column names as text arrays', () => {
    const migration = readFileSync('migrations/021_tenant_media_event_identity.sql', 'utf8');

    assert.match(migration, /array_agg\(a\.attname::text ORDER BY u\.ord\)/);
    assert.match(migration, /UNIQUE \(client_id, service, service_id, played_at\)/);
  });
});
