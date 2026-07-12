import assert from 'node:assert/strict';
import test from 'node:test';

import { buildYtmusicFetchArgs } from '../../src/connectors/ytmusic/connector.js';
import { toMediaEvent } from '../../src/connectors/ytmusic/transform.js';

test('ytmusic helper fetch args always request the full retained history window', () => {
  const args = buildYtmusicFetchArgs('/tmp/token.json');

  assert.deepEqual(args, ['fetch', '--token-file', '/tmp/token.json']);
  assert.equal(args.includes('--since'), false);
});

test('ytmusic transform rejects invalid resolved played timestamps', () => {
  assert.equal(
    toMediaEvent({
      videoId: 'bad-date',
      title: 'Bad Date',
      played: 'not-a-date',
      played_raw: 'Today',
      played_precision: 'day',
    }),
    null
  );
});
