import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../migrations/025_memory_supersession.sql', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const finalizer = readFileSync(new URL('../scripts/memory-supersession-finalizer.ts', import.meta.url), 'utf8');
const commandScript = readFileSync(new URL('../scripts/finalize-memory-supersession.ts', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const spec = readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8');
const readmeRollout = readme.match(/### Memory supersession rollout and rollback[\s\S]*?(?=\n## )/)?.[0];
const specRollout = spec.match(/### Memory supersession rollout and rollback[\s\S]*?(?=\nMigration `009_)/)?.[0];

test('migration 025 is additive and performs no validation scans or index builds', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS supersedes_id UUID/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0/i);
  assert.match(
    migration,
    /ADD CONSTRAINT memories_supersedes_not_self\s+CHECK \(supersedes_id IS NULL OR supersedes_id <> id\)\s+NOT VALID/is,
  );
  assert.match(
    migration,
    /ADD CONSTRAINT memories_supersedes_id_fkey\s+FOREIGN KEY \(supersedes_id\)\s+REFERENCES public\.memories\(id\)\s+ON DELETE RESTRICT\s+NOT VALID/is,
  );
  assert.doesNotMatch(migration, /VALIDATE\s+CONSTRAINT/i);
  assert.doesNotMatch(migration, /CREATE\s+(?:UNIQUE\s+)?INDEX/i);
  assert.doesNotMatch(migration, /CONCURRENTLY/i);
});

test('memory supersession has a separate resumable autocommit finalizer', () => {
  assert.equal(
    packageJson.scripts['finalize:memory-supersession'],
    'tsx scripts/finalize-memory-supersession.ts',
  );
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
  assert.match(finalizer, /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS memories_supersedes_id_unique/i);
  assert.match(finalizer, /ON public\.memories \(supersedes_id\)/i);
  assert.match(finalizer, /CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_superseded_at_idx/i);
  assert.match(finalizer, /ON public\.memories \(superseded_at\)/i);
  assert.match(finalizer, /WHERE superseded_at IS NOT NULL/i);
});

test('memory supersession rollout and rollback ordering is explicit in operator docs', () => {
  assert.ok(readmeRollout, 'README memory supersession rollout section is missing');
  assert.ok(specRollout, 'SPEC memory supersession rollout section is missing');
  for (const document of [readmeRollout, specRollout]) {
    assert.match(
      document,
      /npm run migrate[\s\S]+npm run finalize:memory-supersession[\s\S]+allValid[\s\S]+deploy[\s\S]+enabl(?:e|ing) `?memory_update`?/i,
    );
    assert.match(document, /NOT VALID[\s\S]+VALIDATE CONSTRAINT/i);
    assert.match(document, /CREATE UNIQUE INDEX CONCURRENTLY/i);
    assert.match(document, /invalid[^.\n]*index[^.\n]*retry/i);
    assert.match(document, /disable[^.\n]*memory_update[^.\n]*first/i);
  }
});
