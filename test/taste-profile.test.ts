import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import {
  assertTasteProfileAuthority,
  buildTasteProfileEvidence,
  lastCompletedMediaMonth,
  mediaMonthPeriod,
  parseTasteProfilePolicy,
  renderTasteProfile,
  runTasteProfile,
  tasteProfileSourceKey,
  validateTasteProfileOutput,
} from '../src/taste-profile.js';
import { buildMediaTasteAggregate, type MediaTasteAggregateOptions } from '../src/media.js';
import { parseTasteProfileCli } from '../scripts/taste-profile.js';
import { setPoolForTesting } from '../src/db.js';
import { QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';

function policy() {
  const approval = { approved: true as const, approvedBy: 'owner', approvedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' };
  return {
    version: 2 as const, feature: 'media-taste-profile' as const, enabled: true as const, environment: 'test',
    generation: { provider: 'openclaw-adapter' as const, model: 'openclaw/total-recall-synthesis' as const,
      endpoint: 'https://example.invalid/generate', credentialEnv: 'TASTE_KEY', timeoutMs: 1000 },
    terms: { reference: 'review', privacyApproved: true as const, retentionApproved: true as const, trainingApproved: true as const },
    scope: { namespaces: ['media', 'personal'], sourceNamespace: 'media', targetNamespace: 'personal',
      accessLevels: ['normal' as const] },
    aggregation: { minimumEvents: 10, topLimit: 10, trendMinimumAbsoluteChange: 3, trendMinimumShareChange: 0.1 },
    budget: { mode: 'subscription' as const, maxCallsPerRun: 2 as const,
      maxOutputBytesPerRun: 8192 as const, usageControlReference: 'private OpenClaw adapter quota' },
    selection: { previewTtlMinutes: 60, maxMaterializedEvents: 1000 },
    providerModelApproval: approval, termsApproval: approval, scopeApproval: approval, budgetApproval: approval,
  };
}

test('taste-profile month windows honor IANA DST and year boundaries', () => {
  const march = mediaMonthPeriod('2026-03', 'America/Chicago');
  assert.equal(march.window.start.toISOString(), '2026-03-01T06:00:00.000Z');
  assert.equal(march.window.end.toISOString(), '2026-04-01T05:00:00.000Z');
  assert.equal(lastCompletedMediaMonth(new Date('2026-01-15T12:00:00Z'), 'America/Chicago').label, '2025-12');
  assert.throws(() => mediaMonthPeriod('2026-13', 'UTC'), /valid|YYYY-MM/);
  assert.throws(() => mediaMonthPeriod('2026-01', 'Not/AZone'), /IANA/);
});

test('taste-profile policy requires independent approvals and exact environment', () => {
  const parsed = parseTasteProfilePolicy(policy(), 'test', new Date('2026-06-01T00:00:00Z'));
  assert.equal(parsed.feature, 'media-taste-profile');
  const auth = { keyId: '11111111-1111-4111-8111-111111111111', name: 'taste',
    namespaces: ['media', 'personal'], permissions: ['read', 'write'], maxAccessLevel: 'normal' as const };
  assert.doesNotThrow(() => assertTasteProfileAuthority(auth, parsed));
  assert.throws(() => assertTasteProfileAuthority({ ...auth, permissions: [...auth.permissions, 'delete'] }, parsed), /exactly/);
  const missing = { ...policy() } as any;
  delete missing.scopeApproval;
  assert.throws(() => parseTasteProfilePolicy(missing, 'test', new Date('2026-06-01T00:00:00Z')));
  assert.throws(() => parseTasteProfilePolicy(policy(), 'production', new Date('2026-06-01T00:00:00Z')), /environment/);
  assert.throws(() => parseTasteProfilePolicy({ ...policy(), generation: { ...policy().generation,
    provider: 'paid-gateway' } }, 'test', new Date('2026-06-01T00:00:00Z')));
  assert.throws(() => parseTasteProfilePolicy({ ...policy(), budget: { ...policy().budget,
    mode: 'paid' } }, 'test', new Date('2026-06-01T00:00:00Z')));
});

test('all-access lane authority remains exact and least-privileged', () => {
  const allAccess = { ...policy(), scope: { namespaces: ['financial', 'media', 'my-life', 'personal'],
    sourceNamespace: 'media', targetNamespace: 'personal',
    accessLevels: ['normal' as const, 'sensitive' as const, 'secret' as const] } };
  const parsed = parseTasteProfilePolicy(allAccess, 'test', new Date('2026-06-01T00:00:00Z'));
  const auth = { keyId: '11111111-1111-4111-8111-111111111111', name: 'taste',
    namespaces: ['financial', 'media', 'my-life', 'personal'], permissions: ['read', 'write'],
    maxAccessLevel: 'secret' as const };
  assert.doesNotThrow(() => assertTasteProfileAuthority(auth, parsed));
  assert.throws(() => assertTasteProfileAuthority({ ...auth, namespaces: ['media', 'personal'] }, parsed), /exactly/);
  assert.throws(() => assertTasteProfileAuthority({ ...auth, permissions: ['read', 'write', 'reflection'] }, parsed), /exactly/);
});

test('aggregate mapping and generated output remain evidence-only', () => {
  const period = mediaMonthPeriod('2026-06', 'UTC');
  const options: MediaTasteAggregateOptions = { category: 'music', sourceNamespace: 'media',
    period: period.window, previousPeriod: period.previousWindow, topLimit: 10 };
  const rows = [
    { window_name: 'period', dimension: 'total', value: 'events', event_count: '20', rank: 1 },
    { window_name: 'period', dimension: 'service', value: 'spotify', event_count: '20', rank: 1 },
    { window_name: 'period', dimension: 'entity', value: 'Artist A', event_count: '12', rank: 1 },
    { window_name: 'previous', dimension: 'total', value: 'events', event_count: '20', rank: 1 },
    { window_name: 'previous', dimension: 'entity', value: 'Artist A', event_count: '4', rank: 1 },
    { window_name: 'days30', dimension: 'total', value: 'events', event_count: '20', rank: 1 },
    { window_name: 'days90', dimension: 'total', value: 'events', event_count: '50', rank: 1 },
    { window_name: 'days365', dimension: 'total', value: 'events', event_count: '200', rank: 1 },
    { window_name: 'allTime', dimension: 'total', value: 'events', event_count: '300', rank: 1 },
  ] as any;
  const aggregate = buildMediaTasteAggregate(rows, options);
  assert.deepEqual(aggregate.qualityWarnings, ['single_service']);
  const evidence = buildTasteProfileEvidence(aggregate, period.label, policy().aggregation);
  const entity = evidence.facts.find(fact => fact.kind === 'entity')!;
  const valid = validateTasteProfileOutput(JSON.stringify({ profile_style: 'shifting', evidence_ids: [entity.id] }), evidence.facts);
  assert.match(renderTasteProfile('music', period.label, valid, evidence.facts), /Artist A had 12/);
  assert.throws(() => validateTasteProfileOutput(JSON.stringify({ profile_style: 'steady', evidence_ids: ['E999'] }), evidence.facts), /evidence/);
  assert.throws(() => validateTasteProfileOutput(JSON.stringify({ profile_style: 'steady', evidence_ids: [entity.id], summary: 'invented' }), evidence.facts), /output/);
  assert.equal(tasteProfileSourceKey('music', '2026-06'), 'media-taste:v2:normal:music:2026-06');
});

test('default dry-run reads bounded aggregates without provider, embedding, or mutation calls', async () => {
  const sql: string[] = [];
  const period = mediaMonthPeriod('2026-06', 'UTC');
  const client = {
    query: async (text: string) => {
      sql.push(text);
      if (text.includes('WITH eligible AS')) return { rows: [
        { window_name: 'period', dimension: 'total', value: 'events', event_count: '20', rank: 1 },
        { window_name: 'period', dimension: 'entity', value: 'Artist A', event_count: '12', rank: 1 },
      ] };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  setPoolForTesting({ connect: async () => client } as unknown as pg.Pool);
  let providerCalls = 0;
  let embeddingCalls = 0;
  try {
    const result = await runTasteProfile({
      auth: { keyId: '11111111-1111-4111-8111-111111111111', name: 'taste',
        namespaces: ['media', 'personal'], permissions: ['read', 'write'], maxAccessLevel: 'normal' },
      category: 'music', period, timeZone: 'UTC', environment: 'test', policy: policy(), accessLevel: 'normal',
      provider: { name: 'openclaw-adapter', generate: async () => { providerCalls += 1; return '{}'; } },
      embedProfile: async () => { embeddingCalls += 1; return Array(768).fill(0); },
    });
    assert.equal(result.status, 'dry-run');
    assert.equal(providerCalls, 0);
    assert.equal(embeddingCalls, 0);
    assert.equal(sql.some(text => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(text)), false);
  } finally { setPoolForTesting(null); }
});

test('expired or revoked linked source evidence fails closed before generation', async () => {
  const period = mediaMonthPeriod('2026-06', 'UTC');
  const client = {
    query: async (text: string) => {
      if (text.includes('m.id AS linked_memory_id')) return { rows: [{
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', service: 'spotify', event_type: 'play',
        title: 'Track', artist: 'Artist', show: null, genres: [], played_at: '2026-06-01T00:00:00Z',
        memory_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', linked_memory_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        memory_namespace: 'media', memory_revision: 1, access_level: 'normal', deleted_at: null,
        expires_at: '2026-06-15T00:00:00Z', superseded_at: null, valid_to: null,
      }] };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  setPoolForTesting({ connect: async () => client } as unknown as pg.Pool);
  try {
    await assert.rejects(runTasteProfile({
      auth: { keyId: '11111111-1111-4111-8111-111111111111', name: 'taste',
        namespaces: ['media', 'personal'], permissions: ['read', 'write'], maxAccessLevel: 'normal' },
      category: 'music', period, timeZone: 'UTC', environment: 'test', policy: policy(),
      accessLevel: 'normal', now: new Date('2026-07-01T00:00:00Z'),
      provider: { name: 'openclaw-adapter', generate: async () => { throw new Error('must not call'); } },
    }), /expired_or_revoked/);
  } finally { setPoolForTesting(null); }
});

test('preview retries invalid structured output once and never embeds or mutates', async () => {
  const sql: string[] = [];
  const period = mediaMonthPeriod('2026-06', 'UTC');
  const client = {
    query: async (text: string) => {
      sql.push(text);
      if (text.includes('WITH eligible AS')) return { rows: [
        { window_name: 'period', dimension: 'total', value: 'events', event_count: '20', rank: 1 },
        { window_name: 'period', dimension: 'entity', value: 'Artist A', event_count: '12', rank: 1 },
      ] };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  setPoolForTesting({ connect: async () => client } as unknown as pg.Pool);
  let providerCalls = 0;
  let embeddingCalls = 0;
  try {
    const result = await runTasteProfile({
      auth: { keyId: '11111111-1111-4111-8111-111111111111', name: 'taste',
        namespaces: ['media', 'personal'], permissions: ['read', 'write'], maxAccessLevel: 'normal' },
      category: 'music', period, timeZone: 'UTC', environment: 'test', policy: policy(), mode: 'preview', accessLevel: 'normal',
      provider: { name: 'openclaw-adapter', generate: async () => ++providerCalls === 1 ? '{"bad":true}' :
        '{"profile_style":"focused","evidence_ids":["E002"]}' },
      embedProfile: async () => { embeddingCalls += 1; return Array(768).fill(0); },
    });
    assert.equal(result.status, 'preview');
    assert.equal(result.providerCalls, 2);
    assert.match(result.profile!, /Artist A had 12/);
    assert.equal(result.selection?.approval, undefined);
    assert.equal(result.selection?.accessLevel, 'normal');
    assert.match(result.selection?.sourceFingerprint ?? '', /^[0-9a-f]{64}$/);
    assert.equal(embeddingCalls, 0);
    assert.equal(sql.some(text => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(text)), false);
  } finally { setPoolForTesting(null); }
});

test('apply embeds before one atomic agent/update/supersession/audit transaction', async () => {
  const previousEmbeddingContract = process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  const previousRollbackWrites = process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
  process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = QWEN_CONTRACT_ID;
  delete process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
  const period = mediaMonthPeriod('2026-06', 'UTC');
  const calls: Array<{ connection: number; text: string }> = [];
  let connections = 0;
  let embeddingDone = false;
  const agentId = '22222222-2222-4222-8222-222222222222';
  const priorId = '33333333-3333-4333-8333-333333333333';
  const profileId = '44444444-4444-4444-8444-444444444444';
  const client = {
    query: async (text: string) => {
      calls.push({ connection: connections, text });
      if (text.includes('WITH eligible AS')) return { rows: [
        { window_name: 'period', dimension: 'total', value: 'events', event_count: '20', rank: 1 },
        { window_name: 'period', dimension: 'entity', value: 'Artist A', event_count: '12', rank: 1 },
      ] };
      if (text.includes("SELECT id, metadata->>'aggregate_hash'")) return { rows: [] };
      if (text.includes('FROM api_keys WHERE id')) return { rows: [{ namespaces: ['media', 'personal'],
        permissions: ['read', 'write'], max_access_level: 'normal', enabled: true,
        expires_at: null, revoked_at: null }] };
      if (text.startsWith('INSERT INTO agents')) return { rows: [{ id: agentId }] };
      if (text.includes("metadata->>'source_fingerprint' AS source_fingerprint")) return { rows: [] };
      if (text.includes('metadata->>$6 AS series_order')) return { rows: [{ id: priorId, series_order: '2026-05' }] };
      if (text.includes('statement_timestamp()::text AS now')) return { rows: [{ now: '2026-07-01 00:00:00+00' }] };
      if (text.includes('UPDATE memories SET superseded_at')) return { rows: [], rowCount: 1 };
      if (text.includes('INSERT INTO memories')) return { rows: [{ id: profileId }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  setPoolForTesting({ connect: async () => {
    connections += 1;
    if (connections === 3) assert.equal(embeddingDone, true, 'embedding must finish before the write transaction');
    return client;
  } } as unknown as pg.Pool);
  try {
    const preview = await runTasteProfile({
      auth: { keyId: '11111111-1111-4111-8111-111111111111', name: 'taste',
        namespaces: ['media', 'personal'], permissions: ['read', 'write'], maxAccessLevel: 'normal' },
      category: 'music', period, timeZone: 'UTC', environment: 'test', policy: policy(),
      mode: 'preview', accessLevel: 'normal', now: new Date('2026-07-01T00:00:00Z'),
      provider: { name: 'openclaw-adapter', generate: async () =>
        '{"profile_style":"focused","evidence_ids":["E002"]}' },
    });
    const approvedSelection = { ...preview.selection!, approval: { approved: true as const, approvedBy: 'owner',
      approvedAt: '2026-07-01T00:00:01Z', expiresAt: '2026-07-01T00:59:00Z' } };
    calls.splice(0); connections = 0;
    const result = await runTasteProfile({
      auth: { keyId: '11111111-1111-4111-8111-111111111111', name: 'taste',
        namespaces: ['media', 'personal'], permissions: ['read', 'write'], maxAccessLevel: 'normal' },
      category: 'music', period, timeZone: 'UTC', environment: 'test', policy: policy(), mode: 'apply',
      accessLevel: 'normal', approvedSelection, now: new Date('2026-07-01T00:01:00Z'),
      embedProfile: async () => { embeddingDone = true; return Array(768).fill(0); },
    });
    assert.equal(result.status, 'created');
    assert.equal(result.memoryId, profileId);
    assert.equal(result.supersededId, priorId);
    const mutations = calls.filter(call => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(call.text));
    assert.ok(mutations.length >= 4);
    assert.ok(mutations.every(call => call.connection === 3), JSON.stringify(mutations));
    const finalSql = calls.filter(call => call.connection === 3).map(call => call.text).join('\n');
    assert.match(finalSql, /BEGIN[\s\S]*INSERT INTO agents[\s\S]*UPDATE memories SET superseded_at[\s\S]*INSERT INTO memories[\s\S]*INSERT INTO audit_log[\s\S]*COMMIT/);
  } finally {
    setPoolForTesting(null);
    if (previousEmbeddingContract === undefined) delete process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
    else process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = previousEmbeddingContract;
    if (previousRollbackWrites === undefined) delete process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
    else process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES = previousRollbackWrites;
  }
});

test('apply rejects a source change after embedding and before any mutation', async () => {
  const previousEmbeddingContract = process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  const previousRollbackWrites = process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
  process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = QWEN_CONTRACT_ID;
  delete process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
  const period = mediaMonthPeriod('2026-06', 'UTC');
  let snapshots = 0;
  const sql: string[] = [];
  const client = {
    query: async (text: string) => {
      sql.push(text);
      if (text.includes('m.id AS linked_memory_id')) {
        snapshots += 1;
        return { rows: snapshots < 3 ? [] : [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          service: 'spotify', event_type: 'play', title: 'Track', artist: 'Artist', show: null,
          genres: [], played_at: '2026-06-02T00:00:00Z', memory_id: null, linked_memory_id: null,
          memory_namespace: null, memory_revision: null, access_level: null, deleted_at: null,
          expires_at: null, superseded_at: null, valid_to: null }] };
      }
      if (text.includes('WITH eligible AS')) return { rows: [
        { window_name: 'period', dimension: 'total', value: 'events', event_count: '20', rank: 1 },
        { window_name: 'period', dimension: 'entity', value: 'Artist A', event_count: '12', rank: 1 },
      ] };
      if (text.includes('FROM api_keys WHERE id')) return { rows: [{ namespaces: ['media', 'personal'],
        permissions: ['read', 'write'], max_access_level: 'normal', enabled: true,
        expires_at: null, revoked_at: null }] };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  setPoolForTesting({ connect: async () => client } as unknown as pg.Pool);
  const auth = { keyId: '11111111-1111-4111-8111-111111111111', name: 'taste',
    namespaces: ['media', 'personal'], permissions: ['read', 'write'], maxAccessLevel: 'normal' as const };
  try {
    const preview = await runTasteProfile({ auth, category: 'music', period, timeZone: 'UTC',
      environment: 'test', policy: policy(), mode: 'preview', accessLevel: 'normal',
      now: new Date('2026-07-01T00:00:00Z'), provider: { name: 'openclaw-adapter', generate: async () =>
        '{"profile_style":"focused","evidence_ids":["E002"]}' } });
    const approvedSelection = { ...preview.selection!, approval: { approved: true as const, approvedBy: 'owner',
      approvedAt: '2026-07-01T00:00:01Z', expiresAt: '2026-07-01T00:59:00Z' } };
    await assert.rejects(runTasteProfile({ auth, category: 'music', period, timeZone: 'UTC',
      environment: 'test', policy: policy(), mode: 'apply', accessLevel: 'normal', approvedSelection,
      now: new Date('2026-07-01T00:01:00Z'), embedProfile: async () => Array(768).fill(0) }), /source_changed/);
    assert.equal(sql.some(text => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(text)), false);
  } finally {
    setPoolForTesting(null);
    if (previousEmbeddingContract === undefined) delete process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
    else process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = previousEmbeddingContract;
    if (previousRollbackWrites === undefined) delete process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
    else process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES = previousRollbackWrites;
  }
});

test('taste-profile CLI defaults to provider-free dry-run and keeps modes explicit', () => {
  assert.deepEqual(parseTasteProfileCli([]), { mode: 'dry-run', category: 'all', period: undefined,
    accessLevel: 'all', force: false, json: false, selectionFile: undefined });
  assert.deepEqual(parseTasteProfileCli(['--preview', '--category', 'viewing', '--period', '2026-06', '--json']),
    { mode: 'preview', category: 'viewing', period: '2026-06', accessLevel: 'all',
      force: false, json: true, selectionFile: undefined });
  assert.throws(() => parseTasteProfileCli(['--preview', '--apply']), /mutually exclusive/);
  assert.throws(() => parseTasteProfileCli(['--force']), /dry-run/);
  assert.throws(() => parseTasteProfileCli(['--category', 'activity']), /music/);
  assert.throws(() => parseTasteProfileCli(['--apply']), /selection-file/);
});
