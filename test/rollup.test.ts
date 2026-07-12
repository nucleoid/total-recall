import assert from 'node:assert/strict';
import test from 'node:test';
import type { MediaEvent } from '../src/media.js';
import { buildTags, classifyMediaKind, type MediaKind } from '../src/rollup.js';

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
