import { pathToFileURL } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';
import { prepareAllRowMaintenance } from './lib/maintenance-db.js';

dotenv.config();

const CONSTRAINTS = [
  'memories_memory_kind_check',
  'memories_valid_from_present',
  'memories_validity_interval_check',
  'memories_validity_supersession_check',
  'memories_supersedes_not_self',
  'memories_supersedes_id_fkey',
] as const;

const DEFERRED_CONSTRAINTS = [
  `DO $$ BEGIN
     ALTER TABLE public.memories
       ADD CONSTRAINT memories_validity_interval_check
       CHECK (valid_to IS NULL OR (valid_from IS NOT NULL AND valid_to > valid_from)) NOT VALID;
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,
  `DO $$ BEGIN
     ALTER TABLE public.memories
       ADD CONSTRAINT memories_valid_from_present
       CHECK (valid_from IS NOT NULL) NOT VALID;
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,
  `DO $$ BEGIN
     ALTER TABLE public.memories
       ADD CONSTRAINT memories_validity_supersession_check
       CHECK (valid_to IS NOT DISTINCT FROM superseded_at) NOT VALID;
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,
] as const;

export interface ValidityFinalizerClient {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/** Run only after the bounded backfill reports pending=0. No explicit transaction
 * is used: validation and concurrent indexes each receive an autocommit scope. */
export async function finalizeMemoryValidity(client: ValidityFinalizerClient): Promise<void> {
  const preflight = await client.query<{
    missing: string;
    invalid: string;
    mismatched: string;
    duplicatePredecessors: string;
  }>(`
    SELECT
      count(*) FILTER (WHERE valid_from IS NULL)::text AS missing,
      count(*) FILTER (WHERE valid_to IS NOT NULL AND valid_to <= valid_from)::text AS invalid,
      count(*) FILTER (WHERE valid_to IS DISTINCT FROM superseded_at)::text AS mismatched,
      (SELECT count(*)::text
       FROM (
         SELECT supersedes_id
         FROM public.memories
         WHERE supersedes_id IS NOT NULL
         GROUP BY supersedes_id
         HAVING count(*) > 1
       ) duplicates) AS "duplicatePredecessors"
    FROM public.memories
  `);
  const row = preflight.rows[0];
  if (Number(row?.missing ?? 0) > 0 || Number(row?.invalid ?? 0) > 0 ||
      Number(row?.mismatched ?? 0) > 0 || Number(row?.duplicatePredecessors ?? 0) > 0) {
    throw new Error(
      `Validity finalization preflight failed: missing=${row?.missing ?? '0'} ` +
      `invalid=${row?.invalid ?? '0'} mismatched=${row?.mismatched ?? '0'} ` +
      `duplicate_predecessors=${row?.duplicatePredecessors ?? '0'}`,
    );
  }

  await ensureConcurrentIndex(
    client,
    'memories_supersedes_id_unique_idx',
    `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS memories_supersedes_id_unique_idx
       ON public.memories (supersedes_id)`,
    ['create unique index', '(supersedes_id)'],
  );

  for (const sql of DEFERRED_CONSTRAINTS) await client.query(sql);

  for (const constraint of CONSTRAINTS) {
    const state = await client.query<{ exists: boolean; valid: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'public.memories'::regclass AND c.conname = $1
      ) AS exists,
      COALESCE((
        SELECT c.convalidated FROM pg_constraint c
        WHERE c.conrelid = 'public.memories'::regclass AND c.conname = $1
      ), false) AS valid
    `, [constraint]);
    if (!state.rows[0]?.exists) throw new Error(`Validity constraint ${constraint} is missing; run npm run migrate first`);
    if (!state.rows[0].valid) {
      await client.query(`ALTER TABLE public.memories VALIDATE CONSTRAINT ${constraint}`);
    }
  }

  await client.query('ALTER TABLE public.memories ALTER COLUMN valid_from SET NOT NULL');
  await ensureConcurrentIndex(
    client,
    'memories_current_semantic_candidates_idx',
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_current_semantic_candidates_idx
       ON public.memories (namespace, access_level, id)
       WHERE deleted_at IS NULL
         AND superseded_at IS NULL
         AND valid_to IS NULL
         AND memory_kind = 'semantic'`,
    ['(namespace, access_level, id)', 'deleted_at is null', 'superseded_at is null', 'valid_to is null', "memory_kind = 'semantic'"],
  );
  await ensureConcurrentIndex(
    client,
    'memories_validity_range_idx',
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_validity_range_idx
       ON public.memories (namespace, valid_from, valid_to)
       WHERE deleted_at IS NULL`,
    ['(namespace, valid_from, valid_to)', 'deleted_at is null'],
  );
}

async function ensureConcurrentIndex(
  client: ValidityFinalizerClient,
  name: string,
  createSql: string,
  expectedFragments: string[],
): Promise<void> {
  const load = () => client.query<{ valid: boolean; ready: boolean; definition: string }>(`
    SELECT i.indisvalid AS valid, i.indisready AS ready,
           pg_get_indexdef(index_relation.oid) AS definition
    FROM pg_class index_relation
    JOIN pg_index i ON i.indexrelid = index_relation.oid
    JOIN pg_namespace n ON n.oid = index_relation.relnamespace
    WHERE n.nspname = 'public' AND index_relation.relname = $1
  `, [name]);
  const before = await load();
  const existing = before.rows[0];
  if (existing?.valid && existing.ready && !indexDefinitionMatches(existing.definition, expectedFragments)) {
    throw new Error(`Validity index ${name} has an unexpected definition; refusing to replace it`);
  }
  if (existing && (!existing.valid || !existing.ready)) {
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public.${name}`);
  }
  await client.query(createSql);
  const after = (await load()).rows[0];
  if (!after?.valid || !after.ready || !indexDefinitionMatches(after.definition, expectedFragments)) {
    throw new Error(`Validity index ${name} is missing, invalid, not ready, or has an unexpected definition`);
  }
}

function indexDefinitionMatches(definition: string, expectedFragments: string[]): boolean {
  const normalized = definition.toLowerCase().replace(/\s+/g, ' ');
  return expectedFragments.every(fragment => normalized.includes(fragment));
}

async function main(): Promise<void> {
  const connectionString = process.env.MIGRATION_DATABASE_URL?.trim();
  if (!connectionString) throw new Error('MIGRATION_DATABASE_URL is required for validity finalization');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await prepareAllRowMaintenance(client);
    await finalizeMemoryValidity(client);
    console.log('Memory validity finalization complete.');
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Memory validity finalization failed:', error);
    process.exitCode = 1;
  });
}
