-- Execute only in an isolated cluster; this script never targets production.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'total_recall_reembedding_test' THEN RAISE EXCEPTION 'wrong test database'; END IF;
END $$;
CREATE FUNCTION pg_temp.assert_true(ok BOOLEAN, label TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %',label; END IF; END $$;

INSERT INTO embedding_contracts(id,canonical_json) VALUES(encode(digest('{"test":1}','sha256'),'hex'),'{"test":1}');
INSERT INTO memories(id,content,source,namespace,client_id) VALUES
('00000000-0000-4000-8000-000000000001','original','schema-test','personal','test'),
('00000000-0000-4000-8000-000000000002','private','schema-test','work','test');
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM embedding_work_items),'capture is disabled by default');
UPDATE embedding_contracts SET capture_enabled=true;
UPDATE memories SET content='changed' WHERE source='schema-test';
SELECT pg_temp.assert_true((SELECT count(*)=2 FROM embedding_work_items),'all writers captured');
UPDATE embedding_work_items SET state='claimed',claimed_by='00000000-0000-4000-8000-000000000003',lease_until=now()+interval '1 minute';
UPDATE memories SET content='newer' WHERE id='00000000-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true((SELECT state='pending' AND generation=2 AND claimed_by IS NULL AND lease_until IS NULL
  FROM embedding_work_items WHERE parent_id='00000000-0000-4000-8000-000000000001'),'edit fences old worker');

UPDATE memories SET valid_from=now()+interval '1 day' WHERE id='00000000-0000-4000-8000-000000000002';
SELECT pg_temp.assert_true((SELECT state='pending' AND generation=2
  FROM embedding_work_items WHERE parent_id='00000000-0000-4000-8000-000000000002'),'future lifecycle change remains queued');

-- Actual fixture contract has its own physical partition.
DO $$ DECLARE profile TEXT; BEGIN
  SELECT id INTO profile FROM embedding_contracts;
  EXECUTE format('CREATE TABLE memory_embedding_chunks_fixture PARTITION OF memory_embedding_chunks FOR VALUES IN (%L)',profile);
END $$;
INSERT INTO memory_embedding_manifests(contract_id,parent_id,source_sha256,source_revision,source_bytes,chunk_count,total_tokens,is_current)
SELECT c.id,m.id,encode(digest(m.content,'sha256'),'hex'),m.revision,octet_length(m.content),1,1,false
FROM embedding_contracts c CROSS JOIN memories m WHERE m.source='schema-test';
INSERT INTO memory_embedding_chunks(contract_id,parent_id,ordinal,core_start,core_end,chunk_sha256,formatted_tokens,embedding)
SELECT contract_id,parent_id,0,0,source_bytes,source_sha256,1,
  ('[' || array_to_string(array_fill((1.0/sqrt(768))::real,ARRAY[768]),',') || ']')::vector
FROM memory_embedding_manifests;
UPDATE memory_embedding_manifests SET is_current=true;
UPDATE memories SET content='latest' WHERE id='00000000-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true((SELECT NOT is_current FROM memory_embedding_manifests
  WHERE parent_id='00000000-0000-4000-8000-000000000001'),'edit invalidates complete manifest');
UPDATE memory_embedding_chunks c SET core_end=octet_length(convert_to(m.content,'UTF8')),
  chunk_sha256=encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex') FROM memories m WHERE c.parent_id=m.id AND m.id='00000000-0000-4000-8000-000000000001';
UPDATE memory_embedding_manifests f SET source_revision=m.revision,source_sha256=encode(digest(convert_to(m.content,'UTF8'),'sha256'),'hex'),
  source_bytes=octet_length(convert_to(m.content,'UTF8')),is_current=true,committed_at=statement_timestamp()
FROM memories m WHERE f.parent_id=m.id AND m.id='00000000-0000-4000-8000-000000000001';

CREATE INDEX memory_embedding_chunks_fixture_hnsw ON memory_embedding_chunks_fixture USING hnsw(embedding vector_cosine_ops);
UPDATE embedding_work_items SET state='excluded',error_code='embedding.synthetic_pre_cutover';
INSERT INTO embedding_runs(id,contract_id,release_sha,manifest,status,inventory_complete,source_watermark)
SELECT '00000000-0000-4000-8000-000000000099',id,repeat('a',40),'{}','paused',true,statement_timestamp() FROM embedding_contracts;
INSERT INTO embedding_cutover_attestations(run_id,contract_id,watermark,memory_census,subscription_census,
  audit_receipt_sha256,quality_receipt_sha256,backup_receipt_sha256,approval_sha256)
