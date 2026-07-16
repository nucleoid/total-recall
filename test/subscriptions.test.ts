import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { agentListSubscriptionsSchema, agentSubscribeSchema, agentUnsubscribeSchema } from '../src/tools/subscriptions.js';

test('subscription MCP lifecycle schemas are strict and bounded', () => {
  const parsed = agentSubscribeSchema.parse({
    query: 'deployment decisions', webhook_url: 'https://hooks.example.com/recall', idempotency_key: 'create-1',
  });
  assert.equal(parsed.threshold, 0.75);
  assert.equal(parsed.exclude_self, true);
  assert.throws(() => agentSubscribeSchema.parse({ ...parsed, extra: true }), /unrecognized/i);
  assert.throws(() => agentSubscribeSchema.parse({ ...parsed, threshold: 1.1 }));
  assert.throws(() => agentListSubscriptionsSchema.parse({ status: 'active' }), /unrecognized/i);
  assert.throws(() => agentUnsubscribeSchema.parse({ id: 'not-a-uuid' }));
});

test('migration implements prospective bounded same-model normal-only outbox matching', () => {
  const sql = readFileSync(new URL('../migrations/029_memory_subscriptions.sql', import.meta.url), 'utf8');
  assert.match(sql, /AFTER INSERT ON public\.memories/);
  assert.match(sql, /COALESCE\(NEW\.access_level, 'normal'\) <> 'normal'/);
  assert.match(sql, /s\.embedding_provider = NEW\.embedding_provider/);
  assert.match(sql, /ORDER BY similarity DESC, s\.id\s+LIMIT 101/);
  assert.match(sql, /ALTER TABLE public\.memories DISABLE TRIGGER memories_subscription_enqueue/);
  assert.doesNotMatch(sql, /memory_id UUID[^,\n]*REFERENCES public\.memories/);
  assert.match(sql, /UNIQUE \(subscription_id, memory_id, event_version\)/);
  assert.match(sql, /SECURITY DEFINER\s+SET search_path = public, pg_temp/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.enqueue_memory_subscription_webhooks\(\) FROM PUBLIC/);
  assert.doesNotMatch(sql, /https?:\/\//i);
});

test('public tool schemas and Zod agree on required lifecycle fields', () => {
  const register = readFileSync(new URL('../src/tools/register.ts', import.meta.url), 'utf8');
  for (const name of ['agent_subscribe', 'agent_list_subscriptions', 'agent_unsubscribe']) {
    assert.match(register, new RegExp(`name: '${name}'`));
    assert.match(register, new RegExp(`case '${name}'`));
  }
  assert.match(register, /required: \['query', 'webhook_url', 'idempotency_key'\]/);
  assert.match(register, /additionalProperties: false/);
});
