import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../migrations/017_document_idempotency.sql', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const indexScript = readFileSync(new URL('../scripts/document-idempotency-index.ts', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('migration 017 is additive and leaves the unique index to an online operation', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES api_keys\(id\)/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS idempotency_key TEXT/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS request_hash TEXT/i);
  assert.match(migration, /CHECK\s*\(request_hash IS NULL OR request_hash ~ '\^sha256:v1:\[0-9a-f\]\{64\}\$'\)/i);
  assert.doesNotMatch(migration, /NOT VALID/i);
  assert.doesNotMatch(migration, /VALIDATE CONSTRAINT documents_request_hash_format_chk/i);
  assert.doesNotMatch(migration, /CREATE\s+(?:UNIQUE\s+)?INDEX/i);
  assert.doesNotMatch(migration, /CONCURRENTLY/i);
});

test('document idempotency index has a separate resumable concurrent operation', () => {
  assert.equal(
    packageJson.scripts['index:document-idempotency'],
    'tsx scripts/create-document-idempotency-index.ts'
  );
  assert.match(indexScript, /pg_index/i);
  assert.match(indexScript, /indisvalid/i);
  assert.match(indexScript, /DROP INDEX CONCURRENTLY IF EXISTS public\.documents_client_namespace_idempotency_key_idx/i);
  assert.match(indexScript, /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS documents_client_namespace_idempotency_key_idx/i);
  assert.match(indexScript, /ON public\.documents \(client_id, namespace, idempotency_key\)/i);
  assert.match(indexScript, /WHERE client_id IS NOT NULL AND idempotency_key IS NOT NULL/i);
});

test('rollout docs require migration, online index, then runtime deployment', () => {
  assert.match(readme, /document idempotency rollout/i);
  assert.match(readme, /npm run migrate[\s\S]+npm run index:document-idempotency[\s\S]+deploy/i);
  assert.match(readme, /CREATE UNIQUE INDEX CONCURRENTLY/i);
});
