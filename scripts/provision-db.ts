import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const APP_ROLE = 'total_recall_app';
const PROVISION_LOCK_KEY_1 = 1_414_676_812;
const PROVISION_LOCK_KEY_2 = 1_296_650_835;

export type ProvisionOptions = {
  connectionString: string;
  appPassword: string;
  rotateAppPassword: boolean;
};

export type ProvisionClient = {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
};

export type ProvisionRunOptions = {
  appPassword: string;
  rotateAppPassword: boolean;
  log?: (message: string) => void;
};

export function parseProvisionOptions(
  env: Record<string, string | undefined>,
  args: string[],
): ProvisionOptions {
  const connectionString = env.MIGRATION_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('MIGRATION_DATABASE_URL is required for owner-run database provisioning');
  }
  const appPassword = env.APP_DATABASE_PASSWORD;
  if (!appPassword?.trim()) {
    throw new Error('APP_DATABASE_PASSWORD is required and must not be blank');
  }
  const unknown = args.find(arg => arg !== '--rotate-app-password');
  if (unknown) throw new Error(`Unknown option: ${unknown}`);

  return {
    connectionString,
    appPassword,
    rotateAppPassword: args.includes('--rotate-app-password'),
  };
}

async function formattedSql(
  client: ProvisionClient,
  text: string,
  values: readonly unknown[],
): Promise<string> {
  const result = await client.query(text, values);
  const sql = result.rows[0]?.sql;
  if (typeof sql !== 'string' || sql.length === 0) {
    throw new Error('PostgreSQL did not generate the requested provisioning statement');
  }
  return sql;
}

export async function provisionDatabase(
  client: ProvisionClient,
  options: ProvisionRunOptions,
): Promise<void> {
  let locked = false;
  let failed = false;
  try {
    await client.query('SELECT pg_advisory_lock($1, $2) AS locked', [
      PROVISION_LOCK_KEY_1,
      PROVISION_LOCK_KEY_2,
    ]);
    locked = true;

    const existing = await client.query(
      'SELECT true AS exists FROM pg_roles WHERE rolname = $1',
      [APP_ROLE],
    );
    if (existing.rowCount === 0) {
      const create = await formattedSql(
        client,
        "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql",
        [APP_ROLE, options.appPassword],
      );
      await client.query(create);
      options.log?.(`Created PostgreSQL application role ${APP_ROLE}.`);
    } else if (options.rotateAppPassword) {
      const alter = await formattedSql(
        client,
        "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql",
        [APP_ROLE, options.appPassword],
      );
      await client.query(alter);
      options.log?.(`Rotated the password for PostgreSQL application role ${APP_ROLE}.`);
    } else {
      options.log?.(`PostgreSQL application role ${APP_ROLE} already exists; password preserved.`);
    }

    const grant = await formattedSql(
      client,
      "SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text) AS sql",
      [APP_ROLE],
    );
    await client.query(grant);

    const verification = await client.query(`
      SELECT r.rolname,
             r.rolcanlogin,
             r.rolsuper,
             r.rolbypassrls,
             (
               SELECT count(*)::int
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public'
                 AND c.relkind IN ('r', 'p')
                 AND c.relowner = r.oid
                 AND c.relname IN (
                   'memories', 'documents', 'api_keys', 'sync_state',
                   'audit_log', 'agents', 'recall_traces', 'media_events', 'activity_events',
                   'memory_consolidation_memberships', 'memory_consolidation_runs',
                   'memory_consolidation_checkpoints', 'memory_subscriptions',
                   'subscription_namespaces', 'subscription_match_truncations',
                   'webhook_deliveries'
                 )
             ) AS owned_tables
      FROM pg_roles r
      WHERE r.rolname = $1
    `, [APP_ROLE]);
    const role = verification.rows[0];
    const ownedTables = Number(role?.owned_tables ?? -1);
    if (
      !role ||
      role.rolcanlogin !== true ||
      role.rolsuper !== false ||
      role.rolbypassrls !== false ||
      ownedTables !== 0
    ) {
      throw new Error(
        `${APP_ROLE} must be LOGIN, not superuser, without BYPASSRLS, and must not own application tables`,
      );
    }

    options.log?.(`Verified least-privilege PostgreSQL application role ${APP_ROLE}.`);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (locked) {
      try {
        const unlocked = await client.query(
          'SELECT pg_advisory_unlock($1, $2) AS unlocked',
          [PROVISION_LOCK_KEY_1, PROVISION_LOCK_KEY_2],
        );
        if (unlocked.rows[0]?.unlocked !== true) {
          const message = 'Provisioning advisory lock was not held during release';
          if (!failed) throw new Error(message);
          console.warn(`WARNING: ${message}; preserving the original provisioning failure.`);
        }
      } catch (unlockError) {
        if (!failed) throw unlockError;
        console.warn(`WARNING: provisioning lock release failed after provisioning error: ${String(unlockError)}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const options = parseProvisionOptions(process.env, process.argv.slice(2));
  const client = new pg.Client({ connectionString: options.connectionString });
  try {
    await client.connect();
    await provisionDatabase(client, {
      appPassword: options.appPassword,
      rotateAppPassword: options.rotateAppPassword,
      log: console.log,
    });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Database provisioning failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
