import pg from 'pg';

export interface CreateDocumentIdempotencyIndexOptions {
  connectionString: string;
}

export interface CreateDocumentIdempotencyIndexResult {
  indexName: string;
  created: boolean;
  indexExists: boolean;
  indexValid: boolean;
}

const INDEX_NAME = 'documents_client_namespace_idempotency_key_idx';

type IndexState = { exists: boolean; isValid: boolean };

export async function createDocumentIdempotencyIndex(
  options: CreateDocumentIdempotencyIndexOptions
): Promise<CreateDocumentIdempotencyIndexResult> {
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();

  try {
    const before = await loadIndexState(client);
    if (before.exists && !before.isValid) {
      await client.query(`
        DROP INDEX CONCURRENTLY IF EXISTS public.documents_client_namespace_idempotency_key_idx
      `);
    }

    await client.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS documents_client_namespace_idempotency_key_idx
        ON public.documents (client_id, namespace, idempotency_key)
        WHERE client_id IS NOT NULL AND idempotency_key IS NOT NULL
    `);
    const after = await loadIndexState(client);

    return {
      indexName: INDEX_NAME,
      created: !before.exists || !before.isValid,
      indexExists: after.exists,
      indexValid: after.isValid,
    };
  } finally {
    await client.end();
  }
}

async function loadIndexState(client: pg.Client): Promise<IndexState> {
  const result = await client.query<{ exists: boolean; isValid: boolean }>(
    `
    WITH index_state AS (
      SELECT i.indisvalid
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = $1
        AND c.relkind = 'i'
    )
    SELECT EXISTS (SELECT 1 FROM index_state) AS exists,
           COALESCE((SELECT indisvalid FROM index_state), false) AS "isValid"
    `,
    [INDEX_NAME]
  );
  return {
    exists: result.rows[0]?.exists === true,
    isValid: result.rows[0]?.isValid === true,
  };
}
