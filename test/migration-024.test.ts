import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../migrations/024_memory_lifecycle.sql', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const finalizer = readFileSync(new URL('../scripts/memory-lifecycle-finalizer.ts', import.meta.url), 'utf8');
const commandScript = readFileSync(new URL('../scripts/finalize-memory-lifecycle.ts', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const spec = readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8');
const readmeLifecycle = readme.match(/### Memory lifecycle rollout and rollback[\s\S]*?(?=\n## )/)?.[0];
const specLifecycle = spec.match(/### Memory lifecycle rollout and rollback[\s\S]*?(?=\nMigration `009_)/)?.[0];

test('migration 024 adds named constraints NOT VALID and performs no scans or index builds', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS deleted_by_client_id UUID(?!\s+REFERENCES)/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS deletion_reason TEXT/i);
  assert.match(
    migration,
    /ADD CONSTRAINT memories_deleted_by_client_id_fkey\s+FOREIGN KEY \(deleted_by_client_id\)\s+REFERENCES public\.api_keys\(id\)\s+ON DELETE SET NULL\s+NOT VALID/is
  );
  assert.match(
    migration,
    /ADD CONSTRAINT memories_deletion_reason_length\s+CHECK \(deletion_reason IS NULL OR char_length\(deletion_reason\) <= 512\)\s+NOT VALID/is
  );
  assert.doesNotMatch(migration, /VALIDATE\s+CONSTRAINT/i);
  assert.doesNotMatch(migration, /CREATE\s+(?:UNIQUE\s+)?INDEX/i);
  assert.doesNotMatch(migration, /CONCURRENTLY/i);
});

test('memory lifecycle has a separate resumable autocommit finalizer', () => {
  assert.equal(
    packageJson.scripts['finalize:memory-lifecycle'],
    'tsx scripts/finalize-memory-lifecycle.ts'
  );
  assert.equal(packageJson.scripts['index:memory-lifecycle'], undefined);
  assert.match(commandScript, /process\.env\.MIGRATION_DATABASE_URL/);
  assert.doesNotMatch(commandScript, /process\.env\.DATABASE_URL/);
  assert.match(finalizer, /ALTER TABLE public\.memories VALIDATE CONSTRAINT \$\{definition\.name\}/i);
  assert.match(finalizer, /pg_constraint/i);
  assert.match(finalizer, /convalidated/i);
  assert.match(finalizer, /pg_get_constraintdef/i);
  assert.doesNotMatch(finalizer, /client\.query\(['"]BEGIN/i);
  assert.match(finalizer, /pg_index/i);
  assert.match(finalizer, /indisvalid/i);
  assert.match(finalizer, /pg_get_indexdef/i);
  assert.match(finalizer, /unexpected definition/i);
  assert.match(finalizer, /DROP INDEX CONCURRENTLY IF EXISTS public\.\$\{definition\.name\}/i);
  assert.match(finalizer, /CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_active_namespace_created_idx/i);
  assert.match(finalizer, /ON public\.memories \(namespace, created_at DESC\)/i);
  assert.match(finalizer, /WHERE deleted_at IS NULL/i);
  assert.match(finalizer, /CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_deleted_purge_idx/i);
  assert.match(finalizer, /ON public\.memories \(deleted_at, id\)/i);
  assert.match(finalizer, /WHERE deleted_at IS NOT NULL/i);
});

test('memory lifecycle rollout and rollback ordering is explicit in operator docs', () => {
  assert.ok(readmeLifecycle, 'README memory lifecycle rollout section is missing');
  assert.ok(specLifecycle, 'SPEC memory lifecycle rollout section is missing');
  for (const document of [readmeLifecycle, specLifecycle]) {
    assert.match(document, /memory lifecycle rollout/i);
    assert.match(
      document,
      /npm run migrate[\s\S]+npm run finalize:memory-lifecycle[\s\S]+tombstone-aware[\s\S]+enabl(?:e|ing) (?:memory )?(?:delete|deletion)/i
    );
    assert.match(document, /NOT VALID[\s\S]+VALIDATE CONSTRAINT/i);
    assert.match(document, /separate autocommit/i);
    assert.match(document, /disable[^.\n]*(?:forget|deletion)[^.\n]*purge[^.\n]*first/i);
    assert.match(document, /tombstones exist[\s\S]{0,300}roll-forward-only/i);
  }
});
