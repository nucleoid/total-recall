import pg from 'pg';

export interface FinalizeMemoryLifecycleOptions {
  connectionString: string;
}

export interface MemoryLifecycleConstraintResult {
  constraintName: string;
  validated: boolean;
  constraintExists: boolean;
  constraintValid: boolean;
}

export interface MemoryLifecycleIndexResult {
  indexName: string;
  created: boolean;
  indexExists: boolean;
  indexValid: boolean;
}

export interface MemoryLifecycleFinalizationResult {
  constraints: MemoryLifecycleConstraintResult[];
  indexes: MemoryLifecycleIndexResult[];
}

export interface MemoryLifecycleFinalizerClient {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[] }>;
}

type ConstraintState = { exists: boolean; isValid: boolean; definition: string | null };
type IndexState = { exists: boolean; isValid: boolean; definition: string | null };

type ConstraintDefinition = {
  name: string;
  expectedDefinition: string;
};

type IndexDefinition = {
  name: string;
  createSql: string;
  normalizedDefinition: string;
};

const CONSTRAINT_DEFINITIONS: readonly ConstraintDefinition[] = [
  {
    name: 'memories_deleted_by_client_id_fkey',
    expectedDefinition:
      'FOREIGN KEY (deleted_by_client_id) REFERENCES api_keys(id) ON DELETE SET NULL',
  },
  {
    name: 'memories_deletion_reason_length',
    expectedDefinition:
      'CHECK (deletion_reason IS NULL OR char_length(deletion_reason) <= 512)',
  },
];

const INDEX_DEFINITIONS: readonly IndexDefinition[] = [
  {
    name: 'memories_active_namespace_created_idx',
    createSql: `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_active_namespace_created_idx
        ON public.memories (namespace, created_at DESC)
        WHERE deleted_at IS NULL
    `,
    normalizedDefinition:
      'create index memories_active_namespace_created_idx on public.memories using btree (namespace, created_at desc) where (deleted_at is null)',
  },
  {
    name: 'memories_deleted_purge_idx',
    createSql: `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_deleted_purge_idx
        ON public.memories (deleted_at, id)
        WHERE deleted_at IS NOT NULL
    `,
    normalizedDefinition:
      'create index memories_deleted_purge_idx on public.memories using btree (deleted_at, id) where (deleted_at is not null)',
  },
];

/**
 * Finish migration 024 after its transaction has committed. Every query runs
 * without BEGIN, so each VALIDATE CONSTRAINT and concurrent index operation is
 * a separate autocommit transaction and does not inherit the migration's locks.
 */
export async function finalizeMemoryLifecycle(
  options: FinalizeMemoryLifecycleOptions
): Promise<MemoryLifecycleFinalizationResult> {
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();

  try {
    return await ensureMemoryLifecycleFinalization(client);
  } finally {
    await client.end();
  }
}

export async function ensureMemoryLifecycleFinalization(
  client: MemoryLifecycleFinalizerClient
): Promise<MemoryLifecycleFinalizationResult> {
  const constraints = await ensureMemoryLifecycleConstraints(client);
  const indexes = await ensureMemoryLifecycleIndexes(client);
  return { constraints, indexes };
}

export async function ensureMemoryLifecycleConstraints(
  client: MemoryLifecycleFinalizerClient
): Promise<MemoryLifecycleConstraintResult[]> {
  const results: MemoryLifecycleConstraintResult[] = [];

  for (const definition of CONSTRAINT_DEFINITIONS) {
    const before = await loadConstraintState(client, definition.name);
    if (!before.exists) {
      throw new Error(`memory lifecycle constraint ${definition.name} is missing; run npm run migrate first`);
    }
    if (!constraintDefinitionMatches(before.definition, definition.expectedDefinition)) {
      throw new Error(
        `memory lifecycle constraint ${definition.name} has an unexpected definition; refusing to validate it`
      );
    }

    if (!before.isValid) {
      // Deliberately one statement per autocommit transaction. VALIDATE uses
      // PostgreSQL's lower-lock validation path after migration 024 has committed.
      await client.query(`ALTER TABLE public.memories VALIDATE CONSTRAINT ${definition.name}`);
    }

    const after = await loadConstraintState(client, definition.name);
    if (!after.exists || !after.isValid || !constraintDefinitionMatches(after.definition, definition.expectedDefinition)) {
      throw new Error(
        `memory lifecycle constraint ${definition.name} is missing, unvalidated, or has an unexpected definition after validation`
      );
    }

    results.push({
      constraintName: definition.name,
      validated: !before.isValid,
      constraintExists: after.exists,
      constraintValid: after.isValid,
    });
  }

  return results;
}

