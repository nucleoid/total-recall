import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaEvent } from '../src/media.js';
import {
  buildSummary,
  buildTags,
  classifyMediaKind,
  createMediaDateFormatter,
  formatMediaDate,
  resolveMediaTimeZone,
  type MediaKind,
} from '../src/rollup.js';

function event(overrides: Partial<MediaEvent> = {}): MediaEvent {
  return {
    id: 'event-1', service: 'other', service_id: null, event_type: 'watch', title: 'Untitled',
    artist: null, album: null, show: null, season: null, episode: null, year: null,
    genres: [], duration_ms: null, played_ms: null, completed: null,
    played_at: new Date('2026-07-01T00:00:00Z'), metadata: {}, client_id: null,
    agent_id: null, memory_id: null, created_at: new Date('2026-07-01T00:00:01Z'),
    ...overrides,
  };
}

const cases: Array<[string, Partial<MediaEvent>, MediaKind]> = [
  ['artist-less Spotify play', { service: 'SpOtIfY', event_type: 'PLAY' }, 'music'],
  ['artist-less YouTube Music play', { service: 'YTMUSIC', event_type: 'play' }, 'music'],
  ['Plex track', { service: 'PLEX', metadata: { plex_type: 'Track' } }, 'music'],
  ['Plex episode', { service: 'plex', metadata: { plex_type: 'EPISODE' } }, 'tv'],
  ['Plex movie', { service: 'plex', metadata: { plex_type: 'movie' }, artist: 'conflict', show: 'conflict' }, 'movie'],
  ['canonical artist', { artist: 'An Artist' }, 'music'],
  ['canonical show', { show: 'A Show' }, 'tv'],
  ['canonical season including zero', { season: 0 }, 'tv'],
  ['canonical episode including zero', { episode: 0 }, 'tv'],
  ['unknown service play', { event_type: 'play' }, 'unknown'],
  ['generic watch', { event_type: 'watch' }, 'unknown'],
  ['generic complete', { event_type: 'complete' }, 'unknown'],
  ['non-Plex metadata is untrusted', { service: 'other', metadata: { plex_type: 'movie' } }, 'unknown'],
  ['malformed metadata', { service: 'plex', metadata: null as unknown as Record<string, unknown> }, 'unknown'],
  ['malformed Plex type falls through to canonical evidence', { service: 'plex', metadata: { plex_type: 42 }, show: 'A Show' }, 'tv'],
];

for (const [name, overrides, expected] of cases) {
  test(`classifies ${name} as ${expected}`, () => {
    assert.equal(classifyMediaKind(event(overrides)), expected);
  });
}

test('buildTags emits exactly one closed media kind and preserves original service/event tags', () => {
  for (const [, overrides] of cases) {
    const input = event(overrides);
    const tags = buildTags(input);
    assert.ok(tags.includes('media'));
    assert.ok(tags.includes(input.service));
    assert.ok(tags.includes(input.event_type));
    assert.equal(tags.filter((tag) => ['music', 'tv', 'movie', 'unknown'].includes(tag)).length, 1);
  }
});

test('buildTags keeps completion and normalized genres without contradictory kind genres', () => {
  assert.deepEqual(
    buildTags(event({
      service: 'plex', metadata: { plex_type: 'episode' }, completed: true,
      genres: ['Drama', 'MOVIE', 'TV', ' drama '],
    })),
    ['media', 'plex', 'watch', 'tv', 'completed', 'drama'],
  );
});

test('buildTags tolerates malformed genres', () => {
  assert.doesNotThrow(() => buildTags(event({ genres: [null, 42, 'Rock'] as unknown as string[] })));
  assert.deepEqual(buildTags(event({ genres: [null, 42, 'Rock'] as unknown as string[] })), ['media', 'other', 'watch', 'unknown', 'rock']);
});

function timezoneEvent(overrides: Partial<MediaEvent> = {}): MediaEvent {
  return {
    id: 'event-1', service: 'plex', service_id: 'item-1', event_type: 'watch',
    title: 'Arrival', artist: null, album: null, show: null, season: null,
    episode: null, year: 2016, genres: [], duration_ms: null, played_ms: null,
    completed: true, played_at: new Date('2026-01-02T02:00:00Z'), metadata: {},
    client_id: 'client-1', agent_id: null, memory_id: null,
    created_at: new Date('2026-01-02T02:01:00Z'), ...overrides,
  };
}

test('formats the same instant on the configured IANA calendar day', () => {
  assert.equal(formatMediaDate(timezoneEvent().played_at, createMediaDateFormatter('America/Chicago')), '2026-01-01');
  assert.equal(formatMediaDate(timezoneEvent().played_at, createMediaDateFormatter('UTC')), '2026-01-02');
});

test('handles DST boundaries, positive rollovers, non-hour offsets, and ASCII output', () => {
  const chicago = createMediaDateFormatter('America/Chicago');
  assert.equal(formatMediaDate(new Date('2026-03-08T07:59:59Z'), chicago), '2026-03-08');
  assert.equal(formatMediaDate(new Date('2026-03-08T08:00:00Z'), chicago), '2026-03-08');
  assert.equal(formatMediaDate(new Date('2026-11-01T06:59:59Z'), chicago), '2026-11-01');
  assert.equal(formatMediaDate(new Date('2026-11-01T07:00:00Z'), chicago), '2026-11-01');
  assert.equal(formatMediaDate(new Date('2026-01-01T23:30:00Z'), createMediaDateFormatter('Pacific/Kiritimati')), '2026-01-02');
  const kathmandu = formatMediaDate(new Date('2026-01-01T18:30:00Z'), createMediaDateFormatter('Asia/Kathmandu'));
  assert.equal(kathmandu, '2026-01-02');
  assert.match(kathmandu, /^\d{4}-\d{2}-\d{2}$/);
});

test('music, episode, and movie summaries use the supplied formatter without mutating events', () => {
  const formatter = createMediaDateFormatter('America/Chicago');
  const music = timezoneEvent({ service: 'spotify', title: 'Track', artist: 'Artist', album: 'Album' });
  const episode = timezoneEvent({ title: 'Pilot', show: 'The Show', season: 1, episode: 2, completed: false });
  const movie = timezoneEvent();
  const originalPlayedAt = movie.played_at;

  assert.equal(buildSummary(music, formatter), 'Listened to "Track" by Artist from "Album" on 2026-01-01 via spotify.');
  assert.equal(buildSummary(episode, formatter), 'Watched The Show S01E02 "Pilot" on 2026-01-01 via plex. Did not finish.');
  assert.equal(buildSummary(movie, formatter), 'Watched "Arrival" (2016) on 2026-01-01 via plex. Completed.');
  assert.equal(movie.played_at, originalPlayedAt);
  assert.equal(movie.played_at.toISOString(), '2026-01-02T02:00:00.000Z');
});

test('configuration defaults to UTC, trims valid zones, and rejects invalid zones and timestamps', () => {
  assert.equal(resolveMediaTimeZone(undefined), 'UTC');
  assert.equal(resolveMediaTimeZone('  America/Chicago  '), 'America/Chicago');
  assert.throws(() => resolveMediaTimeZone('Mars/Olympus_Mons'), /Invalid MEDIA_TIME_ZONE/);
  assert.throws(() => formatMediaDate(new Date('invalid'), createMediaDateFormatter('UTC')), /Invalid played_at/);
});
