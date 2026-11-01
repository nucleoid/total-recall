import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_INGESTION_MAX_ATTEMPTS,
  DEFAULT_INLINE_EMBED_MS,
  INGESTION_FAILURE_CATEGORIES,
  INGESTION_JOB_STATUSES,
} from '../src/ingestion.js';

// Operator documentation for the durable ingestion queue (#157) must stay in
// step with the code it describes: every state and failure category, every
// environment variable and its default, the worker command, the admin routes,
// the subscription trigger pair, and the runbook steps the issue requires.

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('docs/ingestion-queue.md documents the contract, states, env vars, read paths and keyed semantics', () => {
  const doc = read('docs/ingestion-queue.md');
  for (const status of INGESTION_JOB_STATUSES) assert.match(doc, new RegExp(`\`${status}\``), `state ${status}`);
  for (const category of INGESTION_FAILURE_CATEGORIES) assert.match(doc, new RegExp(`\`${category}\``), `failure category ${category}`);
  assert.match(doc, /MEMORY_INGESTION_QUEUE_ENABLED/);
  assert.match(doc, new RegExp(`MEMORY_STORE_INLINE_EMBED_MS[^\\n]*\\n?[^\\n]*\`${DEFAULT_INLINE_EMBED_MS}\``));
  assert.match(doc, new RegExp(`MEMORY_INGESTION_MAX_ATTEMPTS[^\\n]*\`${DEFAULT_INGESTION_MAX_ATTEMPTS}\``));
  assert.match(doc, /INGESTION_WORKER_API_KEY/);
  assert.match(doc, /INGESTION_WORKER_CONCURRENCY/);
  assert.match(doc, /0[^.]*always async/i);
  assert.match(doc, /npm run ingest:worker -- --concurrency 4/);
  assert.match(doc, /--once --max-jobs 100/);
  assert.match(doc, /`admin` permission/);
  for (const route of ['/api/ingestion/stats', '/api/ingestion/jobs/{memory_id}/requeue', '/api/ingestion/pause', '/api/ingestion/resume']) {
    assert.match(doc, new RegExp(route.replace(/[{}]/g, m => `\\${m}`)), route);
  }
  assert.match(doc, /`admin` \+ `read`/);
  assert.match(doc, /`admin` \+ `write`/);
  assert.match(doc, /409 ingestion_job_state_conflict/);
  assert.match(doc, /404 ingestion_job_not_found/);
  // Visibility per read path, idempotency across states, TTL decision, dedupe redirect, retry curve.
  for (const path of ['memory_recall', 'memory_list', 'Full-text search', 'Semantic ranking', 'Export', 'Subscriptions']) {
    assert.match(doc, new RegExp(path), `read path ${path}`);
  }
  assert.match(doc, /\{ state: 'queued' \}/);
  assert.match(doc, /Idempotency key semantics across states/);
  assert.match(doc, /TTL starts at acceptance/);
  assert.match(doc, /Dedupe redirect/);
  assert.match(doc, /canonical_memory_id/);
  assert.match(doc, /1 m, 5 m, 30 m, 2 h, 12 h/);
  assert.match(doc, /Retry-After/);
  assert.match(doc, /pending to ready transition is the creation event/);
  assert.match(doc, /memories_ingestion_subscription_enqueue/);
  assert.match(doc, /memory\.ingest\.ready/);
  assert.match(doc, /memory\.ingest\.deduplicated/);
  assert.match(doc, /ingestion\.requeue/);
  assert.match(doc, /ingestion\.pause/);
  assert.match(doc, /ingestion\.resume/);
  assert.match(doc, /finalize_error/);
  assert.match(doc, /byte-for-byte unchanged/);
});

