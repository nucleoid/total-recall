import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_MEDIA_EVENT_BATCH,
  parsePublicMediaEventBatch,
  toTrustedRestMediaEvents,
  upsertMediaEventsOnClient,
  type TrustedMediaEventInput,
} from '../src/media.ts';
import { trustConnectorMediaEvents } from '../src/connectors/base.ts';

const baseEvent = {
  service: 'spotify',
  service_id: 'track:1',
  event_type: 'play',
  title: 'Song',
  played_at: '2026-07-11T01:02:03Z',
};

describe('public REST media event auth and validation', () => {
  it('ignores client-supplied ownership and persists REST attribution from auth', () => {
    const parsed = parsePublicMediaEventBatch({
      events: [
        {
          ...baseEvent,
          client_id: 'not-a-uuid',
          agent_id: '9bb9dc8c-3d51-498e-bd80-395f27672424',
        },
        {
          ...baseEvent,
          service_id: 'track:2',
          client_id: null,
          agent_id: null,
        },
      ],
    });

    assert.equal('client_id' in parsed[0], false);
    assert.equal('agent_id' in parsed[0], false);

    const trusted = toTrustedRestMediaEvents(parsed, {
      keyId: 'd0633ea7-ec17-41fc-ac4c-9280bed6911e',
      name: 'rest-key',
      namespaces: ['media'],
      permissions: ['write'],
    });

    assert.deepEqual(
      trusted.map((event) => ({ client_id: event.client_id, agent_id: event.agent_id })),
      [
        { client_id: 'd0633ea7-ec17-41fc-ac4c-9280bed6911e', agent_id: null },
        { client_id: 'd0633ea7-ec17-41fc-ac4c-9280bed6911e', agent_id: null },
      ]
    );
  });

  it('rejects malformed events before SQL', () => {
    const invalidBodies = [
      { events: [{ ...baseEvent, played_at: 'not-a-date' }] },
      { events: [{ ...baseEvent, duration_ms: Number.POSITIVE_INFINITY }] },
      { events: [{ ...baseEvent, played_ms: 2147483648 }] },
      { events: [{ ...baseEvent, metadata: [] }] },
      { events: Array.from({ length: MAX_MEDIA_EVENT_BATCH + 1 }, () => baseEvent) },
    ];

    for (const body of invalidBodies) {
      assert.throws(() => parsePublicMediaEventBatch(body), { name: 'ZodError' });
    }
  });

  it('coerces empty optional text fields to absent values for compatibility', () => {
    const [parsed] = parsePublicMediaEventBatch({
      events: [{
        ...baseEvent,
        service_id: '',
        artist: '   ',
        album: '\t',
        show: '',
      }],
    });

    assert.equal(parsed.service_id, undefined);
    assert.equal(parsed.artist, undefined);
    assert.equal(parsed.album, undefined);
    assert.equal(parsed.show, undefined);
    assert.throws(
      () => parsePublicMediaEventBatch({ events: [{ ...baseEvent, title: '   ' }] }),
      { name: 'ZodError' }
    );
  });

  it('rejects calendar-invalid timestamps at the played_at field before SQL', () => {
    for (const playedAt of [
      '2026-02-29T01:02:03Z',
      '2026-02-30T01:02:03Z',
      '2026-04-31 01:02:03+00',
      '0000-01-01T00:00:00Z',
    ]) {
      assert.throws(
        () => parsePublicMediaEventBatch({ events: [{ ...baseEvent, played_at: playedAt }] }),
        (error: any) => {
          assert.equal(error.name, 'ZodError');
          assert.deepEqual(error.issues[0]?.path, ['events', 0, 'played_at']);
          return true;
        }
      );
    }

    assert.equal(
      parsePublicMediaEventBatch({
        events: [{ ...baseEvent, played_at: '2028-02-29T01:02:03Z' }],
      })[0].played_at,
      '2028-02-29T01:02:03Z'
    );
  });

  it('accepts PostgreSQL timestamp forms and defaults naive values to UTC', () => {
    const parsed = parsePublicMediaEventBatch({
      events: [
        { ...baseEvent, played_at: '2026-07-11 01:02:03+00' },
        { ...baseEvent, service_id: 'track:2', played_at: '2026-07-11T01:02:03+0000' },
        { ...baseEvent, service_id: 'track:3', played_at: '2026-07-11 01:02:03' },
      ],
    });

    assert.deepEqual(
      parsed.map((event) => event.played_at),
      ['2026-07-11 01:02:03+00', '2026-07-11T01:02:03+0000', '2026-07-11T01:02:03Z']
    );
  });
});

