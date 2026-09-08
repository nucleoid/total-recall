import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  assertMigrationAuthority,
  loadMigrationInventory,
  MIGRATION_LOCK_KEY_1,
  MIGRATION_LOCK_KEY_2,
  resolveMigrationDatabaseUrl,
  type MigrationFile,
} from './migrate.js';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPECTED_RELEASE_CHECKSUMS: Readonly<Record<string, string>> = {
  '001_initial': '2a8b95185d2570d1de7db5a30dadfa0501060954bf0dd8be3c460be351b96ec4',
  '002_documents_and_sync': '8d0baabc985183e2e5a8bcd12d2a3456f52e65b9058fc997b94abb860bd090cc',
  '003_rls': '83a8702f2334a412108cd9fe8139c21fc656a588479cef6e681b7689b6ecef22',
  '004_audit': '1fa37fa59d4ed982747e18607e1b288a9b1d4c0026bc5ff4f79f4c6c94939d30',
  '005_agent_provenance_and_traces': '093ac83976955b6dc1560dfe3d06857f909173cb8e35979a637c3595f7677719',
  '006_media_events': '0ba2284b3af20655a8d24d32fad0d5230a97bd13c1cb132ef659d61442a8f870',
};
const LEGACY_LEDGER = ['001_initial', '006_media_events'] as const;

export type LegacyLedgerReconcileOptions = {
  apply: boolean;
  backupConfirmed: boolean;
};

export type LegacyLedgerReconcileResult = {
  mode: 'preview' | 'applied';
  added: string[];
};

function assertReviewedInventory(inventory: MigrationFile[]): MigrationFile[] {
  const early = inventory.filter(migration => migration.number <= 6);
  const expectedVersions = Object.keys(EXPECTED_RELEASE_CHECKSUMS);
  if (JSON.stringify(early.map(migration => migration.version)) !== JSON.stringify(expectedVersions)) {
    throw new Error('Legacy ledger reconciliation supports only the reviewed 001-006 migration inventory');
  }
  for (const migration of early) {
    if (migration.checksum !== EXPECTED_RELEASE_CHECKSUMS[migration.version]) {
      throw new Error(`Reviewed migration file checksum mismatch for ${migration.version}`);
    }
  }
  return early;
}

