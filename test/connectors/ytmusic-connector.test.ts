import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { YtmusicConnector, type YtmusicHelperRunner } from '../../src/connectors/ytmusic/connector.js';
import { toMediaEvent } from '../../src/connectors/ytmusic/transform.js';
import { setMediaQueryForTests } from '../../src/media.js';

function installConnectorDb(options: {
  lastEventAt?: string;
  existingVideoIds?: string[];
} = {}) {
  const inserted: Array<{ service_id: string | null; played_at: string }> = [];
  const queries: string[] = [];

  setMediaQueryForTests(async (text, params = []) => {
    queries.push(text);

    if (text.includes('SELECT data FROM connector_credentials')) {
      return { rows: [{ data: { _auth_type: 'browser', headers: { cookie: 'ok' } } }] } as any;
    }

    if (text.includes('SELECT * FROM connector_sync_state')) {
      return {
        rows: options.lastEventAt
          ? [{ service: 'ytmusic', last_event_at: new Date(options.lastEventAt), cursor: null }]
          : [],
      } as any;
    }

    if (text.includes('INSERT INTO connector_sync_state')) {
      return { rows: [] } as any;
    }

    if (text.includes('INSERT INTO connector_credentials')) {
      return { rows: [] } as any;
    }

    if (text.includes('SELECT DISTINCT service_id FROM media_events')) {
      return {
        rows: (options.existingVideoIds ?? []).map((service_id) => ({ service_id })),
      } as any;
    }

    if (text.includes('INSERT INTO media_events')) {
      inserted.push({
        service_id: (params[1] as string | null) ?? null,
        played_at: new Date(params[14] as string).toISOString(),
      });
      return { rows: [{ id: `event-${inserted.length}`, inserted: true }] } as any;
    }

    throw new Error(`unexpected query: ${text}`);
  });

  return { inserted, queries };
}

afterEach(() => {
  setMediaQueryForTests(null);
});

describe('YtmusicConnector', () => {
  it('does not suppress a later legitimate play only because the videoId exists', async () => {
    const db = installConnectorDb({ existingVideoIds: ['repeat-video'] });
    const runner: YtmusicHelperRunner = async () => ({
      stdout: JSON.stringify({
        items: [
          {
            videoId: 'repeat-video',
            title: 'Repeat Track',
            played: '2026-07-02T10:00:00.000Z',
            played_raw: '2026-07-02T10:00:00.000Z',
            played_precision: 'exact',
            played_bucket: 'exact',
          },
        ],
      }),
      stderr: '',
      code: 0,
    });

    const result = await new YtmusicConnector({ runHelper: runner }).sync();

    assert.equal(result.events_ingested, 1);
    assert.equal(db.inserted[0].service_id, 'repeat-video');
    assert.equal(
      db.queries.some((query) => query.includes('SELECT DISTINCT service_id FROM media_events')),
      false
    );
  });

  it('passes --since while still allowing coarse fuzzy buckets to be refetched', async () => {
    installConnectorDb({ lastEventAt: '2026-07-01T12:00:00.000Z' });
    let fetchArgs: string[] = [];
    const runner: YtmusicHelperRunner = async (args) => {
      fetchArgs = args;
      return {
        stdout: JSON.stringify({
          items: [
            {
              videoId: 'same-bucket-new-track',
              title: 'New Track',
              played: '2026-07-01T12:00:00.000Z',
              played_raw: 'Today',
              played_precision: 'day',
              played_bucket: 'day:2026-07-01',
            },
          ],
        }),
        stderr: '',
        code: 0,
      };
    };

    const result = await new YtmusicConnector({ runHelper: runner }).sync();

    assert.equal(result.events_ingested, 1);
    assert.equal(fetchArgs.includes('--since'), true);
  });
});

describe('YouTube Music transform', () => {
  it('keeps raw played label plus precision and bucket metadata', () => {
    const event = toMediaEvent({
      videoId: 'bucket-video',
      title: 'Bucket Track',
      played: '2026-07-01T12:00:00.000Z',
      played_raw: 'Today',
      played_precision: 'day',
      played_bucket: 'day:2026-07-01',
      played_bucket_start: '2026-07-01T00:00:00.000Z',
      played_bucket_end: '2026-07-02T00:00:00.000Z',
    });

    assert.equal(event?.metadata.played_raw, 'Today');
    assert.equal(event?.metadata.played_precision, 'day');
    assert.equal(event?.metadata.played_bucket, 'day:2026-07-01');
    assert.equal(event?.metadata.played_bucket_start, '2026-07-01T00:00:00.000Z');
    assert.equal(event?.metadata.played_bucket_end, '2026-07-02T00:00:00.000Z');
  });
});
