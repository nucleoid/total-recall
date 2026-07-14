import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildCompleteLinkCluster,
  consolidationPolicyHash,
  consolidationSourceKey,
  consolidationTags,
  parseConsolidationPolicy,
  selectConsolidationClusters,
  validateConsolidationGeneration,
  type ConsolidationCandidate,
} from '../src/consolidation.js';
import { parseConsolidationCli } from '../scripts/consolidate-memories.js';
import { parseDeconsolidationCli } from '../scripts/deconsolidate-memories.js';

const IDS = Array.from({ length: 22 }, (_, index) =>
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);

function candidate(index: number, similarity = 0.99): ConsolidationCandidate {
  return {
    id: IDS[index],
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    revision: index,
    similarityToAnchor: similarity,
  };
}

function pairMap(rows: ConsolidationCandidate[], similarity = 0.99): Map<string, number> {
  const pairs = new Map<string, number>();
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      const ids = [rows[left].id, rows[right].id].sort();
      pairs.set(`${ids[0]}\0${ids[1]}`, similarity);
    }
  }
  return pairs;
}

function approvedPolicy() {
  return {
    version: 1 as const,
    feature: 'memory-consolidation' as const,
    environment: 'test',
    generation: {
      provider: 'reviewed-gateway', model: 'reviewed-model',
      endpoint: 'https://generation.example.test/v1', credentialEnv: 'CONSOLIDATION_GENERATION_API_KEY',
    },
    terms: {
      reference: 'approval-record', privacyApproved: true as const,
      retentionApproved: true as const, trainingApproved: true as const,
    },
    scope: { namespaces: ['work'] as [string], accessLevel: 'normal' as const },
    budget: {
      maxCallsPerInvocation: 10, maxInputBytesPerInvocation: 655360,
      maxOutputBytesPerInvocation: 163840, maxCostUsdPerInvocation: 1,
      estimatedRequestCostUsd: 0.001, estimatedInputCostUsdPerMillionBytes: 1,
      estimatedOutputCostUsdPerMillionBytes: 4,
      monthlyControlReference: 'provider-project-quota',
    },
    generationApproval: {
      approved: true as const, approvedBy: 'owner', approvedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2027-01-01T00:00:00Z',
    },
  };
}

test('complete-link clustering rejects similarity chains and uses stable order', () => {
  const rows = [candidate(0), candidate(1), candidate(2)];
  const pairs = pairMap(rows);
  pairs.set(`${IDS[1]}\0${IDS[2]}`, 0.91);
  const cluster = buildCompleteLinkCluster(rows[0], [rows[2], rows[0], rows[1]], pairs);
  assert.deepEqual(cluster.members.map(member => member.id), [IDS[0], IDS[1]]);
  assert.equal(cluster.oversized, false);
});

test('threshold is inclusive and a 21-member complete-link set is skipped as oversized', () => {
  const thresholdRows = [candidate(0), candidate(1, 0.92)];
  assert.equal(buildCompleteLinkCluster(thresholdRows[0], thresholdRows, pairMap(thresholdRows, 0.92)).members.length, 2);

  const rows = Array.from({ length: 21 }, (_, index) => candidate(index));
  const cluster = buildCompleteLinkCluster(rows[0], rows, pairMap(rows));
  assert.equal(cluster.oversized, true);
  assert.equal(cluster.members.length, 21);
});

test('selection checkpoint stops at the last examined anchor when the cluster cap is reached', async () => {
  const rows = [candidate(0), candidate(1), candidate(2)];
  const client = {
    async query(text: string) {
      if (text.includes('scope_count')) return { rows: [{ scope_count: '3', eligible_count: '3',
        unknown_identity_count: '0', foreign_identity_count: '0' }] };
      if (text.includes('SELECT m.id, m.created_at')) return { rows: rows.map(row => ({
        id: row.id, created_at: row.createdAt, revision: row.revision,
      })) };
      if (text.includes('JOIN memories candidate')) return { rows: rows.slice(0, 2).map(row => ({
        id: row.id, created_at: row.createdAt, revision: row.revision, similarity: row.similarityToAnchor,
      })) };
      if (text.includes('left_memory.id AS left_id')) return { rows: [{
        left_id: rows[0].id, right_id: rows[1].id, similarity: 0.99,
      }] };
      throw new Error(`Unexpected SQL: ${text}`);
    },
  };
  const selection = await selectConsolidationClusters(client as never, {
    namespace: 'work', anchorLimit: 3, clusterLimit: 1,
  });
  assert.equal(selection.anchorsExamined, 1);
  assert.deepEqual(selection.lastCursor, { createdAt: rows[0].createdAt, id: rows[0].id });
});

