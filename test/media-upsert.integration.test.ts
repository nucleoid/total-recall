import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  previewMediaEventUpsertsWithQuery,
  upsertMediaEventsOnClient,
  type TrustedMediaEventInput,
} from '../src/media.js';
import type { DbScope } from '../src/db.js';

const scope: DbScope = { keyId: 'key-1', namespaces: ['media'] };

interface StoredEvent {
  id: string;
  service: string;
  service_id: string | null;
  played_at: string;
  metadata: Record<string, unknown>;
}

function installFakeMediaClient(seed: StoredEvent[] = []) {
  const rows = [...seed];
  let nextId = seed.length + 1;
  const inserts: StoredEvent[] = [];

  const client = {
    async query(text: string, params: unknown[] = []) {
      if (text.includes('service_id = ANY')) {
        const service = params[1] as string;
        const serviceIds = params[2] as string[];
        return {
          rows: rows
            .filter(
              (row) =>
                row.service === service &&
                row.service_id !== null &&
                serviceIds.includes(row.service_id)
            )
            .map((row) => ({ ...row })),
        };
      }

      if (text.includes('SELECT id FROM media_events')) {
        const service = params[1] as string;
        const sourceId = params[2] as string;
        const serviceId = params[3] as string;
        const bucketStart = new Date(params[4] as string).getTime();
        const bucketEnd = new Date(params[5] as string).getTime();
        return {
          rows: rows
            .filter((row) => {
              const playedAt = new Date(row.played_at).getTime();
              return (
                row.service === service &&
                sourceId === 'default' &&
                row.service_id === serviceId &&
                !('played_raw' in row.metadata) &&
                !('played_bucket' in row.metadata) &&
                playedAt >= bucketStart &&
                playedAt < bucketEnd
              );
            })
            .slice(0, 1)
            .map((row) => ({ id: row.id })),
        };
      }

      if (!text.includes('INSERT INTO media_events')) {
        throw new Error(`unexpected query: ${text}`);
      }

      const service = params[0] as string;
      const serviceId = (params[3] as string | null) ?? null;
      const playedAt = new Date(params[16] as string).toISOString();
      const existing = rows.find(
        (row) =>
          row.service === service &&
          row.service_id === serviceId &&
          row.played_at === playedAt
      );
      if (existing) return { rows: [] };

      const row = {
        id: `event-${nextId++}`,
        service,
        service_id: serviceId,
        played_at: playedAt,
        metadata: JSON.parse(params[17] as string),
      };
      rows.push(row);
      inserts.push(row);
      return { rows: [{ id: row.id }] };
    },
  };

  return { client, rows, inserts };
}

function play(
  serviceId: string,
  playedAt: string,
  metadata: Record<string, unknown> = {}
): TrustedMediaEventInput {
  return {
    service: 'ytmusic',
    service_id: serviceId,
    event_type: 'play',
    title: `Track ${serviceId}`,
    played_at: playedAt,
    metadata,
    client_id: scope.keyId,
  };
}

