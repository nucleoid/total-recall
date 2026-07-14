import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import {
  applyDeconsolidation,
  parseConsolidationPolicy,
  previewDeconsolidation,
  runConsolidation,
  type ConsolidationPolicy,
} from '../src/consolidation.js';
import { dbScopeFromAuth, setPoolForTesting, withScopedClient } from '../src/db.js';
import { memoryList } from '../src/tools/list.js';
import { memoryRecall } from '../src/tools/recall.js';
import type { AuthContext } from '../src/types.js';

const KEY = '10000000-0000-4000-8000-000000000001';
const FIRST = '20000000-0000-4000-8000-000000000001';
const SECOND = '20000000-0000-4000-8000-000000000002';
const vector = (second = 0): number[] => [1, second, ...Array(766).fill(0)];
const vectorText = (values: number[]): string => `[${values.join(',')}]`;

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function policy(): ConsolidationPolicy {
  return parseConsolidationPolicy({
    version: 1,
    feature: 'memory-consolidation',
    environment: 'test',
    generation: {
      provider: 'test-gateway', model: 'test-model', endpoint: 'https://example.test/generate',
      credentialEnv: 'CONSOLIDATION_TEST_KEY',
    },
    terms: { reference: 'test-approval', privacyApproved: true, retentionApproved: true, trainingApproved: true },
    scope: { namespaces: ['work'], accessLevel: 'normal' },
    budget: {
      maxCallsPerInvocation: 2, maxInputBytesPerInvocation: 131072,
      maxOutputBytesPerInvocation: 32768, maxCostUsdPerInvocation: 1,
      estimatedRequestCostUsd: 0.001, estimatedInputCostUsdPerMillionBytes: 1,
      estimatedOutputCostUsdPerMillionBytes: 4, monthlyControlReference: 'test-provider-quota',
    },
    generationApproval: {
      approved: true, approvedBy: 'test-owner', approvedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
    },
    writeApproval: {
      approved: true, approvedBy: 'test-owner', approvedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
    },
  }, 'test');
}

test('app-role apply preserves provenance, hides originals, and exact deconsolidation restores them',
  { timeout: 120_000 }, async t => {
    if (!dockerAvailable()) { t.skip('Docker is unavailable'); return; }
    const container = execFileSync('docker', [
      'run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=postgres', '-p', '127.0.0.1::5432',
      process.env.CONSOLIDATION_TEST_IMAGE || 'pgvector/pgvector:pg16',
    ], { encoding: 'utf8' }).trim();
    t.after(() => { try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch {} });
    const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)!;
    const ownerUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    const appUrl = `postgresql://total_recall_app:app-password@127.0.0.1:${port}/postgres`;

    let owner: pg.Client | undefined;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      owner = new pg.Client({ connectionString: ownerUrl });
      try { await owner.connect(); break; }
      catch { await owner.end().catch(() => undefined); owner = undefined; await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    assert.ok(owner, 'PostgreSQL did not become ready');

    let appPool: pg.Pool | undefined;
    try {
      await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
      await owner.query("CREATE ROLE total_recall_app LOGIN PASSWORD 'app-password'");
      for (const file of readdirSync(join(process.cwd(), 'migrations')).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort()) {
        await owner.query(readFileSync(join(process.cwd(), 'migrations', file), 'utf8'));
      }
      await owner.query(`INSERT INTO api_keys
        (id, key_hash, name, namespaces, permissions, max_access_level, enabled)
        VALUES ($1::uuid, 'test-hash', 'consolidation-test', ARRAY['work'],
          ARRAY['read','write','delete','consolidate'], 'normal', true)`, [KEY]);
      await owner.query(`INSERT INTO memories
        (id, content, embedding, source, namespace, tags, metadata, access_level, client_id,
         embedding_provider, embedding_model, embedding_dimensions, memory_kind, valid_from, created_at)
        VALUES
        ($1::uuid, 'The office is in Austin.', $3::vector, 'test', 'work', ARRAY['office'], '{}', 'normal', $5,
         'gemini', 'gemini-embedding-2-preview', 768, 'semantic', statement_timestamp(), '2026-01-01T00:00:00Z'),
        ($2::uuid, 'Our office location is Austin.', $4::vector, 'test', 'work', ARRAY['location'], '{}', 'normal', $5,
         'gemini', 'gemini-embedding-2-preview', 768, 'semantic', statement_timestamp(), '2026-01-02T00:00:00Z')`,
      [FIRST, SECOND, vectorText(vector()), vectorText(vector(0.01)), KEY]);

      appPool = new pg.Pool({ connectionString: appUrl, max: 5 });
      setPoolForTesting(appPool);
      const auth: AuthContext = {
        keyId: KEY, name: 'consolidation-test', namespaces: ['work'],
        permissions: ['read', 'write', 'delete', 'consolidate'], maxAccessLevel: 'normal',
      };
      const result = await runConsolidation({
        auth, namespace: 'work', mode: 'apply', environment: 'test', policy: policy(),
        provider: {
          name: 'test-gateway',
          async generate(request) {
            const input = JSON.parse(request.input) as { memories: Array<{ id: string }> };
            return JSON.stringify({
              decision: 'merge', source_ids: input.memories.map(memory => memory.id),
              canonical_content: 'The office is in Austin.', reason_code: 'duplicate',
            });
          },
        },
        embedCanonical: async () => vector(),
        anchorLimit: 10,
        clusterLimit: 2,
      });
      assert.equal(result.mergedCanonicalIds.length, 1);
      const canonicalId = result.mergedCanonicalIds[0];

      const ordinary = await memoryList({ limit: 20, offset: 0 }, auth);
      assert.deepEqual(ordinary.memories.map((memory: { id: string }) => memory.id), [canonicalId]);
      const direct = await memoryRecall({ id: FIRST }, auth) as { consolidated_into_id: string };
      assert.equal(direct.consolidated_into_id, canonicalId);

      const provenance = await owner.query(`SELECT cm.member_id, cm.deconsolidated_at, canonical.agent_id
        FROM memory_consolidation_memberships cm JOIN memories canonical ON canonical.id = cm.canonical_id
        WHERE cm.canonical_id = $1::uuid ORDER BY cm.member_id`, [canonicalId]);
      assert.deepEqual(provenance.rows.map(row => row.member_id), [FIRST, SECOND]);
      assert.ok(provenance.rows.every(row => row.deconsolidated_at === null && row.agent_id));
      await assert.rejects(owner.query('DELETE FROM memories WHERE id = $1::uuid', [canonicalId]),
        error => (error as { code?: string }).code === '23503');

      const manifest = await withScopedClient(dbScopeFromAuth(auth), client =>
        previewDeconsolidation(client, auth, 'work', [canonicalId]));
      const restored = await withScopedClient(dbScopeFromAuth(auth), client =>
        applyDeconsolidation(client, auth, manifest));
      assert.deepEqual(restored, { canonicals: 1, members: 2 });
      const after = await memoryList({ limit: 20, offset: 0 }, auth);
      assert.deepEqual(after.memories.map((memory: { id: string }) => memory.id).sort(), [FIRST, SECOND]);
      const history = await owner.query(`SELECT count(*)::int AS count FROM memory_consolidation_memberships
        WHERE canonical_id = $1::uuid AND deconsolidated_at IS NOT NULL`, [canonicalId]);
      assert.equal(history.rows[0].count, 2);
    } finally {
      setPoolForTesting(null);
      await appPool?.end().catch(() => undefined);
      await owner.end().catch(() => undefined);
    }
  });
