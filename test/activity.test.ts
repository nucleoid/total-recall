import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parsePublicActivityEventBatch,
  toTrustedActivityEvents,
  upsertActivityEventsWithClient,
} from '../src/activity.js';

const input = {
  connector: 'browser',
  source_id: 'firefox:v1:abc',
  event_key: 'visit:42',
  event_type: 'page_visit',
  title: 'Example',
  occurred_at: '2026-07-16T12:00:00.000Z',
  namespace: 'activity',
};

test('public activity parsing strips ownership and enforces event identity', () => {
  const [event] = parsePublicActivityEventBatch({
    events: [{ ...input, client_id: 'spoofed', agent_id: 'spoofed' }],
  });
  assert.equal('client_id' in event, false);
  assert.equal('agent_id' in event, false);
  assert.throws(
    () => parsePublicActivityEventBatch({ events: [{ ...input, event_key: '' }] }),
    { name: 'ZodError' },
  );
});

test('activity attribution requires namespace authorization and overrides ownership', () => {
  assert.throws(
    () => toTrustedActivityEvents([input], { keyId: 'key', namespaces: ['media'] }),
    /not accessible/,
  );
  const [trusted] = toTrustedActivityEvents(
    [{ ...input, client_id: 'spoofed' } as any],
    { keyId: 'key', namespaces: ['activity'] },
    'agent',
  );
  assert.equal(trusted.client_id, 'key');
  assert.equal(trusted.agent_id, 'agent');
});

test('activity upsert uses owner/source/event identity and reports replay skips', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let call = 0;
  const client = {
    async query(sql: string, params: unknown[]) {
      queries.push({ sql, params });
      call++;
      return call === 1 ? { rows: [{ id: 'event-id' }] } : { rows: [] };
    },
  };
  const trusted = toTrustedActivityEvents([input, input], { keyId: 'key', namespaces: ['activity'] });
  const result = await upsertActivityEventsWithClient(
    client as any,
    trusted,
    { keyId: 'key', namespaces: ['activity'] },
  );
  assert.deepEqual(result, { inserted: 1, skipped: 1, ids: ['event-id'] });
  assert.match(queries[0].sql, /ON CONFLICT \(client_id, connector, source_id, event_key\)/);
  assert.equal(queries[0].params[11], 'key');
});
