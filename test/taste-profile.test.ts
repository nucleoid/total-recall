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

function policy() {
  const approval = { approved: true as const, approvedBy: 'owner', approvedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' };
  return {
    version: 1 as const, feature: 'media-taste-profile' as const, enabled: true as const, environment: 'test',
    generation: { provider: 'gateway', model: 'model', endpoint: 'https://example.invalid/generate', credentialEnv: 'TASTE_KEY', timeoutMs: 1000 },
    terms: { reference: 'review', privacyApproved: true as const, retentionApproved: true as const, trainingApproved: true as const },
    scope: { sourceNamespace: 'media', targetNamespace: 'personal', accessLevel: 'normal' as const },
    aggregation: { minimumEvents: 10, topLimit: 10, trendMinimumAbsoluteChange: 3, trendMinimumShareChange: 0.1 },
    budget: { maxCallsPerRun: 2, maxCostUsdPerRun: 1, maxCostUsdPerMonth: 5,
      estimatedRequestCostUsd: 0.001, estimatedInputCostUsdPerMillionBytes: 1,
      estimatedOutputCostUsdPerMillionBytes: 4, monthlyControlReference: 'control' },
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
    namespaces: ['media', 'personal'], permissions: ['admin', 'read', 'write'], maxAccessLevel: 'normal' as const };
  assert.doesNotThrow(() => assertTasteProfileAuthority(auth, parsed));
  assert.throws(() => assertTasteProfileAuthority({ ...auth, permissions: [...auth.permissions, 'delete'] }, parsed), /permits only/);
  const missing = { ...policy() } as any;
  delete missing.scopeApproval;
  assert.throws(() => parseTasteProfilePolicy(missing, 'test', new Date('2026-06-01T00:00:00Z')));
  assert.throws(() => parseTasteProfilePolicy(policy(), 'production', new Date('2026-06-01T00:00:00Z')), /environment/);
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
  assert.equal(tasteProfileSourceKey('music', '2026-06'), 'media-taste:v1:music:2026-06');
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
      category: 'music', period, timeZone: 'UTC', environment: 'test', policy: policy(),
      provider: { name: 'gateway', generate: async () => { providerCalls += 1; return '{}'; } },
      embedProfile: async () => { embeddingCalls += 1; return Array(768).fill(0); },
    });
    assert.equal(result.status, 'dry-run');
    assert.equal(providerCalls, 0);
    assert.equal(embeddingCalls, 0);
    assert.equal(sql.some(text => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(text)), false);
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
      category: 'music', period, timeZone: 'UTC', environment: 'test', policy: policy(), mode: 'preview',
      provider: { name: 'gateway', generate: async () => ++providerCalls === 1 ? '{"bad":true}' :
        '{"profile_style":"focused","evidence_ids":["E002"]}' },
      embedProfile: async () => { embeddingCalls += 1; return Array(768).fill(0); },
    });
    assert.equal(result.status, 'preview');
    assert.equal(result.providerCalls, 2);
    assert.match(result.profile!, /Artist A had 12/);
    assert.equal(embeddingCalls, 0);
    assert.equal(sql.some(text => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(text)), false);
  } finally { setPoolForTesting(null); }
});

test('apply embeds before one atomic agent/update/supersession/audit transaction', async () => {
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
      if (text.startsWith('INSERT INTO agents')) return { rows: [{ id: agentId }] };
      if (text.includes('SELECT id, source, metadata')) return { rows: [] };
      if (text.includes('SELECT id, CASE WHEN')) return { rows: [{ id: priorId, series_order: '2026-05' }] };
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
    const result = await runTasteProfile({
      auth: { keyId: '11111111-1111-4111-8111-111111111111', name: 'taste',
        namespaces: ['media', 'personal'], permissions: ['read', 'write'], maxAccessLevel: 'normal' },
      category: 'music', period, timeZone: 'UTC', environment: 'test', policy: policy(), mode: 'apply',
      provider: { name: 'gateway', generate: async () =>
        '{"profile_style":"focused","evidence_ids":["E002"]}' },
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
  } finally { setPoolForTesting(null); }
});

test('taste-profile CLI defaults to provider-free dry-run and keeps modes explicit', () => {
  assert.deepEqual(parseTasteProfileCli([]), { mode: 'dry-run', category: 'all', period: undefined, force: false, json: false });
  assert.deepEqual(parseTasteProfileCli(['--preview', '--category', 'viewing', '--period', '2026-06', '--json']),
    { mode: 'preview', category: 'viewing', period: '2026-06', force: false, json: true });
  assert.throws(() => parseTasteProfileCli(['--preview', '--apply']), /mutually exclusive/);
  assert.throws(() => parseTasteProfileCli(['--force']), /dry-run/);
  assert.throws(() => parseTasteProfileCli(['--category', 'activity']), /music/);
});
