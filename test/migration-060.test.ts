import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import test from 'node:test';
const sql=readFileSync(new URL('../migrations/060_scoped_contradiction_resolution.sql',import.meta.url),'utf8');
test('reviewed contradiction migration has narrow reversible source authority',()=>{
 assert.match(sql,/app_contradiction_resolve_scope_allowed[\s\S]*revoked_at IS NULL[\s\S]*expires_at/);
 assert.match(sql,/namespace_update[\s\S]*NOT public\.app_current_key_has_permission\('contradiction_resolve'\)/);
 assert.match(sql,/contradiction_resolution_source_lock[\s\S]*WITH CHECK\(false\)/);
 assert.match(sql,/apply_reviewed_contradiction_resolution[\s\S]*m\.revision[\s\S]*md5\(m\.content\)/);
 assert.match(sql,/reverse_reviewed_contradiction_resolution[\s\S]*status='reversed'[\s\S]*reversal_memory_id/);
 assert.doesNotMatch(sql,/GRANT\s+(?:INSERT|UPDATE|DELETE)\s+ON\s+public\.memories/i);
});
