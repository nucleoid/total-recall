import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildYtmusicFetchArgs,
  YtmusicConnector,
  type YtmusicHelperRunner,
} from '../../src/connectors/ytmusic/connector.js';
import { toMediaEvent } from '../../src/connectors/ytmusic/transform.js';

test('ytmusic helper fetch args always request the full retained history window', () => {
  const args = buildYtmusicFetchArgs('/tmp/token.json');

  assert.deepEqual(args, ['fetch', '--token-file', '/tmp/token.json']);
  assert.equal(args.includes('--since'), false);
});

test('ytmusic fetch returns a later play without any lifetime videoId lookup', async () => {
  let fetchArgs: string[] = [];
  const runner: YtmusicHelperRunner = async (args) => {
    fetchArgs = args;
    return {
      stdout: JSON.stringify({
        items: [
          {
            videoId: 'repeat-video',
            title: 'Repeat Track',
            played: '2026-07-02T10:00:00.000Z',
            played_raw: '2026-07-02T10:00:00.000Z',
            played_precision: 'instant',
          },
        ],
      }),
      stderr: '',
      code: 0,
    };
  };

  class TestConnector extends YtmusicConnector {
    protected override async credentials(): Promise<Record<string, unknown>> {
      return { _auth_type: 'browser', headers: { cookie: 'ok' } };
    }

    protected override async saveCredentials(): Promise<void> {}

    async fetchHistory() {
      return this.fetchHistoryEvents();
    }
  }

  const events = await new TestConnector({ runHelper: runner }).fetchHistory();

  assert.equal(events.length, 1);
  assert.equal(events[0].service_id, 'repeat-video');
  assert.equal(fetchArgs.includes('--since'), false);
});

test('ytmusic recovery fetch does not persist refreshed credentials', async () => {
  let credentialWrites = 0;
  const runner: YtmusicHelperRunner = async () => ({
    stdout: JSON.stringify({ items: [] }),
    stderr: JSON.stringify({ token_update: { access_token: 'refreshed' } }),
    code: 0,
  });

  class ReadOnlyConnector extends YtmusicConnector {
    protected override async credentials(): Promise<Record<string, unknown>> {
      return { _auth_type: 'oauth', access_token: 'old' };
    }

    protected override async saveCredentials(): Promise<void> {
      credentialWrites++;
    }

    async fetchRecoveryHistory() {
      return this.fetchHistoryEvents(false);
    }
  }

  await new ReadOnlyConnector({ runHelper: runner }).fetchRecoveryHistory();

  assert.equal(credentialWrites, 0);
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
