import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const OWNER_REQUIRED_MIGRATIONS: Record<string, Record<string, string[]>> = {
  '008_agent_trace_grants': {
    agents: ['SELECT', 'INSERT', 'UPDATE'],
    recall_traces: ['SELECT', 'INSERT'],
  },
};

export type MigrationFile = {
  file: string;
  version: string;
  number: number;
  bytes: Buffer;
  checksum: string;
  sql: string;
};

const MIGRATION_FILENAME = /^(\d{3})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const MAX_LOCK_TIMEOUT_MS = 600_000;

export function loadMigrationInventory(migrationsDir: string): MigrationFile[] {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const migrations: MigrationFile[] = [];
  const numbers = new Map<string, string>();

  for (const file of readdirSync(migrationsDir).filter(name => name.endsWith('.sql'))) {
    const match = MIGRATION_FILENAME.exec(file);
    if (!match) {
      throw new Error(`Invalid migration filename "${file}"; expected NNN_lowercase_name.sql`);
    }
    const [, numericPrefix] = match;
    const existing = numbers.get(numericPrefix);
    if (existing) {
      throw new Error(`Duplicate migration number ${numericPrefix}: ${existing} and ${file}`);
    }
    numbers.set(numericPrefix, file);

    const bytes = readFileSync(join(migrationsDir, file));
    let sql: string;
    try {
      sql = decoder.decode(bytes);
    } catch {
      throw new Error(`Migration ${file} is not valid UTF-8`);
    }
    migrations.push({
      file,
      version: file.slice(0, -'.sql'.length),
      number: Number(numericPrefix),
      bytes,
      checksum: createHash('sha256').update(bytes).digest('hex'),
      sql,
    });
  }

  return migrations.sort((left, right) => left.number - right.number);
}

export function resolveMigrationDatabaseUrl(env: Record<string, string | undefined>): string {
  const connectionString = env.MIGRATION_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('MIGRATION_DATABASE_URL is required; DATABASE_URL is runtime-only and is never used for migrations');
  }
  return connectionString;
}

export function parseMigrationLockTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LOCK_TIMEOUT_MS;
  if (!/^\d+$/.test(value)) {
    throw new Error('MIGRATION_LOCK_TIMEOUT_MS must be an integer from 1 to 600000');
  }
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_LOCK_TIMEOUT_MS) {
    throw new Error('MIGRATION_LOCK_TIMEOUT_MS must be an integer from 1 to 600000');
  }
  return timeout;
}

type CurrentRole = {
  currentUser: string;
  currentDatabase?: string;
  rolsuper: boolean;
  canCreateInPublic?: boolean;
};

async function currentRole(client: pg.Client): Promise<CurrentRole> {
  const res = await client.query<CurrentRole>(`
    SELECT current_user AS "currentUser", rolsuper
    FROM pg_roles
    WHERE rolname = current_user
  `);
  return res.rows[0];
}

const MIGRATION_OWNED_TABLES = [
  'agents',
  'api_keys',
  'audit_log',
  'connector_credentials',
  'connector_sync_state',
  'documents',
  'entities',
  'entity_enrichment_queue',
  'media_events',
  'memories',
  'memory_consolidation_checkpoints',
  'memory_consolidation_memberships',
  'memory_consolidation_runs',
  'memory_entities',
  'memory_subscriptions',
  'subscription_namespaces',
  'subscription_match_truncations',
  'webhook_deliveries',
  'recall_traces',
  'schema_migrations',
  'sync_state',
] as const;

async function assertMigrationAuthority(client: pg.Client): Promise<void> {
  const identity = await client.query<CurrentRole>(`
    SELECT current_user AS "currentUser",
           current_database() AS "currentDatabase",
           r.rolsuper,
           has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreateInPublic"
    FROM pg_roles r
    WHERE r.rolname = current_user
  `);
  const role = identity.rows[0];
  if (!role) throw new Error('Migration authority preflight could not identify the connected PostgreSQL role');
  if (role.currentUser === 'total_recall_app') {
    throw new Error(
      'total_recall_app is the runtime role and cannot run migrations, even if it was accidentally elevated. ' +
        'Set MIGRATION_DATABASE_URL to the schema/table owner or a superuser and remove the app-role elevation.'
    );
  }
  if (role.rolsuper) return;

  const relations = await client.query<{ relation: string; owner: string }>(`
    SELECT c.relname AS relation,
           pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname = ANY($1::text[])
      AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND NOT pg_has_role(current_user, c.relowner, 'USAGE')
    ORDER BY c.relname
  `, [MIGRATION_OWNED_TABLES]);

  const missing: string[] = [];
  if (role.canCreateInPublic !== true) missing.push('schema public CREATE privilege');
  if (relations.rows.length > 0) {
    missing.push(`owner authority for ${relations.rows.map(row => `${row.relation} (owner: ${row.owner})`).join(', ')}`);
  }
  if (missing.length === 0) return;

  throw new Error(
    `Migration authority preflight failed for current user "${role.currentUser}" ` +
      `on database "${role.currentDatabase}": missing ${missing.join('; ')}. ` +
      'Set MIGRATION_DATABASE_URL to the schema/table owner or a superuser. ' +
      'Do not grant DDL privileges or ownership to total_recall_app.'
  );
}

