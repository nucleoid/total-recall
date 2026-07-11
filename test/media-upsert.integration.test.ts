import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  previewMediaEventUpserts,
  setMediaQueryForTests,
  upsertMediaEvents,
  type MediaEventInput,
} from '../src/media.js';

interface StoredEvent {
  id: string;
  service: string;
  service_id: string | null;
  played_at: string;
  metadata: Record<string, unknown>;
}

function installFakeMediaDb(seed: StoredEvent[] = []) {
  const rows = [...seed];
  let nextId = seed.length + 1;
  const inserts: StoredEvent[] = [];

  setMediaQueryForTests(async (text, params = []) => {
    if (text.includes('INSERT INTO media_events')) {
      const service = params[0] as string;
      const service_id = (params[1] as string | null) ?? null;
      const played_at = new Date(params[14] as string).toISOString();
      const existing = rows.find(
        (row) =>
          row.service === service &&
          row.service_id === service_id &&
          row.played_at === played_at
      );
      if (existing && service_id !== null) {
        return { rows: [] } as any;
      }
      const row = {
        id: `event-${nextId++}`,
        service,
        service_id,
        played_at,
        metadata: JSON.parse(params[15] as string),
      };
      rows.push(row);
      inserts.push(row);
      return { rows: [{ id: row.id, inserted: true }] } as any;
    }

    if (text.includes('FROM media_events') && text.includes('service_id = ANY')) {
      const service = params[0] as string;
      const ids = params[1] as string[];
      return {
        rows: rows
          .filter((row) => row.service === service && row.service_id && ids.includes(row.service_id))
          .map((row) => ({
            id: row.id,
            service_id: row.service_id,
            played_at: row.played_at,
          })),
      } as any;
    }

    throw new Error(`unexpected query: ${text}`);
  });

  return { rows, inserts };
}

function play(
  service_id: string,
  played_at: string,
  metadata: Record<string, unknown> = {}
): MediaEventInput {
  return {
    service: 'ytmusic',
    service_id,
    event_type: 'play',
    title: `Track ${service_id}`,
    played_at,
    metadata,
  };
}

afterEach(() => {
  setMediaQueryForTests(null);
});

describe('media event tuple upsert', () => {
  it('dedupes only the service/service_id/played_at tuple, including duplicates in one batch', async () => {
    const db = installFakeMediaDb();

    const result = await upsertMediaEvents([
      play('video-1', '2026-07-01T10:00:00.000Z'),
      play('video-1', '2026-07-01T10:05:00.000Z'),
      play('video-1', '2026-07-01T10:05:00.000Z'),
    ]);

    assert.deepEqual(result, {
      inserted: 2,
      skipped: 1,
      ids: ['event-1', 'event-2'],
    });
    assert.equal(db.rows.length, 2);
  });

  it('persists raw label and precision/bucket metadata for auditability', async () => {
    const db = installFakeMediaDb();

    await upsertMediaEvents([
      play('video-2', '2026-07-01T12:00:00.000Z', {
        played_raw: 'Today',
        played_precision: 'day',
        played_bucket: 'day:2026-07-01',
      }),
    ]);

    assert.deepEqual(db.inserts[0].metadata, {
      played_raw: 'Today',
      played_precision: 'day',
      played_bucket: 'day:2026-07-01',
    });
  });

  it('previews recovery conflicts and possible legacy duplicates without writing', async () => {
    const db = installFakeMediaDb([
      {
        id: 'old-1',
        service: 'ytmusic',
        service_id: 'video-3',
        played_at: '2026-07-01T12:00:00.000Z',
        metadata: {},
      },
    ]);

    const preview = await previewMediaEventUpserts('ytmusic', [
      play('video-3', '2026-07-01T12:00:00.000Z', { played_raw: 'Today' }),
      play('video-3', '2026-07-08T12:00:00.000Z', { played_raw: 'This week' }),
    ]);

    assert.deepEqual(
      preview.items.map((item) => item.status),
      ['tuple_conflict', 'possible_legacy_duplicate']
    );
    assert.equal(db.inserts.length, 0);
  });
});
