import assert from 'node:assert/strict';
import test from 'node:test';

import { runYtmusicSync } from '../../scripts/ytmusic-sync.js';

const attribution = {
  apiKeyId: 'api-key',
  agentId: 'agent-id',
  scope: { keyId: 'api-key', namespaces: ['media'] },
  auth: {
    keyId: 'api-key',
    name: 'ytmusic',
    namespaces: ['media'],
    permissions: ['read', 'write'],
    maxAccessLevel: 'normal' as const,
  },
};

test('ytmusic sync script exits nonzero when the connector reports fetch errors', async () => {
  const calls: string[] = [];
  const exitCode = await runYtmusicSync({
    now: () => new Date('2026-09-08T00:00:00.000Z'),
    log: (message) => calls.push(`log:${message}`),
    error: (message, details) => calls.push(`error:${message}:${JSON.stringify(details)}`),
    resolveAttribution: async () => attribution,
    createConnector: () => ({
      sync: async () => ({
        service: 'ytmusic',
        events_ingested: 0,
        events_skipped: 0,
        errors: ['browser authentication expired'],
        duration_ms: 10,
      }),
    }),
    shutdownDb: async () => {
      calls.push('shutdown');
    },
  });

  assert.equal(exitCode, 1);
  assert.ok(calls.some((call) => call.includes('browser authentication expired')));
  assert.equal(calls.some((call) => call.includes('[ytmusic-sync] done')), false);
  assert.equal(calls.at(-2), 'shutdown');
  assert.equal(calls.at(-1), 'log:[ytmusic-sync] completed exit_code=1');
});

test('ytmusic sync script exits nonzero when rollup partially fails', async () => {
  const calls: string[] = [];
  const exitCode = await runYtmusicSync({
    log: (message) => calls.push(`log:${message}`),
    error: (message, details) => calls.push(`error:${message}:${JSON.stringify(details)}`),
    resolveAttribution: async () => attribution,
    createConnector: () => ({
      sync: async () => ({
        service: 'ytmusic',
        events_ingested: 1,
        events_skipped: 0,
        errors: [],
        duration_ms: 10,
      }),
    }),
    rollupPending: async () => ({ rolled: 0, failed: 1, errors: ['embedding unavailable'] }),
    shutdownDb: async () => {
      calls.push('shutdown');
    },
  });

  assert.equal(exitCode, 1);
  assert.ok(calls.some((call) => call.includes('embedding unavailable')));
  assert.equal(calls.at(-2), 'shutdown');
  assert.equal(calls.at(-1), 'log:[ytmusic-sync] completed exit_code=1');
});
