import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const load = () => readFile('migrations/037_memory_ingestion_queue.sql', 'utf8');

test('ingestion queue migration creates a content-free job table keyed by memory with a cascading tenant FK', async () => {
  const sql = await load();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.memory_ingestion_jobs \(/);
  assert.match(sql, /memory_id UUID PRIMARY KEY/);
  assert.match(sql, /namespace TEXT NOT NULL/);
  assert.match(sql, /FOREIGN KEY \(namespace, memory_id\) REFERENCES public\.memories\(namespace, id\)\s+ON UPDATE CASCADE ON DELETE CASCADE/);

  // Immutable security/provenance snapshot and embedding target.
  for (const column of [
    /client_id TEXT NOT NULL/,
    /access_level TEXT NOT NULL/,
    /allowed_namespaces TEXT\[\] NOT NULL/,
    /agent_id UUID/,
    /session_id TEXT/,
    /source_key TEXT/,
    /dedupe BOOLEAN NOT NULL/,
    /ttl_seconds BIGINT/,
    /contradiction_eligible BOOLEAN NOT NULL/,
    /embedding_provider TEXT NOT NULL/,
    /embedding_model TEXT NOT NULL/,
    /embedding_dimensions INTEGER NOT NULL/,
  ]) {
    assert.match(sql, column);
  }

  // Columns folded in from the update/document/session follow-ups.
  assert.match(sql, /kind TEXT NOT NULL DEFAULT 'store' CHECK \(kind IN \('store', 'update', 'document'\)\)/);
  assert.match(sql, /source_revision INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /document_id UUID/);
  assert.match(sql, /chunk_index INTEGER/);
  assert.match(sql, /memory_ingestion_jobs_document_idx[\s\S]*\(document_id, status\) WHERE document_id IS NOT NULL/);

  // No payload ever lives on the job row.
  const table = /CREATE TABLE IF NOT EXISTS public\.memory_ingestion_jobs \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? '';
  assert.ok(table.length > 0);
  assert.doesNotMatch(table, /\bcontent\b|\bsummary\b|\btags\b|\bmetadata\b|\btitle\b|VECTOR\(/i);
});

test('ingestion queue migration defines the state machine, failure classes, lease fields and claim indexes', async () => {
  const sql = await load();
  assert.match(sql, /status TEXT NOT NULL DEFAULT 'pending' CHECK \(status IN \(\s*'pending', 'processing', 'retry_wait', 'ready', 'deduplicated', 'embedding_failed', 'cancelled'\s*\)\)/);
  assert.match(sql, /failure_category TEXT CHECK \(failure_category IS NULL OR failure_category IN \(\s*'transient', 'rate_limited', 'provider_auth', 'input_rejected', 'space_mismatch', 'expired'\s*\)\)/);
  assert.match(sql, /attempts INTEGER NOT NULL DEFAULT 0 CHECK \(attempts >= 0\)/);
  assert.match(sql, /next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp\(\)/);
  assert.match(sql, /locked_at TIMESTAMPTZ/);
  assert.match(sql, /lease_expires_at TIMESTAMPTZ/);
  assert.match(sql, /lease_token UUID/);
  assert.match(sql, /last_error_code TEXT CHECK \(last_error_code IS NULL OR last_error_code ~ '\^\[a-z0-9_\.-\]\{1,64\}\$'\)/);
  assert.match(sql, /accepted_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp\(\)/);
  assert.match(sql, /ready_at TIMESTAMPTZ/);
  assert.match(sql, /finalized_at TIMESTAMPTZ/);
  assert.match(sql, /canonical_memory_id UUID/);
  assert.match(sql, /similarity DOUBLE PRECISION/);
  assert.match(sql, /requeued_by TEXT/);
  assert.match(sql, /requeued_at TIMESTAMPTZ/);
  assert.match(sql, /memory_ingestion_jobs_claim_idx ON public\.memory_ingestion_jobs\s+\(next_attempt_at, accepted_at, memory_id\) WHERE status IN \('pending', 'retry_wait', 'processing'\)/);
  assert.match(sql, /memory_ingestion_jobs_owner_idx ON public\.memory_ingestion_jobs \(client_id, status\)/);
});

test('ingestion queue migration enforces owner-or-admin RLS within namespace scope and grants no DELETE', async () => {
  const sql = await load();
  assert.match(sql, /ALTER TABLE public\.memory_ingestion_jobs ENABLE ROW LEVEL SECURITY/);
  const ownerOrAdmin = /\(client_id = public\.app_current_key_id\(\) OR public\.app_current_key_is_admin\(\)\)\s+AND namespace = ANY\(public\.app_allowed_namespaces\(\)\)/;
  const select = /CREATE POLICY memory_ingestion_jobs_owner_select ON public\.memory_ingestion_jobs FOR SELECT\s+USING \(([\s\S]*?)\);/.exec(sql);
  const insert = /CREATE POLICY memory_ingestion_jobs_owner_insert ON public\.memory_ingestion_jobs FOR INSERT\s+WITH CHECK \(([\s\S]*?)\);/.exec(sql);
  const update = /CREATE POLICY memory_ingestion_jobs_owner_update ON public\.memory_ingestion_jobs FOR UPDATE\s+USING \(([\s\S]*?)\)\s+WITH CHECK \(([\s\S]*?)\);/.exec(sql);
  assert.ok(select && insert && update, 'select, insert and update policies exist');
  assert.match(select![1], ownerOrAdmin);
  assert.match(insert![1], ownerOrAdmin);
  assert.match(update![1], ownerOrAdmin);
  assert.match(update![2], ownerOrAdmin);
  assert.doesNotMatch(sql, /CREATE POLICY \w+ ON public\.memory_ingestion_jobs FOR DELETE/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON public\.memory_ingestion_jobs TO total_recall_app;/);
  assert.doesNotMatch(sql, /GRANT[^;]*DELETE[^;]*memory_ingestion_jobs/i);
  assert.doesNotMatch(sql, /GRANT ALL/i);
});

test('ingestion queue migration adds the instance pause switch and worker heartbeat with a column-scoped grant', async () => {
  const sql = await load();
  assert.match(sql, /ALTER TABLE public\.instance_settings\s+ADD COLUMN IF NOT EXISTS ingestion_paused BOOLEAN NOT NULL DEFAULT false,\s+ADD COLUMN IF NOT EXISTS ingestion_worker_seen_at TIMESTAMPTZ;/);
  assert.match(sql, /GRANT UPDATE \(ingestion_paused, ingestion_worker_seen_at\) ON public\.instance_settings TO total_recall_app;/);
  assert.doesNotMatch(sql, /GRANT UPDATE ON public\.instance_settings/);
});

test('ingestion queue migration ships the pending-to-ready subscription trigger disabled with the episode exclusion', async () => {
  const sql = await load();
  assert.match(sql, /DROP TRIGGER IF EXISTS memories_ingestion_subscription_enqueue ON public\.memories;/);
  assert.match(sql, /CREATE TRIGGER memories_ingestion_subscription_enqueue\s+AFTER UPDATE OF embedding ON public\.memories\s+FOR EACH ROW WHEN \(OLD\.embedding IS NULL AND NEW\.embedding IS NOT NULL AND NEW\.memory_kind <> 'episode_chunk'\)\s+EXECUTE FUNCTION public\.enqueue_memory_subscription_webhooks\(\);/);
  assert.match(sql, /ALTER TABLE public\.memories DISABLE TRIGGER memories_ingestion_subscription_enqueue;/);
  assert.doesNotMatch(sql, /ENABLE TRIGGER memories_ingestion_subscription_enqueue/);
  // The 029 insert trigger is left exactly as the operator has it.
  assert.doesNotMatch(sql, /TRIGGER memories_subscription_enqueue\b/);
});

test('ingestion queue migration replaces the enqueue function keeping its body and adding only the update-kind skip', async () => {
  const sql = await load();
  const original = await readFile('migrations/029_memory_subscriptions.sql', 'utf8');
  const extract = (source: string) =>
    /CREATE OR REPLACE FUNCTION public\.enqueue_memory_subscription_webhooks\(\)([\s\S]*?)\n\$\$;/.exec(source)?.[1] ?? '';
  const previous = extract(original);
  const replaced = extract(sql);
  assert.ok(previous.length > 0 && replaced.length > 0);

  assert.match(replaced, /SECURITY DEFINER/);
  assert.match(replaced, /SET search_path = public, pg_temp/);
  assert.match(replaced, /IF EXISTS \(\s*SELECT 1 FROM public\.memory_ingestion_jobs j\s+WHERE j\.memory_id = NEW\.id AND j\.kind = 'update'\s*\) THEN\s+RETURN NEW;\s+END IF;/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.enqueue_memory_subscription_webhooks\(\) FROM PUBLIC;/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.enqueue_memory_subscription_webhooks\(\) FROM total_recall_app;/);

  // Removing the added guard must yield the exact 029 body, so no matching,
  // bounding, or truncation semantics drifted.
  const withoutGuard = replaced.replace(
    /\n\s*IF EXISTS \(\s*SELECT 1 FROM public\.memory_ingestion_jobs j\s+WHERE j\.memory_id = NEW\.id AND j\.kind = 'update'\s*\) THEN\s+RETURN NEW;\s+END IF;\n/,
    '\n',
  );
  assert.equal(withoutGuard, previous);
});

test('ingestion queue migration is additive and never touches memory content or history', async () => {
  const sql = await load();
  assert.doesNotMatch(sql, /https?:\/\//i);
  assert.doesNotMatch(sql, /UPDATE public\.memories\s+SET/i);
  assert.doesNotMatch(sql, /DELETE FROM/i);
  assert.doesNotMatch(sql, /DROP TABLE/i);
  assert.doesNotMatch(sql, /ALTER TABLE public\.memories\s+(ADD|DROP|ALTER) COLUMN/i);
});
