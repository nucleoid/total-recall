import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sessionStatusSchema, storeSessionSchema } from '../src/session-distillation.js';

test('session MCP schemas and manual tool definitions stay strict and aligned', () => {
  assert.equal(storeSessionSchema.parse({ transcript: 'x' }).namespace, 'shared');
  assert.throws(() => storeSessionSchema.parse({ transcript: 'x', metadata: { transcript: 'leak' } }), /unrecognized/i);
  assert.throws(() => sessionStatusSchema.parse({ episode_id: 'not-a-uuid' }));
  assert.throws(() => sessionStatusSchema.parse({ episode_id: '00000000-0000-4000-8000-000000000001', extra: true }), /unrecognized/i);

  const register = readFileSync(new URL('../src/tools/register.ts', import.meta.url), 'utf8');
  for (const name of ['memory_store_session', 'memory_session_status']) {
    assert.match(register, new RegExp(`name: '${name}'`));
    assert.match(register, new RegExp(`case '${name}'`));
  }
  assert.match(register, /required: \['transcript'\]/);
  assert.match(register, /required: \['episode_id'\]/);
  assert.match(register, /additionalProperties: false/);
});

test('session generation can be disabled without disabling episode retention in the schema', () => {
  const runbook = readFileSync(new URL('../docs/session-distillation.md', import.meta.url), 'utf8');
  assert.match(runbook, /does \*\*not\*\* enable generation/);
  assert.match(runbook, /MEMORY_SESSION_TOOLS_ENABLED=false/);
  assert.match(runbook, /one approved namespace and `normal` access/);
});