async function assertLegacyLedgerShape(client: pg.Client): Promise<void> {
  const columns = await client.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'schema_migrations'
    ORDER BY ordinal_position
  `);
  if (JSON.stringify(columns.rows.map(row => row.column_name)) !== JSON.stringify(['version', 'applied_at'])) {
    throw new Error('Legacy ledger shape is not the reviewed version/applied_at-only layout');
  }
  const rows = await client.query<{ version: string }>('SELECT version FROM public.schema_migrations ORDER BY version');
  if (JSON.stringify(rows.rows.map(row => row.version)) !== JSON.stringify(LEGACY_LEDGER)) {
    throw new Error('Legacy ledger rows are not exactly 001_initial and 006_media_events');
  }
}

async function missingSchemaProofs(client: pg.Client): Promise<string[]> {
  const result = await client.query<{ proof: string }>(`
    WITH proofs(proof, ok) AS (VALUES
      ('required relations',
        to_regclass('public.documents') IS NOT NULL
        AND to_regclass('public.sync_state') IS NOT NULL
        AND to_regclass('public.audit_log') IS NOT NULL
        AND to_regclass('public.agents') IS NOT NULL
        AND to_regclass('public.recall_traces') IS NOT NULL),
      ('002 columns',
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='memories' AND column_name='document_id')
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='memories' AND column_name='chunk_index')
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='memories' AND column_name='source_key')),
      ('004 audit columns',
        (SELECT count(*) = 8 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='audit_log'
           AND column_name = ANY(ARRAY['id','client_id','action','namespace','memory_id','query_text','result_count','created_at']))),
      ('005 provenance columns',
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='memories' AND column_name='agent_id')
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='memories' AND column_name='session_id')
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_log' AND column_name='agent_id')
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_log' AND column_name='session_id')),
      ('required indexes',
        to_regclass('public.memories_document_id_idx') IS NOT NULL
        AND to_regclass('public.memories_source_key_idx') IS NOT NULL
        AND to_regclass('public.audit_log_client_idx') IS NOT NULL
        AND to_regclass('public.audit_log_action_idx') IS NOT NULL
        AND to_regclass('public.audit_log_created_idx') IS NOT NULL
        AND to_regclass('public.idx_agents_name') IS NOT NULL
        AND to_regclass('public.idx_agents_api_key') IS NOT NULL
        AND to_regclass('public.idx_memories_agent') IS NOT NULL
        AND to_regclass('public.idx_memories_session') IS NOT NULL
        AND to_regclass('public.idx_audit_agent') IS NOT NULL
        AND to_regclass('public.idx_audit_session') IS NOT NULL
        AND to_regclass('public.idx_recall_traces_agent') IS NOT NULL
        AND to_regclass('public.idx_recall_traces_session') IS NOT NULL
        AND to_regclass('public.idx_recall_traces_created') IS NOT NULL),
      ('source-key uniqueness',
        EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid='public.memories'::regclass AND contype='u'
                  AND pg_get_constraintdef(oid) = 'UNIQUE (source_key)')),
      ('003 RLS',
        EXISTS (SELECT 1 FROM pg_class WHERE oid='public.memories'::regclass AND relrowsecurity)
        AND EXISTS (SELECT 1 FROM pg_class WHERE oid='public.documents'::regclass AND relrowsecurity)),
      ('003 policies',
        EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.memories'::regclass AND polname='namespace_read')
        AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.memories'::regclass AND polname='namespace_insert')
        AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.memories'::regclass AND polname='namespace_update')
        AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.documents'::regclass AND polname='namespace_read')
        AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.documents'::regclass AND polname='namespace_insert')),
      ('002/005 foreign keys',
        EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.memories'::regclass AND confrelid='public.documents'::regclass AND contype='f')
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.memories'::regclass AND confrelid='public.agents'::regclass AND contype='f')
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.audit_log'::regclass AND confrelid='public.agents'::regclass AND contype='f')
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.recall_traces'::regclass AND confrelid='public.agents'::regclass AND contype='f')),
      ('app grants',
        has_table_privilege('total_recall_app', 'public.memories', 'SELECT,INSERT,UPDATE')
        AND has_table_privilege('total_recall_app', 'public.documents', 'SELECT,INSERT,UPDATE')
        AND has_table_privilege('total_recall_app', 'public.audit_log', 'SELECT,INSERT')),
      ('recognized legacy 007 footprint',
        (
          -- Some legacy installations ran the old migration 007 without
          -- recording it.  It is safe to let the normal runner execute the
          -- current, idempotent 007 again, but only when the catalog is either
          -- wholly pre-007 or has the complete reviewed decay footprint.
          (
            NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema='public' AND table_name='memories'
                          AND column_name = ANY(ARRAY['relevance_score','decay_rate','last_boosted_at']))
          )
          OR
          (
            (SELECT count(*) = 3 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='memories'
               AND column_name = ANY(ARRAY['relevance_score','decay_rate','last_boosted_at']))
            AND EXISTS (
              SELECT 1
              FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
              JOIN pg_language l ON l.oid = p.prolang
              WHERE n.nspname='public'
                AND p.proname='calculate_relevance'
                AND pg_get_function_identity_arguments(p.oid) =
                  'p_relevance_score double precision, p_decay_rate double precision, p_accessed_at timestamp with time zone, p_access_count integer'
                AND pg_get_function_result(p.oid) = 'double precision'
                AND l.lanname = 'plpgsql'
                AND p.provolatile IN ('i', 's')
                AND NOT p.prosecdef
            )
            AND has_function_privilege(
              'total_recall_app',
              'public.calculate_relevance(double precision,double precision,timestamp with time zone,integer)',
              'EXECUTE'
            )
          )
        )
        -- Any durable marker from a later migration remains a hard stop.
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema='public' AND table_name='api_keys' AND column_name='max_access_level')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema='public' AND table_name='memories'
                          AND column_name = ANY(ARRAY['event_at','relevance_base_score','deleted_at']))
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema='public' AND table_name='documents' AND column_name='idempotency_key')
        AND to_regprocedure('public.app_allowed_namespaces()') IS NULL)
    )
    SELECT proof FROM proofs WHERE NOT ok ORDER BY proof
  `);
  return result.rows.map(row => row.proof);
}

export async function reconcileLegacyLedger(
  client: pg.Client,
  inventory: MigrationFile[],
  options: LegacyLedgerReconcileOptions,
): Promise<LegacyLedgerReconcileResult> {
  const reviewed = assertReviewedInventory(inventory);
  if (options.apply && !options.backupConfirmed) {
    throw new Error('Apply requires --confirm-backup after verifying a restorable database backup');
  }
  await client.query('BEGIN');
  let transactionFinished = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1, $2) AS locked',
      [MIGRATION_LOCK_KEY_1, MIGRATION_LOCK_KEY_2],
    );
    if (lock.rows[0]?.locked !== true) throw new Error('Another migration or reconciliation is running');
    await assertMigrationAuthority(client);
    await assertLegacyLedgerShape(client);
    const missing = await missingSchemaProofs(client);
    if (missing.length > 0) {
      throw new Error(`Legacy schema proof failed: ${missing.join(', ')}`);
    }

    const added = reviewed
      .filter(migration => !LEGACY_LEDGER.includes(migration.version as typeof LEGACY_LEDGER[number]))
      .map(migration => migration.version);
    if (!options.apply) {
      await client.query('ROLLBACK');
      transactionFinished = true;
      return { mode: 'preview', added };
    }

    await client.query('ALTER TABLE public.schema_migrations ADD COLUMN checksum text');
    for (const migration of reviewed) {
      await client.query(
        `INSERT INTO public.schema_migrations (version, checksum)
         VALUES ($1, $2)
         ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum`,
        [migration.version, migration.checksum],
      );
    }
    await client.query('COMMIT');
    transactionFinished = true;
    return { mode: 'applied', added };
  } finally {
    if (!transactionFinished) await client.query('ROLLBACK').catch(() => undefined);
  }
}

function parseCli(args: string[]): LegacyLedgerReconcileOptions {
  const known = new Set(['--apply', '--confirm-backup']);
  const unknown = args.find(arg => !known.has(arg));
  if (unknown) throw new Error(`Unknown option ${unknown}`);
  const apply = args.includes('--apply');
  const backupConfirmed = args.includes('--confirm-backup');
  if (!apply && backupConfirmed) throw new Error('--confirm-backup is valid only with --apply');
  return { apply, backupConfirmed };
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const connectionString = resolveMigrationDatabaseUrl(process.env);
  const inventory = loadMigrationInventory(join(__dirname, '..', 'migrations'));
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await reconcileLegacyLedger(client, inventory, options);
    console.log(`[legacy-ledger] ${result.mode}: ${result.mode === 'preview' ? 'would add' : 'added'} ${result.added.join(', ')}`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('[legacy-ledger] Failed:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