test('the migration 037 runbook covers rollout, rollback, draining, backlog recovery, requeue and alert thresholds', () => {
  const runbook = read('docs/rollouts/037-memory-ingestion-queue.md');
  const pattern = read('docs/rollouts/035-activity-connector-foundation.md');
  for (const heading of ['## Before migration', '## Deploy', '## Rollback']) {
    assert.match(pattern, new RegExp(heading), `pattern heading ${heading}`);
    assert.match(runbook, new RegExp(heading), `runbook heading ${heading}`);
  }
  assert.match(runbook, /npm run migrate/);
  assert.match(runbook, /npm run create-key -- --name ingestion-worker[^\n]*--permissions admin/);
  assert.match(runbook, /npm run ingest:worker -- --once --max-jobs 100/);
  assert.match(runbook, /MEMORY_INGESTION_QUEUE_ENABLED=true/);
  assert.match(runbook, /ENABLE TRIGGER memories_subscription_enqueue,\s*ENABLE TRIGGER memories_ingestion_subscription_enqueue/);
  assert.match(runbook, /total-recall-ingestion\.service/);
  assert.match(runbook, /## Capacity alert thresholds/);
  for (const signal of ['worker.last_seen_at', 'worker.paused', 'oldest_pending_age_seconds', 'depth.embedding_failed', 'failure_categories.provider_auth']) {
    assert.match(runbook, new RegExp(signal.replace('.', '\\.')), `alert signal ${signal}`);
  }
  assert.match(runbook, /## Backlog recovery/);
  assert.match(runbook, /## Requeue procedures/);
  assert.match(runbook, /\/api\/ingestion\/jobs\/<memory_id>\/requeue/);
  assert.match(runbook, /npm run reembed/);
  assert.match(runbook, /never loses data/i);
  assert.match(runbook, /Never DELETE job rows/);
});

test('subscriptions, README, dashboard docs and the environment example describe the queue consistently', () => {
  const subscriptions = read('docs/subscriptions.md');
  assert.match(subscriptions, /content updates do not create events; the pending to ready transition is the creation event/);
  assert.match(subscriptions, /memories_subscription_enqueue[\s\S]*memories_ingestion_subscription_enqueue/);
  assert.match(subscriptions, /ENABLE TRIGGER memories_subscription_enqueue, ENABLE TRIGGER memories_ingestion_subscription_enqueue/);
  assert.match(subscriptions, /DISABLE TRIGGER memories_subscription_enqueue, DISABLE TRIGGER memories_ingestion_subscription_enqueue/);
  assert.doesNotMatch(subscriptions, /Updates, deletes, boosts, historical rows/);

  const readme = read('README.md');
  assert.match(readme, /### Durable ingestion queue and migration 037/);
  for (const variable of ['MEMORY_INGESTION_QUEUE_ENABLED', 'MEMORY_STORE_INLINE_EMBED_MS', 'MEMORY_INGESTION_MAX_ATTEMPTS', 'INGESTION_WORKER_API_KEY', 'INGESTION_WORKER_CONCURRENCY']) {
    assert.match(readme, new RegExp(variable), `README env ${variable}`);
  }
  assert.match(readme, /npm run ingest:worker -- --concurrency 4/);
  assert.match(readme, /total-recall-ingestion\.service/);
  for (const route of ['`/api/ingestion/stats`', '`/api/ingestion/jobs/{id}/requeue`', '`/api/ingestion/pause`', '`/api/ingestion/resume`']) {
    assert.match(readme, new RegExp(route.replace(/[{}]/g, m => `\\${m}`)), `README REST ${route}`);
  }
  assert.match(readme, /\/api\/ingestion\/\* \(admin\)/, 'the architecture diagram lists the admin routes');
  assert.match(readme, /### `memory_store`[\s\S]*`state` and `accepted_at`/);
  assert.match(readme, /### `memory_recall`[\s\S]*`ingestion` object/);
  assert.match(readme, /### `memory_stats`[\s\S]*`ingestion` block/);
  assert.match(readme, /docs\/ingestion-queue\.md/);
  assert.match(readme, /docs\/rollouts\/037-memory-ingestion-queue\.md/);

  const env = read('.env.example');
  assert.match(env, /^MEMORY_INGESTION_QUEUE_ENABLED=false$/m);
  assert.match(env, /MEMORY_STORE_INLINE_EMBED_MS=3000/);
  assert.match(env, /MEMORY_INGESTION_MAX_ATTEMPTS=12/);
  assert.match(env, /INGESTION_WORKER_API_KEY/);

  const dashboard = read('docs/dashboard.md');
  assert.match(dashboard, /Ingestion queue/);
  assert.match(dashboard, /Requeue embedding/);
});

test('the memory_store tool description mentions state and accepted_at', () => {
  const register = read('src/tools/register.ts');
  const start = register.indexOf("name: 'memory_store',");
  const end = register.indexOf('inputSchema', start);
  const description = register.slice(start, end);
  assert.match(description, /reports state and accepted_at/);
  assert.match(description, /"ready"/);
  assert.match(description, /"queued"/);
});
