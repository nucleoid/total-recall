import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { loadMigrationInventory, runMigrations } from '../scripts/migrate.js';
import { provisionDatabase } from '../scripts/provision-db.js';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';

const ownerUrl = process.env.CONTRADICTION_AUDIT_TEST_DATABASE_URL;
const appUrl = process.env.CONTRADICTION_AUDIT_TEST_APP_DATABASE_URL;
const unitVector = `[1,${Array(767).fill(0).join(',')}]`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('migration 062 provides bounded append-only contradiction auditing', {
  skip: !ownerUrl || !appUrl,
  timeout: 120_000,
}, async () => {
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const keyId = randomUUID();
  const subjectId = randomUUID();
  const candidateId = randomUUID();
  const policyHash = 'a'.repeat(64);
  try {
    await owner.query('CREATE EXTENSION IF NOT EXISTS vector');
    await owner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await provisionDatabase(owner, { appPassword: 'app-password', rotateAppPassword: false });
    await runMigrations(owner, loadMigrationInventory(join(process.cwd(), 'migrations')), { lockTimeoutMs: 10_000 });
    await owner.query('SET session_replication_role = replica');
    await owner.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      VALUES($1,$2,'contradiction-review',ARRAY['shared'],ARRAY['read','contradiction_resolve'],'normal')`,
    [keyId, sha('test-key')]);
    await owner.query('INSERT INTO embedding_contracts(id,canonical_json,capture_enabled) VALUES($1,$2,true)',
      [QWEN_CONTRACT_ID, JSON.stringify(QWEN_CHUNK_CONTRACT)]);
    await owner.query(`CREATE TABLE memory_embedding_chunks_contradiction_test
      PARTITION OF memory_embedding_chunks FOR VALUES IN ('${QWEN_CONTRACT_ID}')`);
    await insertMemory(owner, subjectId, 'The office is in Austin', '2026-01-02T00:00:00Z');
    await owner.query('SET session_replication_role = DEFAULT');

    const app = new pg.Client({ connectionString: appUrl });
    await app.connect();
    try {
      await scope(app, keyId);
      const noCandidate = await app.query('SELECT * FROM contradiction_shadow_claim($1,$2,$3)',
        ['shared', 'normal', policyHash]);
      assert.equal(noCandidate.rows[0].status, 'no_candidates');
      assert.equal(noCandidate.rows[0].candidates.length, 0);

      assert.equal((await app.query('SELECT content FROM memories')).rowCount, 0);
      await assert.rejects(app.query('SELECT * FROM contradiction_shadow_receipts'), /permission denied/i);
    } finally { await app.end(); }

    await owner.query('SET session_replication_role = replica');
    await insertMemory(owner, candidateId, 'The office moved from Austin', '2026-01-01T00:00:00Z');
    await owner.query('SET session_replication_role = DEFAULT');

    const secondApp = new pg.Client({ connectionString: appUrl });
    await secondApp.connect();
    try {
      await scope(secondApp, keyId);
      const changedEvidence = await secondApp.query('SELECT * FROM contradiction_shadow_claim($1,$2,$3)',
        ['shared', 'normal', policyHash]);
      assert.equal(changedEvidence.rows[0].status, 'claimed');
      assert.equal(changedEvidence.rows[0].candidates.length, 1);
      const outcome = await secondApp.query(
        'SELECT contradiction_shadow_append_outcome($1,$2,$3,$4,$5,$6) AS status',
        [changedEvidence.rows[0].claim_id, 'classified', 'contradiction', 0.95,
          changedEvidence.rows[0].candidates[0].id, 1],
      );
      assert.equal(outcome.rows[0].status, 'classified');
      const repeated = await secondApp.query(
        'SELECT contradiction_shadow_append_outcome($1,$2,$3,$4,$5,$6) AS status',
        [changedEvidence.rows[0].claim_id, 'classified', 'contradiction', 0.95,
          changedEvidence.rows[0].candidates[0].id, 1],
      );
      assert.equal(repeated.rows[0].status, 'already_recorded');
    } finally { await secondApp.end(); }

    const receipts = await owner.query(`SELECT phase,status,provider_calls FROM contradiction_shadow_receipts
      ORDER BY created_at,id`);
    assert.deepEqual(receipts.rows.map(row => [row.phase, row.status, row.provider_calls]), [
      ['claim', 'no_candidates', 0], ['claim', 'claimed', 0], ['outcome', 'classified', 1],
    ]);
    await owner.query('UPDATE api_keys SET revoked_at=statement_timestamp() WHERE id=$1', [keyId]);
    const revoked = new pg.Client({ connectionString: appUrl });
    await revoked.connect();
    try {
      await scope(revoked, keyId);
      await assert.rejects(revoked.query('SELECT * FROM contradiction_shadow_claim($1,$2,$3)',
        ['shared', 'normal', 'b'.repeat(64)]), /not authorized/);
    } finally { await revoked.end(); }
  } finally {
    await owner.query('SET session_replication_role = DEFAULT').catch(() => undefined);
    await owner.end();
  }
});

async function insertMemory(client: pg.Client, id: string, content: string, updatedAt: string): Promise<void> {
  await client.query(`INSERT INTO memories(id,content,source,namespace,client_id,access_level,memory_kind,
    valid_from,revision,updated_at) VALUES($1,$2,'test','shared','fixture','normal','semantic',
      '2026-01-01T00:00:00Z',0,$3)`, [id, content, updatedAt]);
  await client.query(`INSERT INTO memory_embedding_manifests(contract_id,parent_id,source_sha256,
    source_revision,source_bytes,chunk_count,total_tokens,is_current)
    VALUES($1,$2,$3,0,$4,1,1,true)`, [QWEN_CONTRACT_ID, id, sha(content), Buffer.byteLength(content)]);
  await client.query(`INSERT INTO memory_embedding_chunks(contract_id,parent_id,ordinal,core_start,core_end,
    chunk_sha256,formatted_tokens,embedding) VALUES($1,$2,0,0,$3,$4,1,$5::vector)`,
  [QWEN_CONTRACT_ID, id, Buffer.byteLength(content), sha(content), unitVector]);
}

async function scope(client: pg.Client, keyId: string): Promise<void> {
  await client.query("SELECT set_config('app.allowed_namespaces',$1,false)", [JSON.stringify(['shared'])]);
  await client.query("SELECT set_config('app.current_key_id',$1,false)", [keyId]);
  await client.query("SELECT set_config('app.current_key_is_admin','false',false)");
}