describe('trusted media persistence', () => {
  it('uses tenant-local deduplication', async () => {
    const inserts: string[] = [];
    const client = new FakeClient([
      { rows: [{ id: 'event-a' }] },
      { rows: [] },
      { rows: [{ id: 'event-b' }] },
    ]);
    const events: TrustedMediaEventInput[] = [
      trustedEvent('key-a'),
      trustedEvent('key-a'),
      trustedEvent('key-b'),
    ];

    client.onInsert = (sql) => inserts.push(sql);
    const keyAResult = await upsertMediaEventsOnClient(client as any, events.slice(0, 2), scope('key-a'));
    const keyBResult = await upsertMediaEventsOnClient(client as any, events.slice(2), scope('key-b'));

    assert.equal(keyAResult.inserted + keyBResult.inserted, 2);
    assert.equal(keyAResult.skipped + keyBResult.skipped, 1);
    assert.deepEqual([...keyAResult.ids, ...keyBResult.ids], ['event-a', 'event-b']);
    assert.match(inserts[0], /ON CONFLICT \(client_id, service, service_id, played_at\) DO NOTHING/);
  });

  it('propagates a later-row failure to the scoped transaction', async () => {
    const client = new FakeClient([{ rows: [{ id: 'event-a' }] }], new Error('db rejected row'));

    await assert.rejects(
      () => upsertMediaEventsOnClient(
        client as any,
        [trustedEvent('key-a'), trustedEvent('key-a', 'bad')],
        scope('key-a')
      ),
      /db rejected row/
    );

    assert.deepEqual(client.commands, ['INSERT', 'INSERT']);
  });
});

describe('connector attribution', () => {
  it('overrides transform-supplied ownership with resolved server attribution', () => {
    const trusted = trustConnectorMediaEvents(
      [
        {
          ...baseEvent,
          client_id: 'spoofed-client',
          agent_id: 'spoofed-agent',
        },
      ],
      { apiKeyId: 'server-key', agentId: 'server-agent' }
    );

    assert.equal(trusted[0].client_id, 'server-key');
    assert.equal(trusted[0].agent_id, 'server-agent');
  });
});

function scope(keyId: string, isAdmin = false) {
  return { keyId, namespaces: ['media'], isAdmin };
}

function trustedEvent(clientId: string, serviceId = 'track:1'): TrustedMediaEventInput {
  return {
    ...baseEvent,
    service_id: serviceId,
    client_id: clientId,
    agent_id: null,
  };
}

class FakeClient {
  commands: string[] = [];
  onInsert?: (sql: string) => void;
  private insertCount = 0;

  constructor(
    private readonly insertResults: Array<{ rows: Array<{ id: string }> }>,
    private readonly failOnSecondInsert?: Error
  ) {}

  async query(sql: string): Promise<{ rows: Array<{ id: string }> }> {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      this.commands.push(sql);
      return { rows: [] };
    }

    this.commands.push('INSERT');
    this.onInsert?.(sql);
    this.insertCount += 1;
    if (this.failOnSecondInsert && this.insertCount === 2) {
      throw this.failOnSecondInsert;
    }
    return this.insertResults[this.insertCount - 1] ?? { rows: [] };
  }
}