export async function ensureMemoryLifecycleIndexes(
  client: MemoryLifecycleFinalizerClient
): Promise<MemoryLifecycleIndexResult[]> {
  const results: MemoryLifecycleIndexResult[] = [];

  for (const definition of INDEX_DEFINITIONS) {
    const before = await loadIndexState(client, definition.name);
    if (before.exists && before.isValid && !indexDefinitionMatches(before.definition, definition)) {
      throw new Error(
        `memory lifecycle index ${definition.name} exists with an unexpected definition; refusing to replace a valid index`
      );
    }
    if (before.exists && !before.isValid) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public.${definition.name}`);
    }

    await client.query(definition.createSql);
    const after = await loadIndexState(client, definition.name);
    if (!after.exists || !after.isValid || !indexDefinitionMatches(after.definition, definition)) {
      throw new Error(`memory lifecycle index ${definition.name} is missing, invalid, or has an unexpected definition after build`);
    }

    results.push({
      indexName: definition.name,
      created: !before.exists || !before.isValid,
      indexExists: after.exists,
      indexValid: after.isValid,
    });
  }

  return results;
}

async function loadConstraintState(
  client: MemoryLifecycleFinalizerClient,
  constraintName: string
): Promise<ConstraintState> {
  const result = await client.query<{ isValid: boolean; definition: string }>(
    `
    SELECT c.convalidated AS "isValid",
           pg_get_constraintdef(c.oid, true) AS definition
    FROM pg_constraint c
    JOIN pg_class relation ON relation.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = relation.relnamespace
    WHERE n.nspname = 'public'
      AND relation.relname = 'memories'
      AND c.conname = $1
    `,
    [constraintName]
  );
  const row = result.rows[0];
  return {
    exists: row !== undefined,
    isValid: row?.isValid === true,
    definition: row?.definition ?? null,
  };
}

async function loadIndexState(
  client: MemoryLifecycleFinalizerClient,
  indexName: string
): Promise<IndexState> {
  const result = await client.query<{ exists: boolean; isValid: boolean; definition: string | null }>(
    `
    WITH index_state AS (
      SELECT i.indisvalid, pg_get_indexdef(c.oid) AS definition
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = $1
        AND c.relkind = 'i'
    )
    SELECT EXISTS (SELECT 1 FROM index_state) AS exists,
           COALESCE((SELECT indisvalid FROM index_state), false) AS "isValid",
           (SELECT definition FROM index_state) AS definition
    `,
    [indexName]
  );

  return {
    exists: result.rows[0]?.exists === true,
    isValid: result.rows[0]?.isValid === true,
    definition: result.rows[0]?.definition ?? null,
  };
}

function constraintDefinitionMatches(actual: string | null, expected: string): boolean {
  return normalizeConstraintDefinition(actual) === normalizeConstraintDefinition(expected);
}

function normalizeConstraintDefinition(definition: string | null): string | null {
  return definition
    ?.toLowerCase()
    .replace(/"/g, '')
    .replace(/public\./g, '')
    .replace(/[\s()]/g, '')
    .replace(/notvalid$/, '') ?? null;
}

function indexDefinitionMatches(actual: string | null, expected: IndexDefinition): boolean {
  return actual?.replace(/\s+/g, ' ').trim().toLowerCase() === expected.normalizedDefinition;
}
