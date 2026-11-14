import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { consolidationReadiness, consolidationSemanticDescriptor, selectConsolidationClusters } from '../src/consolidation.js';
import { QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';

async function withLocalTarget<T>(operation: () => T | Promise<T>): Promise<T> {
  const target = process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT;
  const rollback = process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES;
  process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = QWEN_CONTRACT_ID;
  process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES = 'true';
  try { return await operation(); } finally {
    if (target === undefined) delete process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT; else process.env.SHADOW_EMBEDDING_CURRENT_CONTRACT = target;
    if (rollback === undefined) delete process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES; else process.env.SHADOW_EMBEDDING_ROLLBACK_WRITES = rollback;
  }
}

test('local consolidation semantic identity stays Qwen during Gemini rollback writes', () => withLocalTarget(() => {
  assert.deepEqual(consolidationSemanticDescriptor(), { provider: 'llama.cpp', model: QWEN_CONTRACT_ID, dimensions: 768 });
}));

test('local readiness counts complete current manifests and does not gate on physical canonical identity', async () => {
  await withLocalTarget(async () => {
    const client = { query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('embedding_serving_settings')) {
        assert.deepEqual(values, [QWEN_CONTRACT_ID]);
        return { rows: [{ active: true }], rowCount: 1 };
      }
      assert.match(sql, /memory_embedding_manifests/); assert.match(sql, /f\.source_revision=m\.revision/);
      assert.match(sql, /memory_embedding_chunks/); assert.doesNotMatch(sql, /embedding_provider\s*=/);
      assert.deepEqual(values, ['personal', QWEN_CONTRACT_ID]);
      return { rows: [{ scope_count: '4', eligible_count: '3', incomplete_count: '1' }], rowCount: 1 };
    } } as any;
    assert.deepEqual(await consolidationReadiness(client, 'personal'), {
      scopeCount: 4, eligibleCount: 3, unknownIdentityCount: 1, foreignIdentityCount: 0,
    });
  });
});

test('local selection uses max cosine across same-contract chunks for anchors, neighbors and complete-link pairs', async () => {
  await withLocalTarget(async () => {
    const seen: string[] = [];
    const client = { query: async (sql: string) => {
      seen.push(sql);
      if (sql.includes('embedding_serving_settings')) return { rows: [{ active: true }] };
      if (sql.includes('scope_count')) return { rows: [{ scope_count: '2', eligible_count: '2', incomplete_count: '0' }] };
      if (sql.includes('SELECT m.id') && sql.includes('ORDER BY m.created_at')) return { rows: [{ id: '10000000-0000-4000-8000-000000000001', created_at: '2026-01-01T00:00:00Z', revision: 1 }] };
      if (sql.includes('candidate_chunk')) return { rows: [
        { id: '10000000-0000-4000-8000-000000000001', created_at: '2026-01-01T00:00:00Z', revision: 1, similarity: 1 },
        { id: '20000000-0000-4000-8000-000000000001', created_at: '2026-01-02T00:00:00Z', revision: 1, similarity: 0.95 },
      ] };
      if (sql.includes('left_chunk')) return { rows: [{ left_id: '10000000-0000-4000-8000-000000000001', right_id: '20000000-0000-4000-8000-000000000001', similarity: 0.95 }] };
      throw new Error(`unexpected SQL: ${sql}`);
    } } as any;
    const result = await selectConsolidationClusters(client, { namespace: 'personal', anchorLimit: 1, clusterLimit: 1 });
    assert.equal(result.clusters[0].members.length, 2);
    assert.ok(seen.some(sql => /max\(1-\(candidate_chunk\.embedding <=> anchor_chunk\.embedding\)\)/i.test(sql)));
    assert.ok(seen.some(sql => /max\(1-\(left_chunk\.embedding <=> right_chunk\.embedding\)\)/i.test(sql)));
  });
});

test('local selection fails before reading candidates when database cutover is not active', async () => {
  await withLocalTarget(async () => {
    const seen: string[] = [];
    const client = { query: async (sql: string) => {
      seen.push(sql);
      return { rows: [{ active: false }], rowCount: 1 };
    } } as any;
    await assert.rejects(selectConsolidationClusters(client, {
      namespace: 'personal', anchorLimit: 1, clusterLimit: 1,
    }), /shadow_embedding\.serving_contract_mismatch/);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /embedding_serving_settings/);
  });
});

test('local apply SQL binds current target manifest while preserving physical writer identity for canonical insert', async () => {
  const source = await readFile(new URL('../src/consolidation.ts', import.meta.url), 'utf8');
  assert.match(source, /FOR UPDATE OF m[\s\S]*target_source_revision/);
  assert.match(source, /targetSourceRevision[\s\S]*targetSourceSha256/);
  assert.match(source, /INSERT INTO memories[\s\S]*ACTIVE_EMBEDDING_DESCRIPTOR\.provider/);
  assert.match(source, /memory_consolidation_memberships[\s\S]*semantic\.provider/);
});
