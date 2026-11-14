import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';
import {activateAttestedServing} from './shadow-embedding-fixtures.js';

const databaseUrl = process.env.SHADOW_EMBEDDING_TEST_DATABASE_URL;
const unitVector = `[1,${Array(767).fill(0).join(',')}]`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('app publish RPCs enforce ownership, byte integrity, vectors and atomic queue fencing', { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const owner = randomUUID();
  const stranger = randomUUID();
  const parent = randomUUID();
  const subscription = randomUUID();
  const content = 'hello';
  const chunks = [{ ordinal: 0, core_start: 0, core_end: 5, sha256: sha(content), tokens: 2, vector: unitVector }];
  try {
    await client.query('BEGIN');
    await activateAttestedServing(client);
    await client.query(`DO $block$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
        WHERE i.inhparent='memory_embedding_chunks'::regclass
          AND pg_get_expr(c.relpartbound,c.oid) LIKE '%${QWEN_CONTRACT_ID}%') THEN
        CREATE TABLE memory_embedding_chunks_publish_test PARTITION OF memory_embedding_chunks
          FOR VALUES IN ('${QWEN_CONTRACT_ID}');
      END IF;
    END $block$`);
    await client.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      VALUES($1::uuid,($1::uuid)::text,'publish-owner',ARRAY['personal'],ARRAY['read','write'],'normal'),
            ($2::uuid,($2::uuid)::text,'publish-stranger',ARRAY['personal'],ARRAY['read','write'],'normal')`, [owner, stranger]);
    await client.query(`INSERT INTO memories(id,content,source,namespace,client_id,access_level)
      VALUES($1,$2,'test','personal',$3::text,'normal')`, [parent, content, owner]);
    await client.query(`INSERT INTO memory_subscriptions(id,api_key_id,query_text,query_embedding,
      embedding_provider,embedding_model,embedding_dimensions,threshold,webhook_url_ciphertext,
      webhook_url_iv,webhook_url_tag,signing_secret_ciphertext,signing_secret_iv,signing_secret_tag,
      encryption_key_id,idempotency_key,request_hash)
      VALUES($1,$2,'find hello',$3::vector,'gemini','gemini-embedding-2-preview',768,0.7,
      decode('00','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),decode('00','hex'),
      decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'test','publish-test',repeat('a',64))`,
    [subscription, owner, unitVector]);
    await client.query('INSERT INTO subscription_namespaces(subscription_id,api_key_id,namespace) VALUES($1,$2,$3)',
      [subscription, owner, 'personal']);

    await client.query('SET LOCAL ROLE total_recall_app');
    await client.query("SELECT set_config('app.current_key_id',$1,true),set_config('app.allowed_namespaces',$2,true)",
      [owner, JSON.stringify(['personal'])]);
    const published = await client.query('SELECT publish_local_memory_embedding($1,$2,$3,$4::jsonb) AS ok',
      [parent, QWEN_CONTRACT_ID, sha(content), JSON.stringify(chunks)]);
    assert.equal(published.rows[0].ok, true);
    const subscriptionPublished = await client.query(
      'SELECT publish_local_subscription_embedding($1,$2,$3,$4,$5) AS ok',
      [subscription, QWEN_CONTRACT_ID, sha('find hello'), 3, unitVector]);
    assert.equal(subscriptionPublished.rows[0].ok, true);

    await client.query('SAVEPOINT wrong_hash');
    const stale = await client.query('SELECT publish_local_memory_embedding($1,$2,$3,$4::jsonb) AS ok',
      [parent, QWEN_CONTRACT_ID, '0'.repeat(64), JSON.stringify(chunks)]);
    assert.equal(stale.rows[0].ok, false);
    await client.query('RELEASE SAVEPOINT wrong_hash');

    await client.query('SAVEPOINT corrupt_span');
    const corrupt = [{ ...chunks[0], core_end: 4 }];
    await assert.rejects(client.query('SELECT publish_local_memory_embedding($1,$2,$3,$4::jsonb)',
      [parent, QWEN_CONTRACT_ID, sha(content), JSON.stringify(corrupt)]), /publish_chunk_shape/);
    await client.query('ROLLBACK TO SAVEPOINT corrupt_span');

    await client.query('SAVEPOINT corrupt_vector');
    const badVector = [{ ...chunks[0], vector: `[2,${Array(767).fill(0).join(',')}]` }];
    await assert.rejects(client.query('SELECT publish_local_memory_embedding($1,$2,$3,$4::jsonb)',
      [parent, QWEN_CONTRACT_ID, sha(content), JSON.stringify(badVector)]), /publish_vector|check constraint/);
    await client.query('ROLLBACK TO SAVEPOINT corrupt_vector');

    await client.query("SELECT set_config('app.current_key_id',$1,true)", [stranger]);
    await client.query('SAVEPOINT unauthorized');
    await assert.rejects(client.query('SELECT publish_local_memory_embedding($1,$2,$3,$4::jsonb)',
      [parent, QWEN_CONTRACT_ID, sha(content), JSON.stringify(chunks)]), /publish_unauthorized/);
    await client.query('ROLLBACK TO SAVEPOINT unauthorized');

    await client.query('RESET ROLE');
    const manifest = await client.query(`SELECT f.is_current,f.chunk_count,w.state,w.generation,w.claimed_by,w.lease_until
      FROM memory_embedding_manifests f JOIN embedding_work_items w
        ON w.contract_id=f.contract_id AND w.parent_type='memory' AND w.parent_id=f.parent_id
      WHERE f.contract_id=$1 AND f.parent_id=$2`, [QWEN_CONTRACT_ID, parent]);
    assert.equal(manifest.rows[0].is_current, true);
    assert.equal(manifest.rows[0].chunk_count, 1);
    assert.equal(manifest.rows[0].state, 'complete');
    assert.equal(manifest.rows[0].claimed_by, null);
    assert.equal(manifest.rows[0].lease_until, null);
    assert.ok(Number(manifest.rows[0].generation) >= 2, 'capture claim was fenced by generation increment');
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM memory_embedding_chunks
      WHERE contract_id=$1 AND parent_id=$2`, [QWEN_CONTRACT_ID, parent])).rows[0].n, 1,
    'failed replacement attempts leave the complete chunk set intact');
    const target = await client.query(`SELECT t.source_sha256,w.state,w.source_revision
      FROM subscription_embedding_targets t JOIN embedding_work_items w
        ON w.contract_id=t.contract_id AND w.parent_type='subscription' AND w.parent_id=t.subscription_id
      WHERE t.contract_id=$1 AND t.subscription_id=$2`, [QWEN_CONTRACT_ID, subscription]);
    assert.equal(target.rows[0].source_sha256, sha('find hello'));
    assert.equal(target.rows[0].state, 'complete');
    assert.equal(target.rows[0].source_revision, 0);
    await client.query('ROLLBACK');
  } finally {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    await pool.end();
  }
});
