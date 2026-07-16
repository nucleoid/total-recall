import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  createTransferManifest,
  derivedTransferSourceKey,
  parseJsonLine,
  parseTransferManifest,
  parseTransferMemoryRecord,
  transferRecordFingerprint,
} from '../src/transfer/format.js';

const INSTANCE = '11111111-1111-4111-8111-111111111111';
const MEMORY = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-07-17T00:00:00.000Z';

function record(overrides: Record<string, unknown> = {}) {
  return {
    type: 'memory',
    source_key: 'portable:key',
    content: 'remember this',
    source: 'test',
    namespace: 'shared',
    tags: ['one'],
    metadata: { nested: true },
    access_level: 'normal',
    created_at: NOW,
    updated_at: NOW,
    event_at: null,
    memory_kind: 'semantic',
    valid_from: NOW,
    valid_to: null,
    expires_at: null,
    provenance: { trust: 'untrusted', instance_id: INSTANCE, memory_id: MEMORY },
    ...overrides,
  };
}

test('manifest negotiates major versions while allowing additive minor fields', () => {
  const manifest = createTransferManifest(INSTANCE, new Date(NOW));
  assert.equal(parseTransferManifest({ ...manifest, additive: true, version: { major: 1, minor: 99 } }).version.minor, 99);
  assert.throws(() => parseTransferManifest({ ...manifest, version: { major: 2, minor: 0 } }), /Unsupported transfer format major/);
});

test('derived source keys are stable and bind both source UUIDs', () => {
  const first = derivedTransferSourceKey(INSTANCE, MEMORY);
  assert.equal(first, derivedTransferSourceKey(INSTANCE.toUpperCase(), MEMORY.toUpperCase()));
  assert.notEqual(first, derivedTransferSourceKey(INSTANCE, '33333333-3333-4333-8333-333333333333'));
  assert.match(first, /^total-recall-transfer:v1:[0-9a-f]{64}$/);
});

test('V1 rejects vector, document topology, counters, and prototype-like metadata', () => {
  for (const field of ['embedding', 'vector', 'document_id', 'chunk_index', 'access_count', 'client_id']) {
    assert.throws(() => parseTransferMemoryRecord(record({ [field]: field === 'access_count' ? 1 : 'x' })), /not portable/);
  }
  const unsafe = JSON.parse(JSON.stringify(record()).replace('"nested":true', '"__proto__":{"x":1}'));
  assert.throws(() => parseTransferMemoryRecord(unsafe), /prototype-like/);
});

test('record identity ignores maintenance updated_at and untrusted provenance', () => {
  const first = parseTransferMemoryRecord(record());
  const second = parseTransferMemoryRecord(record({
    updated_at: '2026-07-18T00:00:00.000Z',
    provenance: { trust: 'untrusted', instance_id: '33333333-3333-4333-8333-333333333333', memory_id: MEMORY },
  }));
  assert.equal(transferRecordFingerprint(first), transferRecordFingerprint(second));
  assert.notEqual(transferRecordFingerprint(first), transferRecordFingerprint(parseTransferMemoryRecord(record({ content: 'changed' }))));
});

test('line parser accepts a first-line BOM/CRLF normalization and rejects invalid UTF-8', () => {
  const manifest = createTransferManifest(INSTANCE, new Date(NOW));
  assert.deepEqual(parseJsonLine(Buffer.from(`\ufeff${JSON.stringify(manifest)}`), 1, true), manifest);
  assert.throws(() => parseJsonLine(Buffer.from([0xc3, 0x28]), 2), /valid UTF-8/);
  assert.throws(() => parseJsonLine(Buffer.from('  '), 2), /blank/);
});

test('migration establishes singleton identity and tenant-local source keys', async () => {
  const sql = await readFile(new URL('../migrations/034_memory_transfer.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.instance_settings/);
  assert.match(sql, /UNIQUE \(client_id, source_key\)/);
  assert.match(sql, /app_transfer_source_key_access/);
  assert.doesNotMatch(sql, /UPDATE public\.memories SET source_key/);
});
