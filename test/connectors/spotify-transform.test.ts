import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { toMediaEvent, type PlayHistoryObject } from '../../src/connectors/spotify/transform.js';

const play: PlayHistoryObject = {
  played_at: '2026-07-12T12:00:00.000Z',
  context: { uri: 'spotify:playlist:playlist-1', type: 'playlist' },
  track: {
    id: 'track-1',
    uri: 'spotify:track:track-1',
    name: 'Unknown Progress',
    duration_ms: 245_000,
    artists: [{ id: 'artist-1', name: 'Artist', uri: 'spotify:artist:artist-1' }],
    album: { id: 'album-1', name: 'Album', uri: 'spotify:album:album-1' },
  },
};

test('Spotify recently-played retains duration without asserting progress or completion', () => {
  const event = toMediaEvent(play);

  assert.equal(event.duration_ms, 245_000);
  assert.equal(Object.hasOwn(event, 'played_ms'), false);
  assert.equal(Object.hasOwn(event, 'completed'), false);
});

test('Spotify docs and package command expose the preview-only approval workflow', () => {
  const connectorDocs = readFileSync(new URL('../../docs/connectors/spotify.md', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };

  assert.match(connectorDocs, /progress.*unknown/is);
  assert.doesNotMatch(connectorDocs, /only logs completed plays/i);
  assert.match(readme, /approval manifest/i);
  assert.equal(packageJson.scripts['spotify:repair-progress'], 'tsx scripts/repair-spotify-progress.ts');
});
