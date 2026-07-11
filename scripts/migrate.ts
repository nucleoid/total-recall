import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

type CurrentRole = {
  currentUser: string;
  rolsuper: boolean;
};

async function currentRole(client: pg.Client): Promise<CurrentRole> {
  const res = await client.query<CurrentRole>(`
    SELECT current_user AS "currentUser", rolsuper
    FROM pg_roles
    WHERE rolname = current_user
  `);
  return res.rows[0];
}

async function rejectRuntimeMigrationRole(client: pg.Client): Promise<void> {
  const role = await currentRole(client);
  if (role.currentUser !== 'total_recall_app') return;

  throw new Error(
    'total_recall_app is the runtime role and cannot run migrations. ' +
      'Set MIGRATION_DATABASE_URL to the original schema owner or a superuser. ' +
      'DATABASE_URL fallback only works when DATABASE_URL is an owner-capable migration connection.'
  );
}

async function ensureSchemaMigrationsTable(client: pg.Client): Promise<void> {
  const existing = await client.query<{ regclass: string | null }>(
    "SELECT to_regclass('public.schema_migrations')::text AS regclass"
  );
  if (existing.rows[0]?.regclass) return;

  await client.query(`
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
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
      'Set MIGRATION_DATABASE_URL to the original schema owner or a superuser before running npm run migrate. ' +
      'DATABASE_URL fallback only works when DATABASE_URL is an owner-capable migration connection.'
  );
}

async function migrate() {
  const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL must be set');
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await rejectRuntimeMigrationRole(client);
    await ensureSchemaMigrationsTable(client);

    const applied = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    const appliedSet = new Set(applied.rows.map((r: any) => r.version));

    const migrationsDir = join(__dirname, '..', 'migrations');
    const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

    for (const file of files) {
      const version = file.replace('.sql', '');
      if (appliedSet.has(version)) {
        console.log(`✓ ${file} (already applied)`);
        continue;
      }

      console.log(`→ Applying ${file}...`);
      const sql = readFileSync(join(migrationsDir, file), 'utf-8');
      const ownerRequired = OWNER_REQUIRED_MIGRATIONS[version];
      if (ownerRequired) {
        await assertCanGrantForMigration(client, version, file, ownerRequired);
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`✓ ${file} applied`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log('All migrations complete.');
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