async function schemaMigrationsTableExists(client: pg.Client): Promise<boolean> {
  const existing = await client.query<{ regclass: string | null }>(
    "SELECT to_regclass('public.schema_migrations')::text AS regclass",
  );
  return existing.rows[0]?.regclass !== null;
}

async function ensureSchemaMigrationsTable(client: pg.Client): Promise<void> {
  if (!(await schemaMigrationsTableExists(client))) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
}

async function hasGrantOption(client: pg.Client, relation: string, privilege: string): Promise<boolean> {
  const res = await client.query<{ ok: boolean }>(
    'SELECT has_table_privilege(current_user, $1, $2) AS ok',
    [`public.${relation}`, `${privilege} WITH GRANT OPTION`]
  );
  return res.rows[0]?.ok === true;
}

async function assertCanGrantForMigration(
  client: pg.Client,
  version: string,
  file: string,
  required: Record<string, string[]>
): Promise<void> {
  const role = await currentRole(client);
  if (role.rolsuper) return;

  const missing: string[] = [];
  for (const [relation, privileges] of Object.entries(required)) {
    const ownerRes = await client.query<{ owner: string | null; owns: boolean }>(
      `
        SELECT pg_get_userbyid(c.relowner) AS owner,
               c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owns
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = $1
          AND c.relkind IN ('r', 'p')
      `,
      [relation]
    );

    const relationState = ownerRes.rows[0];
    if (!relationState) {
      missing.push(`${relation} (relation does not exist)`);
      continue;
    }
    if (relationState.owns) continue;

    const hasAllGrantOptions = (
      await Promise.all(privileges.map((privilege) => hasGrantOption(client, relation, privilege)))
    ).every(Boolean);
    if (!hasAllGrantOptions) {
      missing.push(`${relation} (owner: ${relationState.owner}, needs ${privileges.join(', ')})`);
    }
  }

  if (missing.length === 0) return;

  throw new Error(
    `Migration ${file} (${version}) cannot grant required privileges as role "${role.currentUser}". ` +
      `Missing grant authority for: ${missing.join('; ')}. ` +
      'Set MIGRATION_DATABASE_URL to the original schema owner or a superuser before running npm run migrate.'
  );
}

const MIGRATION_LOCK_KEY_1 = 1_414_676_812;
const MIGRATION_LOCK_KEY_2 = 1_296_650_834;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const COMPATIBLE_APPLIED_CHECKSUMS: Readonly<Record<string, ReadonlySet<string>>> = {
  // The only mutable-history exception: #49 sanitizes 003 for fresh installs while
  // migration 020 carries the capability change for already-applied databases.
  // Accept exact LF and CRLF hashes from the pre-sanitization migration.
  '003_rls': new Set([
    '453417ae58829f930186b2a034b592db3df644a4045e5afcd87a67c4e0d6b615',
    '3fc2cdc1814ab6da989106733a2b78da175263bb66a747fdc49800a80395aac5',
  ]),
};

export function isCompatibleAppliedChecksum(version: string, checksum: string): boolean {
  return COMPATIBLE_APPLIED_CHECKSUMS[version]?.has(checksum) === true;
}

export type MigrationRunOptions = {
  lockTimeoutMs: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

function interrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Migration interrupted by signal');
}

async function acquireMigrationLock(client: pg.Client, options: MigrationRunOptions): Promise<void> {
  const started = Date.now();
  options.log?.(`Waiting up to ${options.lockTimeoutMs}ms for migration advisory lock...`);
  while (true) {
    interrupted(options.signal);
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [MIGRATION_LOCK_KEY_1, MIGRATION_LOCK_KEY_2],
    );
    if (result.rows[0]?.acquired) {
      options.log?.('Migration advisory lock acquired.');
      return;
    }
    const remaining = options.lockTimeoutMs - (Date.now() - started);
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for migration advisory lock after ${options.lockTimeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
  }
}

type LedgerRow = { version: string; checksum: string | null };

