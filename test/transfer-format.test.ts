import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deriveTransferSourceKey,
  parseDerivedTransferSourceKey,
  parseTransferManifest,
  parseTransferMemory,
  sanitizeTransferMetadata,
  transferPayloadDigest,
  TransferFormatError,
} from '../src/transfer/format.js';

const INSTANCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMORY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function record(overrides: Record<string, unknown> = {}) {
  return {
    type: 'memory',
    source_key: 'source:one',
    content: 'portable content',
    source: 'manual',
    namespace: 'shared',
    tags: ['portable'],
    metadata: { nested: { okay: true } },
    access_level: 'normal',
    created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-01-02T03:04:05.000Z',
    event_at: null,
    memory_kind: 'semantic',
    valid_from: '2026-01-02T03:04:05.000Z',
    valid_to: null,
    expires_at: null,
    ...overrides,
  };
}

test('V1 manifest accepts additive minor fields and rejects unknown major versions', () => {
  const parsed = parseTransferManifest({
    type: 'manifest', format: { major: 1, minor: 17, additive: true },
    source_instance_id: INSTANCE, exported_at: '2026-01-02T03:04:05Z', future: 'ignored',
  });
  assert.equal(parsed.format.minor, 17);
  assert.equal('future' in parsed, false);
  assert.throws(() => parseTransferManifest({ ...parsed, format: { major: 2, minor: 0 } }), /unsupported transfer format major 2/);
});

test('derived null-key identity is deterministic and reversible without source mutation', () => {
  const first = deriveTransferSourceKey(INSTANCE, MEMORY);
  const second = deriveTransferSourceKey(INSTANCE.toUpperCase(), MEMORY.toUpperCase());
  assert.equal(first, second);
  assert.deepEqual(parseDerivedTransferSourceKey(first), {
    instanceId: INSTANCE,
    memoryId: MEMORY,
  });
});

test('V1 records reject vectors, document-local fields, reserved metadata, and unsafe keys', () => {
  for (const forbidden of ['embedding', 'document_id', 'client_id', 'access_count']) {
    assert.throws(() => parseTransferMemory(record({ [forbidden]: forbidden === 'embedding' ? Array(768).fill(0) : 'x' })),
      (error: unknown) => error instanceof TransferFormatError && error.message.includes(`field '${forbidden}'`));
  }
  assert.throws(() => parseTransferMemory(record({ metadata: { _total_recall_transfer: {} } })), /not portable/);
  const unsafe = JSON.parse('{"type":"memory","source_key":"x","content":"x","source":"x","namespace":"x","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","metadata":{"__proto__":{}}}');
  assert.throws(() => parseTransferMemory(unsafe), /unsafe object key/);
});

test('export sanitization removes local topology and credential-shaped metadata', () => {
  assert.deepEqual(sanitizeTransferMetadata({
    title: 'kept', run_id: 'local', nested: { member_ids: ['local'], token: 'credential', note: 'kept' },
  }), { title: 'kept', nested: { note: 'kept' } });
  assert.throws(() => parseTransferMemory(record({ metadata: { nested: { token: 'credential' } } })), /not portable/);
});

test('payload equality ignores maintenance updated_at but not divergent content', () => {
  const baseline = parseTransferMemory(record());
  const maintenanceOnly = parseTransferMemory(record({ updated_at: '2026-02-03T04:05:06Z' }));
  const divergent = parseTransferMemory(record({ content: 'different' }));
  assert.equal(transferPayloadDigest(baseline), transferPayloadDigest(maintenanceOnly));
  assert.notEqual(transferPayloadDigest(baseline), transferPayloadDigest(divergent));
});
