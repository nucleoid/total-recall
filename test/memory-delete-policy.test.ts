import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

test('fresh installs require a pre-provisioned app role and contain no committed app password or database assumption', () => {
  const rls = migration('003_rls.sql');
  const trackedProductionFiles = [
    new URL('../migrations/003_rls.sql', import.meta.url),
    new URL('../.env.example', import.meta.url),
    new URL('../README.md', import.meta.url),
    new URL('../CONNECT.md', import.meta.url),
    new URL('../SPEC.md', import.meta.url),
  ].map(file => readFileSync(file, 'utf8'));

  assert.doesNotMatch(rls, /CREATE\s+ROLE/i);
  assert.doesNotMatch(rls, /PASSWORD/i);
  assert.doesNotMatch(rls, /GRANT\s+CONNECT\s+ON\s+DATABASE\s+total_recall\b/i);
  for (const contents of trackedProductionFiles) {
    assert.doesNotMatch(contents, /total_recall_app_dev/);
  }
});

test('the next forward migration idempotently grants namespace-scoped memory DELETE', () => {
  const files = readdirSync(new URL('../migrations', import.meta.url));
  assert.ok(files.includes('020_memory_delete_policy.sql'));
  const sql = migration('020_memory_delete_policy.sql');

  assert.match(sql, /GRANT\s+DELETE\s+ON\s+(?:TABLE\s+)?memories\s+TO\s+total_recall_app/i);
  assert.match(sql, /DROP\s+POLICY\s+IF\s+EXISTS\s+namespace_delete\s+ON\s+memories/i);
  assert.match(sql, /CREATE\s+POLICY\s+namespace_delete\s+ON\s+memories\s+FOR\s+DELETE/i);
  assert.match(sql, /USING\s*\(\s*namespace\s*=\s*ANY\s*\(\s*app_allowed_namespaces\(\)\s*\)\s*\)/i);
});

test('DELETE capability does not register a public forget operation', () => {
  assert.equal(existsSync(new URL('../src/tools/forget.ts', import.meta.url)), false);
  for (const file of ['../src/index.ts', '../src/server.ts', '../openapi.yaml']) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /memory_forget|\/api\/forget/i);
  }
});

test('migration checksums are platform-stable and the standing DELETE capability is explicit', () => {
  const attributes = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(attributes, /^migrations\/\*\.sql text eol=lf$/m);
  assert.match(readme, /holds (?:a )?live DELETE.*ahead of.*#51/is);
});
