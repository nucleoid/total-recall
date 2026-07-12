import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterValidMediaEventDates,
  resolveLastEventAt,
  validateMediaEventDates,
} from '../../src/connectors/base.js';
import type { MediaEventInput } from '../../src/media.js';

function event(overrides: Partial<MediaEventInput>): MediaEventInput {
  return {
    service: 'test',
    service_id: 'id',
    event_type: 'play',
    title: 'Title',
    played_at: '2026-03-01T09:00:00.000Z',
    ...overrides,
  };
}

test('connector fetch result can preserve the existing last_event_at cursor', () => {
  const since = new Date('2026-03-01T00:00:00.000Z');
  const newerSameBucket = event({
    service_id: 'same-bucket-later',
    played_at: '2026-03-01T12:00:00.000Z',
    metadata: {
      played_raw: 'Today',
      played_precision: 'day',
      played_cursor_eligible: false,
    },
  });

  assert.equal(
    resolveLastEventAt([newerSameBucket], since, false)?.toISOString(),
    '2026-03-01T00:00:00.000Z'
  );
});

test('invalid event timestamps are rejected before cursor state is calculated', () => {
  assert.throws(
    () => validateMediaEventDates([event({ played_at: 'not-a-date' })]),
    /Invalid played_at/
  );

  assert.throws(
    () => resolveLastEventAt([event({ played_at: 'not-a-date' })], null, true),
    /Invalid played_at/
  );

  assert.throws(
    () => resolveLastEventAt([event({ played_at: 'not-a-date' })], null, false),
    /Invalid played_at/
  );
});

test('invalid event timestamps can be filtered without aborting a valid batch', () => {
  const valid = event({ service_id: 'valid' });
  const invalid = event({ service_id: 'invalid', played_at: 'not-a-date' });
  const result = filterValidMediaEventDates([valid, invalid]);

  assert.deepEqual(result.events, [valid]);
  assert.equal(result.skipped, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Invalid played_at for test invalid/);
});

test('default connector state advancement remains newest valid event timestamp', () => {
  const since = new Date('2026-03-01T00:00:00.000Z');

  assert.equal(
    resolveLastEventAt(
      [
        event({ service_id: 'old', played_at: '2026-03-01T01:00:00.000Z' }),
        event({ service_id: 'new', played_at: '2026-03-01T03:00:00.000Z' }),
      ],
      since,
      true
    )?.toISOString(),
    '2026-03-01T03:00:00.000Z'
  );
});