describe('media event tuple upsert', () => {
  it('dedupes an identical tuple while retaining distinct absolute timestamps', async () => {
    const db = installFakeMediaClient();

    const result = await upsertMediaEventsOnClient(
      db.client as any,
      [
        play('video-1', '2026-07-01T10:00:00.000Z'),
        play('video-1', '2026-07-01T10:05:00.000Z'),
        play('video-1', '2026-07-01T10:05:00.000Z'),
      ],
      scope
    );

    assert.deepEqual(result, {
      inserted: 2,
      skipped: 1,
      ids: ['event-1', 'event-2'],
    });
    assert.equal(db.rows.length, 2);
  });

  it('keeps recurring moving-label plays but bounds no-metadata legacy dedupe to one absolute bucket', async () => {
    const db = installFakeMediaClient([
      {
        id: 'tagged-monday',
        service: 'ytmusic',
        service_id: 'recurring-video',
        played_at: '2026-07-01T12:00:00.000Z',
        metadata: { played_raw: 'Today', played_bucket: 'day:2026-07-01' },
      },
      {
        id: 'legacy-tuesday',
        service: 'ytmusic',
        service_id: 'legacy-video',
        played_at: '2026-07-02T18:34:00.000Z',
        metadata: {},
      },
    ]);

    const result = await upsertMediaEventsOnClient(
      db.client as any,
      [
        play('recurring-video', '2026-07-02T12:00:00.000Z', {
          played_raw: 'Today',
          played_precision: 'day',
          played_bucket: 'day:2026-07-02',
          played_bucket_start: '2026-07-02T00:00:00.000Z',
          played_bucket_end: '2026-07-03T00:00:00.000Z',
        }),
        play('legacy-video', '2026-07-02T12:00:00.000Z', {
          played_raw: 'Today',
          played_precision: 'day',
          played_bucket: 'day:2026-07-02',
          played_bucket_start: '2026-07-02T00:00:00.000Z',
          played_bucket_end: '2026-07-03T00:00:00.000Z',
        }),
      ],
      scope
    );

    assert.deepEqual(result, {
      inserted: 1,
      skipped: 1,
      ids: ['event-3'],
    });
    assert.equal(db.inserts[0].service_id, 'recurring-video');
  });

  it('previews only tuple conflicts and bounded no-metadata legacy duplicates', async () => {
    const db = installFakeMediaClient([
      {
        id: 'tagged-prior-day',
        service: 'ytmusic',
        service_id: 'recurring-video',
        played_at: '2026-07-01T12:00:00.000Z',
        metadata: { played_raw: 'Today', played_bucket: 'day:2026-07-01' },
      },
      {
        id: 'legacy-same-day',
        service: 'ytmusic',
        service_id: 'legacy-video',
        played_at: '2026-07-02T18:34:00.000Z',
        metadata: {},
      },
      {
        id: 'exact-tuple',
        service: 'ytmusic',
        service_id: 'tuple-video',
        played_at: '2026-07-02T12:00:00.000Z',
        metadata: {},
      },
    ]);
    const dayMetadata = {
      played_raw: 'Today',
      played_precision: 'day',
      played_bucket: 'day:2026-07-02',
      played_bucket_start: '2026-07-02T00:00:00.000Z',
      played_bucket_end: '2026-07-03T00:00:00.000Z',
    };

    const preview = await previewMediaEventUpsertsWithQuery(
      'ytmusic',
      [
        play('recurring-video', '2026-07-02T12:00:00.000Z', dayMetadata),
        play('legacy-video', '2026-07-02T12:00:00.000Z', dayMetadata),
        play('tuple-video', '2026-07-02T12:00:00.000Z', dayMetadata),
      ],
      scope,
      (text, params) => db.client.query(text, params) as any
    );

    assert.deepEqual(
      preview.items.map((item) => item.status),
      ['would_insert', 'possible_legacy_duplicate', 'tuple_conflict']
    );
    assert.deepEqual(preview.items[1].legacy_duplicate_event_ids, ['legacy-same-day']);
    assert.deepEqual(preview.items[2].conflicting_event_ids, ['exact-tuple']);
    assert.equal(db.inserts.length, 0);
  });

  it('persists raw label and precision/bucket metadata for auditability', async () => {
    const db = installFakeMediaClient();

    await upsertMediaEventsOnClient(
      db.client as any,
      [
        play('video-2', '2026-07-01T12:00:00.000Z', {
          played_raw: 'Today',
          played_precision: 'day',
          played_bucket: 'day:2026-07-01',
        }),
      ],
      scope
    );

    assert.deepEqual(db.inserts[0].metadata, {
      played_raw: 'Today',
      played_precision: 'day',
      played_bucket: 'day:2026-07-01',
    });
  });
});
