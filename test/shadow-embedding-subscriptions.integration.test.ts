import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {activateAttestedServing} from './shadow-embedding-fixtures.js';
import { QWEN_CHUNK_CONTRACT, QWEN_CONTRACT_ID } from '../src/local-embedding-contract.js';

const url = process.env.SHADOW_EMBEDDING_TEST_DATABASE_URL;
const contractId = QWEN_CONTRACT_ID;
const contract = QWEN_CHUNK_CONTRACT;
const unit = `[1,${Array(767).fill(0).join(',')}]`;

test('target subscription matching is prospective, complete-manifest-only and authorization bounded', { skip: !url }, async () => {
  assert.equal(new URL(url!).pathname, '/total_recall_reembedding_test', 'dedicated test database required');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const db = await pool.connect();
  const key = randomUUID(), revokedKey = randomUUID(), subscription = randomUUID(), revokedSubscription = randomUUID();
  const waitingSubscription = randomUUID();
  const legacyMemory = randomUUID(), targetMemory = randomUUID(), historicalMemory = randomUUID();
  const editedMemory = randomUUID(), sensitiveMemory = randomUUID(), initiallyUnmatchedMemory = randomUUID();
  try {
    await db.query('BEGIN');
    await db.query('ALTER TABLE memories ENABLE TRIGGER memories_subscription_enqueue');
    await db.query('DELETE FROM embedding_serving_settings');
    await db.query(`INSERT INTO embedding_contracts(id,canonical_json,capture_enabled) VALUES($1,$2,true)
      ON CONFLICT(id) DO UPDATE SET capture_enabled=true`, [contractId, JSON.stringify(contract)]);
    await db.query(`DO $block$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
        WHERE i.inhparent='memory_embedding_chunks'::regclass
          AND pg_get_expr(c.relpartbound,c.oid) LIKE '%${contractId}%') THEN
        CREATE TABLE memory_embedding_chunks_qwen_subscription_test PARTITION OF memory_embedding_chunks
          FOR VALUES IN ('${contractId}');
      END IF;
    END $block$`);
    await db.query(`INSERT INTO api_keys(id,key_hash,name,namespaces,permissions,max_access_level)
      VALUES($1::uuid,($1::uuid)::text,'target-subscription',ARRAY['personal'],ARRAY['read','write'],'normal'),
        ($2::uuid,($2::uuid)::text,'revoked-subscription',ARRAY['personal'],ARRAY['read','write'],'normal')`, [key, revokedKey]);
    await db.query('UPDATE api_keys SET revoked_at=statement_timestamp() WHERE id=$1', [revokedKey]);
    for (const [id, owner] of [[subscription, key], [revokedSubscription, revokedKey]]) {
      await db.query(`INSERT INTO memory_subscriptions(id,api_key_id,query_text,query_embedding,
        embedding_provider,embedding_model,embedding_dimensions,threshold,exclude_self,
        webhook_url_ciphertext,webhook_url_iv,webhook_url_tag,signing_secret_ciphertext,
        signing_secret_iv,signing_secret_tag,encryption_key_id,idempotency_key,request_hash,created_at)
        VALUES($1,$2,'target query',$3::vector,'gemini','gemini-embedding-2-preview',768,0.9,false,
          decode('00','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),decode('00','hex'),
          decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'test',($1::uuid)::text,repeat('a',64),clock_timestamp()-interval '1 second')`,
      [id, owner, unit]);
      await db.query('INSERT INTO subscription_namespaces(subscription_id,api_key_id,namespace) VALUES($1,$2,$3)', [id, owner, 'personal']);
    }

    // With no serving row, migration 029's Gemini INSERT behavior remains exact.
    await db.query(`INSERT INTO memories(id,content,embedding,embedding_provider,embedding_model,embedding_dimensions,
      source,namespace,client_id) VALUES($1,'legacy',$2::vector,'gemini','gemini-embedding-2-preview',768,'test','personal','writer')`,
    [legacyMemory, unit]);
    assert.equal((await db.query('SELECT count(*)::int n FROM webhook_deliveries WHERE memory_id=$1', [legacyMemory])).rows[0].n, 2,
      'legacy branch retains migration 029 behavior, including its original key filters');

    // A pre-cutover row has no prospective event and cannot notify during backfill.
    await db.query(`INSERT INTO memories(id,content,source,namespace,client_id) VALUES($1,'historical','test','personal','writer')`, [historicalMemory]);
    await db.query(`INSERT INTO subscription_embedding_targets(contract_id,subscription_id,source_sha256,formatted_tokens,embedding)
      SELECT $1,s.id,encode(digest(s.query_text,'sha256'),'hex'),2,$2::vector FROM memory_subscriptions s WHERE s.id=ANY($3::uuid[])`,
    [contractId, unit, [subscription, revokedSubscription]]);
    await db.query(`INSERT INTO memory_embedding_manifests(contract_id,parent_id,source_sha256,source_revision,source_bytes,chunk_count,total_tokens,is_current)
      SELECT $1,m.id,encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex'),m.revision,octet_length(convert_to(m.content,'UTF8')),1,1,false
      FROM memories m WHERE m.id=ANY($2::uuid[])`,[contractId,[legacyMemory,historicalMemory]]);
    await db.query(`INSERT INTO memory_embedding_chunks(contract_id,parent_id,ordinal,core_start,core_end,chunk_sha256,formatted_tokens,embedding)
      SELECT $1,m.id,0,0,octet_length(convert_to(m.content,'UTF8')),encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex'),1,$2::vector
      FROM memories m WHERE m.id=ANY($3::uuid[])`,[contractId,unit,[legacyMemory,historicalMemory]]);
    await db.query('UPDATE memory_embedding_manifests SET is_current=true WHERE contract_id=$1 AND parent_id=ANY($2::uuid[])',[contractId,[legacyMemory,historicalMemory]]);
    await db.query(`UPDATE embedding_work_items SET state='excluded',error_code='embedding.synthetic_pre_cutover'
      WHERE contract_id=$1 AND state<>'complete'`,[contractId]);
    await activateAttestedServing(db);
    await db.query(`INSERT INTO memory_subscriptions(id,api_key_id,query_text,query_embedding,
      embedding_provider,embedding_model,embedding_dimensions,threshold,exclude_self,
      webhook_url_ciphertext,webhook_url_iv,webhook_url_tag,signing_secret_ciphertext,
      signing_secret_iv,signing_secret_tag,encryption_key_id,idempotency_key,request_hash,created_at)
      VALUES($1,$2,'waiting query',$3::vector,'gemini','gemini-embedding-2-preview',768,0.9,false,
        decode('00','hex'),decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),decode('00','hex'),
        decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),'test',($1::uuid)::text,repeat('b',64),clock_timestamp()-interval '1 second')`,
    [waitingSubscription, key, unit]);
    await db.query("INSERT INTO subscription_namespaces(subscription_id,api_key_id,namespace) VALUES($1,$2,'personal')", [waitingSubscription, key]);

    const publish = async (memoryId: string) => {
      const before = (await db.query('SELECT count(*)::int n FROM webhook_deliveries WHERE memory_id=$1', [memoryId])).rows[0].n;
      await db.query(`INSERT INTO memory_embedding_manifests(contract_id,parent_id,source_sha256,source_revision,source_bytes,chunk_count,total_tokens,is_current)
        SELECT $1,m.id,encode(digest(m.content,'sha256'),'hex'),m.revision,octet_length(m.content),1,2,false FROM memories m WHERE m.id=$2
        ON CONFLICT(contract_id,parent_id) DO UPDATE SET source_sha256=EXCLUDED.source_sha256,
          source_revision=EXCLUDED.source_revision,source_bytes=EXCLUDED.source_bytes,chunk_count=EXCLUDED.chunk_count,
          total_tokens=EXCLUDED.total_tokens,is_current=false`, [contractId, memoryId]);
      await db.query('DELETE FROM memory_embedding_chunks WHERE contract_id=$1 AND parent_id=$2', [contractId, memoryId]);
      await db.query(`INSERT INTO memory_embedding_chunks(contract_id,parent_id,ordinal,core_start,core_end,chunk_sha256,formatted_tokens,embedding)
        SELECT $1,m.id,0,0,octet_length(m.content),encode(digest(m.content,'sha256'),'hex'),2,$3::vector FROM memories m WHERE m.id=$2`,
      [contractId, memoryId, unit]);
      assert.equal((await db.query('SELECT count(*)::int n FROM webhook_deliveries WHERE memory_id=$1', [memoryId])).rows[0].n, before,
        'partial publication does not add a delivery');
      await db.query('UPDATE memory_embedding_manifests SET is_current=true WHERE contract_id=$1 AND parent_id=$2', [contractId, memoryId]);
    };
    await publish(historicalMemory);
    assert.equal((await db.query('SELECT count(*)::int n FROM webhook_deliveries WHERE memory_id=$1', [historicalMemory])).rows[0].n, 0);

    await db.query(`INSERT INTO memories(id,content,source,namespace,client_id,created_at)
      VALUES($1,'target','test','personal','writer',statement_timestamp()-interval '1 year')`, [targetMemory]);
    assert.equal((await db.query('SELECT inserted_at>created_at AS actual_insert_time FROM shadow_subscription_insert_events e JOIN memories m ON m.id=e.memory_id WHERE e.memory_id=$1', [targetMemory])).rows[0].actual_insert_time, true);
    await publish(targetMemory);
    assert.equal((await db.query('SELECT count(*)::int n FROM webhook_deliveries WHERE memory_id=$1', [targetMemory])).rows[0].n, 0,
      'event remains pending until every relevant subscription has a current target');
    assert.equal((await db.query('SELECT processed_at IS NULL AS pending FROM shadow_subscription_insert_events WHERE memory_id=$1', [targetMemory])).rows[0].pending, true);
    await db.query(`INSERT INTO subscription_embedding_targets(contract_id,subscription_id,source_sha256,formatted_tokens,embedding)
      SELECT $1,s.id,encode(digest(s.query_text,'sha256'),'hex'),2,$2::vector FROM memory_subscriptions s WHERE s.id=$3`,
    [contractId, unit, waitingSubscription]);
    assert.equal((await db.query('SELECT count(*)::int n FROM webhook_deliveries WHERE memory_id=$1', [targetMemory])).rows[0].n, 2,
      'target publication retries the pending event; revoked key remains excluded');
    await db.query('UPDATE memory_embedding_manifests SET is_current=false WHERE contract_id=$1 AND parent_id=$2', [contractId, targetMemory]);
    await db.query('UPDATE memory_embedding_manifests SET is_current=true WHERE contract_id=$1 AND parent_id=$2', [contractId, targetMemory]);
    assert.equal((await db.query('SELECT count(*)::int n FROM webhook_deliveries WHERE memory_id=$1', [targetMemory])).rows[0].n, 2, 'reindex is idempotent');

    await db.query(`INSERT INTO memories(id,content,source,namespace,client_id,access_level) VALUES
      ($1,'before edit','test','personal','writer','normal'),($2,'sensitive','test','personal','writer','sensitive')`, [editedMemory, sensitiveMemory]);
    await db.query("UPDATE memories SET content='after edit' WHERE id=$1", [editedMemory]);
    await publish(editedMemory); await publish(sensitiveMemory);
    assert.equal((await db.query('SELECT count(*)::int n FROM webhook_deliveries WHERE memory_id=$1', [editedMemory])).rows[0].n, 2,
      'an edit before asynchronous first indexing uses the first indexed current revision');
    assert.equal((await db.query('SELECT count(*)::int n FROM webhook_deliveries WHERE memory_id=$1', [sensitiveMemory])).rows[0].n, 0,
      'non-normal memory is excluded while its event is still consumed');
    await db.query("UPDATE memories SET content='after notification' WHERE id=$1", [editedMemory]);
    await publish(editedMemory);
    assert.equal((await db.query('SELECT count(*)::int n FROM webhook_deliveries WHERE memory_id=$1', [editedMemory])).rows[0].n, 2,
      'edits after first publication do not create another notification opportunity');

    await db.query(`INSERT INTO memories(id,content,source,namespace,client_id)
      VALUES($1,'initially unmatched','test','unmatched','writer')`, [initiallyUnmatchedMemory]);
    await publish(initiallyUnmatchedMemory);
    assert.equal((await db.query('SELECT count(*)::int n FROM webhook_deliveries WHERE memory_id=$1', [initiallyUnmatchedMemory])).rows[0].n, 0);
    await db.query("UPDATE api_keys SET namespaces=array_append(namespaces,'unmatched') WHERE id=$1", [key]);
    await db.query("INSERT INTO subscription_namespaces(subscription_id,api_key_id,namespace) VALUES($1,$2,'unmatched')", [subscription, key]);
    await db.query("UPDATE memories SET content='now matchable' WHERE id=$1", [initiallyUnmatchedMemory]);
    await publish(initiallyUnmatchedMemory);
    assert.equal((await db.query('SELECT count(*)::int n FROM webhook_deliveries WHERE memory_id=$1', [initiallyUnmatchedMemory])).rows[0].n, 0,
      'a consumed zero-match event cannot be revived by later ACL or source changes');
    const processed = (await db.query(`SELECT processed_at IS NOT NULL AS done,processed_revision
      FROM shadow_subscription_insert_events WHERE memory_id=$1`, [initiallyUnmatchedMemory])).rows[0];
    assert.equal(processed.done, true); assert.equal(processed.processed_revision, 0);

    await db.query('SET LOCAL ROLE total_recall_app');
    assert.equal((await db.query(`SELECT has_table_privilege(current_user,'shadow_subscription_insert_events','SELECT') AS r,
      has_table_privilege(current_user,'shadow_subscription_insert_events','INSERT') AS w`)).rows[0].r, false);
    assert.equal((await db.query(`SELECT has_table_privilege(current_user,'shadow_subscription_insert_events','INSERT') AS w`)).rows[0].w, false);
    await db.query('RESET ROLE');
  } finally {
    try { await db.query('ROLLBACK'); } finally { db.release(); await pool.end(); }
  }
});