export async function runMigrations(
  client: pg.Client,
  migrations: MigrationFile[],
  options: MigrationRunOptions,
): Promise<void> {
  const byVersion = new Map(migrations.map(migration => [migration.version, migration]));
  let lockAcquired = false;
  let failed = false;

  try {
    await acquireMigrationLock(client, options);
    lockAcquired = true;
    interrupted(options.signal);
    await assertMigrationAuthority(client);
    if (await schemaMigrationsTableExists(client)) {
      const existingVersions = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      const appliedVersions = new Set(existingVersions.rows.map(row => row.version));
      for (const migration of migrations) {
        const ownerRequired = OWNER_REQUIRED_MIGRATIONS[migration.version];
        if (ownerRequired && !appliedVersions.has(migration.version)) {
          await assertCanGrantForMigration(client, migration.version, migration.file, ownerRequired);
        }
      }
    }
    await ensureSchemaMigrationsTable(client);

    const applied = await client.query<LedgerRow>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    const compatibleTransitions: LedgerRow[] = [];
    for (const row of applied.rows) {
      const migration = byVersion.get(row.version);
      if (!migration) {
        throw new Error(`Unknown applied migration ${row.version}: no exact migration file exists`);
      }
      if (row.checksum !== null && !CHECKSUM_PATTERN.test(row.checksum)) {
        throw new Error(`Malformed checksum for applied migration ${row.version}`);
      }
      if (row.checksum !== null && row.checksum !== migration.checksum) {
        if (isCompatibleAppliedChecksum(row.version, row.checksum)) {
          compatibleTransitions.push(row);
        } else {
          throw new Error(`Checksum mismatch for applied migration ${row.version}`);
        }
      }
    }

    const appliedSet = new Set(applied.rows.map(row => row.version));
    const maxAppliedNumber = applied.rows.reduce(
      (maximum, row) => Math.max(maximum, byVersion.get(row.version)!.number),
      -1,
    );
    const outOfOrder = migrations.find(
      migration => !appliedSet.has(migration.version) && migration.number < maxAppliedNumber,
    );
    if (outOfOrder) {
      throw new Error(
        `Out-of-order migration ${outOfOrder.version} cannot back-fill below applied migration number ${maxAppliedNumber}`,
      );
    }

    const unbaselined = applied.rows.filter(row => row.checksum === null);
    if (unbaselined.length > 0 || compatibleTransitions.length > 0) {
      if (unbaselined.length > 0) {
        options.warn?.(
          'WARNING: baselining legacy migration checksums from this reviewed checkout; ' +
            'PostgreSQL cannot detect edits made before this baseline. Verify this immutable release first.',
        );
      }
      if (compatibleTransitions.length > 0) {
        options.warn?.(
          'WARNING: recording the reviewed #49 sanitization checksum transition for applied migration 003_rls; ' +
            'existing schema changes are delivered by forward migration 020_memory_delete_policy.',
        );
      }
      await client.query('BEGIN');
      try {
        for (const row of [...unbaselined, ...compatibleTransitions]) {
          const migration = byVersion.get(row.version)!;
          const update = await client.query(
            'UPDATE schema_migrations SET checksum = $1 WHERE version = $2 AND checksum IS NOT DISTINCT FROM $3',
            [migration.checksum, row.version, row.checksum],
          );
          if (update.rowCount !== 1) {
            throw new Error(`Migration ledger changed while baselining ${row.version}`);
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    for (const migration of migrations) {
      interrupted(options.signal);
      const { file, version, sql, checksum } = migration;
      if (appliedSet.has(version)) {
        options.log?.(`✓ ${file} (already applied)`);
        continue;
      }

      options.log?.(`→ Applying ${file}...`);
      const ownerRequired = OWNER_REQUIRED_MIGRATIONS[version];
      if (ownerRequired) {
        await assertCanGrantForMigration(client, version, file, ownerRequired);
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [version, checksum],
        );
        await client.query('COMMIT');
        options.log?.(`✓ ${file} applied`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    options.log?.('All migrations complete.');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (lockAcquired) {
      try {
        const result = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock($1, $2) AS unlocked',
          [MIGRATION_LOCK_KEY_1, MIGRATION_LOCK_KEY_2],
        );
        if (!result.rows[0]?.unlocked) {
          const message = 'Migration advisory lock was not held during release';
          if (!failed) throw new Error(message);
          options.warn?.(`WARNING: ${message}; preserving the original migration failure.`);
        }
      } catch (unlockError) {
        if (!failed) throw unlockError;
        options.warn?.(`WARNING: migration lock release failed after migration error: ${String(unlockError)}`);
      }
    }
  }
}

async function migrate() {
  const connectionString = resolveMigrationDatabaseUrl(process.env);

  const migrations = loadMigrationInventory(join(__dirname, '..', 'migrations'));
  const lockTimeoutMs = parseMigrationLockTimeout(process.env.MIGRATION_LOCK_TIMEOUT_MS);
  const client = new pg.Client({ connectionString });
  const abortController = new AbortController();
  let forcedClose: Promise<void> | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`Migration interrupted by ${signal}; closing the database session.`);
    abortController.abort();
    forcedClose ??= client.end();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await client.connect();
    await runMigrations(client, migrations, {
      lockTimeoutMs,
      signal: abortController.signal,
      log: console.log,
      warn: console.warn,
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (forcedClose) await forcedClose;
    else await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  });
}
