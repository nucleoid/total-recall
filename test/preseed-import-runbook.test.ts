import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('preseed runbook distinguishes app and owner credentials and documents Claude/OpenClaw setup', async () => {
  const [env, readme, spec, claude, openclaw] = await Promise.all([
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../SPEC.md', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/preseed-claude.ts', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/preseed-openclaw.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(env, /DATABASE_URL=postgresql:\/\/total_recall_app:/);
  assert.match(env, /MIGRATION_DATABASE_URL=postgresql:\/\/<owner-role>:/);
  for (const variable of ['CLAUDE_IMPORTS_DIR', 'OPENCLAW_WORKSPACE', 'OPENCLAW_CORTEX_CONTENT', 'OPENCLAW_SECOND_BRAIN']) {
    assert.match(env, new RegExp(variable));
    assert.match(readme, new RegExp(variable));
  }
  for (const text of [readme, spec]) {
    assert.match(text, /preseed[\s\S]*(?:superuser|BYPASSRLS)[\s\S]*(?:owner|memories)/i);
    assert.match(text, /(?:transaction-local[\s\S]{0,120}allowed_namespaces|allowed_namespaces[\s\S]{0,120}transaction(?:-local|ally))/i);
    assert.match(text, /empty Claude[\s\S]{0,160}(?:zero|successful)/i);
  }
  assert.match(readme, /--memory-timestamp[\s\S]{0,250}takes precedence[\s\S]{0,250}mtime/i);
  for (const source of [claude, openclaw]) {
    assert.match(source, /requireEmbeddingIdentityWriter\(\)[\s\S]*execute\w+Import/);
    assert.doesNotMatch(source, /^const pool\s*=\s*new pg\.Pool/gm, 'pool must not be created at module load');
  }
});
