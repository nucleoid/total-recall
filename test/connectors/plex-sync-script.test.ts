import assert from 'node:assert/strict';
import test from 'node:test';

import { runPlexSync } from '../../scripts/plex-sync.js';

test('plex sync script rolls up successful inserts, cleans up, and exits nonzero on partial errors', async () => {
  const calls: string[] = [];
  const exitCode = await runPlexSync({
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    log: (message) => calls.push(`log:${message}`),
    error: (message, details) => calls.push(`error:${message}:${JSON.stringify(details)}`),
    resolveAttribution: async () => ({
      apiKeyId: 'api-key',
      agentId: 'agent-id',
      scope: { keyId: 'api-key', namespaces: ['media'] },
      auth: {
        keyId: 'api-key',
        name: 'plex',
        namespaces: ['media'],
        permissions: ['read', 'write'],
        maxAccessLevel: 'normal',
      },
    }),
    createConnector: () => ({
      sync: async () => ({
        service: 'plex',
        events_ingested: 2,
        events_skipped: 1,
        errors: ['Bad Server offline'],
        duration_ms: 42,
      }),
    }),
    rollupPending: async () => {
      calls.push('rollup');
      return { rolled: 2, failed: 0, errors: [] };
    },
    shutdownDb: async () => {
      calls.push('shutdown');
    },
  });

  assert.equal(exitCode, 1);
  assert.ok(calls.includes('rollup'), JSON.stringify(calls));
  assert.equal(calls.at(-2), 'shutdown');
  assert.ok(calls.some((call) => call.includes('Bad Server offline')), JSON.stringify(calls));
  assert.ok(
    calls.includes('log:[plex-sync] completed status=degraded exit_code=1'),
    JSON.stringify(calls)
  );
});

test('plex sync script reports self-healing metadata warnings without a degraded exit', async () => {
  const calls: string[] = [];
  const exitCode = await runPlexSync({
    log: (message) => calls.push(`log:${message}`),
    warn: (message, details) => calls.push(`warn:${message}:${JSON.stringify(details)}`),
    resolveAttribution: async () => ({
      apiKeyId: 'api-key',
      agentId: 'agent-id',
      scope: { keyId: 'api-key', namespaces: ['media'] },
      auth: {
        keyId: 'api-key',
        name: 'plex',
        namespaces: ['media'],
        permissions: ['read', 'write'],
        maxAccessLevel: 'normal',
      },
    }),
    createConnector: () => ({
      sync: async () => ({
        service: 'plex',
        events_ingested: 0,
        events_skipped: 0,
        warnings: ['[plex] ignoring malformed cursor metadata entry for server "old"'],
        errors: [],
        duration_ms: 1,
      }),
    }),
    shutdownDb: async () => {
      calls.push('shutdown');
    },
  });

  assert.equal(exitCode, 0);
  assert.ok(calls.some((call) => call.includes('malformed cursor metadata')), JSON.stringify(calls));
  assert.equal(calls.at(-1), 'log:[plex-sync] completed status=ok exit_code=0');
});

test('plex sync script reports a thrown rollup as failed only after cleanup', async () => {
  const calls: string[] = [];
  const exitCode = await runPlexSync({
    log: (message) => calls.push(`log:${message}`),
    error: (message, details) => calls.push(`error:${message}:${String(details)}`),
    resolveAttribution: async () => ({
      apiKeyId: 'api-key',
      agentId: 'agent-id',
      scope: { keyId: 'api-key', namespaces: ['media'] },
      auth: {
        keyId: 'api-key',
        name: 'plex',
        namespaces: ['media'],
        permissions: ['read', 'write'],
        maxAccessLevel: 'normal',
      },
    }),
    createConnector: () => ({
      sync: async () => ({
        service: 'plex',
        events_ingested: 1,
        events_skipped: 0,
        errors: [],
        duration_ms: 1,
      }),
    }),
    rollupPending: async () => {
      calls.push('rollup');
      throw new Error('embedding unavailable');
    },
    shutdownDb: async () => {
      calls.push('shutdown');
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(calls.at(-2), 'shutdown', JSON.stringify(calls));
  assert.equal(calls.at(-1), 'log:[plex-sync] completed status=failed exit_code=1');
  assert.ok(calls.some((call) => call.includes('embedding unavailable')), JSON.stringify(calls));
});