SELECT '00000000-0000-4000-8000-000000000099',id,statement_timestamp(),
  (SELECT count(*) FROM memories m WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.consolidated_into_id IS NULL
    AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp()) AND (m.valid_from IS NULL OR m.valid_from<=statement_timestamp())
    AND (m.valid_to IS NULL OR m.valid_to>statement_timestamp())),
  (SELECT count(*) FROM memory_subscriptions s JOIN api_keys k ON k.id=s.api_key_id
    WHERE s.status='active' AND k.enabled AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at>statement_timestamp())),repeat('b',64),repeat('c',64),repeat('d',64),repeat('e',64)
FROM embedding_contracts;
INSERT INTO embedding_serving_settings(contract_id,cutover_attestation_run_id,rollback_writes_enabled,rollback_inputs_per_minute,rollback_until)
SELECT id,'00000000-0000-4000-8000-000000000099',true,3,statement_timestamp()+interval '1 hour' FROM embedding_contracts;

SET LOCAL ROLE total_recall_app;
SELECT set_config('app.allowed_namespaces','["personal"]',true);
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM memory_embedding_chunks),'current authorized chunks are visible');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM memory_embedding_manifests),'current authorized manifest is visible');
SELECT set_config('app.allowed_namespaces','["work"]',true);
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM memory_embedding_chunks),'future parent is invisible');
RESET ROLE;

UPDATE memories SET valid_from=statement_timestamp()-interval '1 second'
WHERE id='00000000-0000-4000-8000-000000000002';
UPDATE memory_embedding_manifests f SET source_revision=m.revision,source_sha256=encode(digest(m.content,'sha256'),'hex'),
  source_bytes=octet_length(m.content),is_current=true,committed_at=statement_timestamp()
FROM memories m WHERE f.parent_id=m.id AND m.id='00000000-0000-4000-8000-000000000002';

SET LOCAL ROLE total_recall_app;
SELECT set_config('app.allowed_namespaces','["work"]',true);
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM memory_embedding_chunks),'current authorized complete parent is visible');
SELECT pg_temp.assert_true(NOT has_table_privilege(current_user,'embedding_work_items','SELECT'),'runtime cannot inspect cross-tenant queue');
SELECT pg_temp.assert_true(NOT has_table_privilege(current_user,'memory_embedding_chunks','INSERT'),'runtime cannot forge chunk vectors');
DO $$ BEGIN
  IF NOT public.reserve_embedding_rollback_inputs(2)
    OR public.reserve_embedding_rollback_inputs(2)
    OR NOT public.reserve_embedding_rollback_inputs(1) THEN
    RAISE EXCEPTION 'rollback reservation cap was not enforced';
  END IF;
END $$;
SELECT pg_temp.assert_true(NOT has_table_privilege(current_user,'embedding_rollback_usage','SELECT'),
  'runtime cannot inspect rollback usage');
SELECT pg_temp.assert_true(NOT has_table_privilege(current_user,'embedding_rollback_usage','INSERT'),
  'runtime cannot forge rollback usage');
SELECT pg_temp.assert_true(NOT has_table_privilege(current_user,'embedding_serving_settings','UPDATE'),
  'runtime cannot mutate serving settings');
RESET ROLE;

UPDATE embedding_serving_settings SET rollback_until=statement_timestamp()-interval '1 second';
SET LOCAL ROLE total_recall_app;
SELECT pg_temp.assert_true(NOT reserve_embedding_rollback_inputs(1),'expired rollback window rejects reservations');
RESET ROLE;

DO $$ BEGIN
  BEGIN
    UPDATE embedding_contracts SET capture_enabled=false;
    RAISE EXCEPTION 'active serving contract capture unexpectedly disabled';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE embedding_contracts SET canonical_json='{"changed":2}';
    RAISE EXCEPTION 'identity update unexpectedly accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'embedding.immutable_contract' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