test('strict generation output requires exact provenance and bounded decision fields', () => {
  const valid = validateConsolidationGeneration(JSON.stringify({
    decision: 'merge', source_ids: [IDS[1], IDS[0]], canonical_content: 'Canonical fact', reason_code: 'duplicate',
  }), [IDS[0], IDS[1]]);
  assert.equal(valid.canonical_content, 'Canonical fact');

  assert.throws(() => validateConsolidationGeneration(JSON.stringify({
    decision: 'merge', source_ids: [IDS[0]], canonical_content: 'x', reason_code: 'duplicate',
  }), [IDS[0], IDS[1]]), /invalid_consolidation_(?:output|provenance)/);
  assert.throws(() => validateConsolidationGeneration(JSON.stringify({
    decision: 'skip', source_ids: [IDS[0], IDS[1]], canonical_content: 'forbidden', reason_code: 'different',
  }), [IDS[0], IDS[1]]), /invalid_consolidation_output/);
  assert.throws(() => validateConsolidationGeneration(JSON.stringify({
    decision: 'merge', source_ids: [IDS[0], IDS[1]], canonical_content: 'x', reason_code: 'duplicate', extra: true,
  }), [IDS[0], IDS[1]]), /invalid_consolidation_output/);
});

test('policy is feature-specific, exact-scope, strict, and expiring', () => {
  const policy = parseConsolidationPolicy(approvedPolicy(), 'test', new Date('2026-06-01T00:00:00Z'));
  assert.match(consolidationPolicyHash(policy), /^[0-9a-f]{64}$/);
  assert.throws(() => parseConsolidationPolicy({ ...approvedPolicy(), feature: 'contradiction-detection' }, 'test'));
  assert.throws(() => parseConsolidationPolicy({ ...approvedPolicy(), borrowedApproval: true }, 'test'));
  assert.throws(() => parseConsolidationPolicy(approvedPolicy(), 'production'));
  assert.throws(() => parseConsolidationPolicy(approvedPolicy(), 'test', new Date('2028-01-01T00:00:00Z')), /expired/);
});

test('canonical tags and source keys are deterministic and bounded', () => {
  const tags = Array.from({ length: 120 }, (_, index) => `tag-${String(index).padStart(3, '0')}`);
  const canonical = consolidationTags([...tags.reverse(), 'consolidated', 'tag-001']);
  assert.equal(canonical.length, 100);
  assert.equal(canonical.filter(tag => tag === 'consolidated').length, 1);
  assert.deepEqual(canonical, [...canonical].sort());

  const members = [{ id: IDS[1], fingerprint: 'b'.repeat(64) }, { id: IDS[0], fingerprint: 'a'.repeat(64) }];
  assert.equal(
    consolidationSourceKey(members, 'c'.repeat(64)),
    consolidationSourceKey([...members].reverse(), 'c'.repeat(64)),
  );
  assert.match(consolidationSourceKey(members, 'c'.repeat(64)), /^memory-consolidation:v1:[0-9a-f]{64}$/);
});

test('CLI modes are explicit, bounded, and keep previews out of stdout', () => {
  assert.deepEqual(parseConsolidationCli(['--namespace', 'work', '--selection-only']), {
    namespace: 'work', mode: 'selection-only', anchorLimit: undefined, clusterLimit: undefined,
    previewOutput: undefined, cursor: undefined,
  });
  assert.throws(() => parseConsolidationCli(['--namespace', 'work', '--dry-run']), /preview-output/);
  assert.throws(() => parseConsolidationCli(['--namespace', 'work', '--apply', '--selection-only']), /mutually exclusive/);
  assert.throws(() => parseConsolidationCli(['--namespace', 'work', '--selection-only', '--max-anchors', 'nope']), /max-anchors/);

  const preview = parseDeconsolidationCli([
    '--namespace', 'work', '--canonical-id', IDS[0], '--manifest', 'preview.json',
  ]);
  assert.equal(preview.mode, 'preview');
  assert.throws(() => parseDeconsolidationCli([
    '--namespace', 'work', '--apply', '--manifest', 'preview.json',
  ]), /approve-policy-hash/);
});

test('migration and runbook preserve provenance and ship no public scheduler or endpoint', () => {
  const migration = readFileSync(new URL('../migrations/027_memory_consolidation.sql', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/consolidation.ts', import.meta.url), 'utf8');
  const runbook = readFileSync(new URL('../docs/consolidation-rollout-runbook.md', import.meta.url), 'utf8');
  const register = readFileSync(new URL('../src/tools/register.ts', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const openapi = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8');

  assert.match(migration, /consolidated_into_id UUID/);
  assert.match(migration, /ON DELETE RESTRICT/);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /memory_consolidation_memberships/);
  assert.doesNotMatch(migration, /UPDATE public\.memories\s+SET/i);
  assert.doesNotMatch(source.split("await import('./embedding.js')")[0], /from '\.\/embedding\.js'/);
  assert.match(runbook, /externally scheduled/);
  assert.match(runbook, /old reader\/writer/);
  assert.doesNotMatch(register, /consolidat/i);
  assert.doesNotMatch(server, /consolidat/i);
  assert.doesNotMatch(openapi, /operationId:\s*consolidat|\/api\/consolidat/i);
});
