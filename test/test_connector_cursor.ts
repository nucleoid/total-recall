import assert from 'node:assert/strict';

import { selectNewestCursorDate } from '../src/connectors/base.ts';
import type { MediaEventInput } from '../src/media.ts';

const exact: MediaEventInput = {
  service: 'ytmusic',
  service_id: 'exact',
  event_type: 'play',
  title: 'Exact',
  played_at: '2026-03-01T09:00:00.000Z',
  metadata: { played_cursor_eligible: true },
};

const coarseFuture: MediaEventInput = {
  service: 'ytmusic',
  service_id: 'coarse',
  event_type: 'play',
  title: 'Coarse',
  played_at: '2026-03-15T12:00:00.000Z',
  metadata: {
    played_precision: 'month',
    played_bucket: 'this month',
    played_cursor_eligible: false,
  },
};

assert.equal(
  selectNewestCursorDate([coarseFuture, exact])?.toISOString(),
  '2026-03-01T09:00:00.000Z'
);

assert.equal(selectNewestCursorDate([coarseFuture]), null);
