import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCompleteLinkCluster,
  consolidationSourceKey,
  consolidationTags,
  CONSOLIDATION_MAX_CLUSTER_SIZE,
  type ConsolidationCandidate,
} from '../src/consolidation.js';

function candidate(id: string, index: number): ConsolidationCandidate {
  return { id, createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`, revision: 0, similarityToAnchor: 0.95 };
}
function key(left: string, right: string): string { return left < right ? `${left}\0${right}` : `${right}\0${left}`; }

test('complete-link clustering rejects a transitive similarity chain', () => {
  const a = candidate('00000000-0000-4000-8000-000000000001', 1);
  const b = candidate('00000000-0000-4000-8000-000000000002', 2);
  const c = candidate('00000000-0000-4000-8000-000000000003', 3);
  const similarities = new Map([[key(b.id, c.id), 0.91]]);
  const result = buildCompleteLinkCluster(a, [a, b, c], similarities);
  assert.deepEqual(result.members.map(member => member.id), [a.id, b.id]);
  assert.equal(result.oversized, false);
});

test('threshold is inclusive and the twenty-first compatible member makes the cluster oversized', () => {
  const members = Array.from({ length: CONSOLIDATION_MAX_CLUSTER_SIZE + 1 }, (_, index) =>
    candidate(`00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, index));
  const similarities = new Map<string, number>();
  for (let left = 1; left < members.length; left += 1) {
    for (let right = left + 1; right < members.length; right += 1) similarities.set(key(members[left].id, members[right].id), 0.92);
  }
  const result = buildCompleteLinkCluster(members[0], members, similarities);
  assert.equal(result.oversized, true);
  assert.equal(result.members.length, 21);
});

test('canonical tags and source keys are deterministic and bounded', () => {
  const tags = consolidationTags([...Array.from({ length: 120 }, (_, index) => `tag-${String(index).padStart(3, '0')}`), 'consolidated']);
  assert.equal(tags.length, 100);
  assert.ok(tags.includes('consolidated'));
  assert.deepEqual(tags, [...tags].sort());
  const members = [
    { id: '00000000-0000-4000-8000-000000000002', fingerprint: 'b'.repeat(64) },
    { id: '00000000-0000-4000-8000-000000000001', fingerprint: 'a'.repeat(64) },
  ];
  assert.equal(consolidationSourceKey(members, 'c'.repeat(64)), consolidationSourceKey([...members].reverse(), 'c'.repeat(64)));
  assert.match(consolidationSourceKey(members, 'c'.repeat(64)), /^memory-consolidation:v1:[0-9a-f]{64}$/);
});
