import {
  prepareCanonicalEmbeddingBatch,
  type BatchEmbedder,
} from './preseed-embedding.js';

export interface QueryClient {
  query(text: string, values?: unknown[]): Promise<any>;
}

export interface ImportMemoryRow {
  content: string;
  source: string;
  namespace: string;
  tags: string[];
  metadata: string;
  sourceKey: string;
  createdAt?: string;
}

interface ImportRoleRow {
  current_user: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  owns_memories: boolean;
}

export async function assertSafeImportRole(client: QueryClient): Promise<string> {
  const result = await client.query(`SELECT
  current_user,
  role.rolsuper,
  role.rolbypassrls,
  memories.relowner = role.oid AS owns_memories
FROM pg_roles AS role
JOIN pg_class AS memories ON memories.oid = 'memories'::regclass
WHERE role.rolname = current_user
`);
  const identity = result.rows?.[0] as ImportRoleRow | undefined;
  if (!identity) throw new Error('Unable to validate the database role used for preseed import');
  const unsafe: string[] = [];
  if (identity.rolsuper) unsafe.push('superuser');
  if (identity.rolbypassrls) unsafe.push('BYPASSRLS');
  if (identity.owns_memories) unsafe.push('owner of memories');
  if (unsafe.length > 0) {
    throw new Error(`Database role ${identity.current_user} is unsafe for preseed import: ${unsafe.join(', ')}`);
  }
  return identity.current_user;
}

export async function commitImportBatch(
  pending: ImportMemoryRow[],
  embedder: BatchEmbedder,
  client: QueryClient,
  clientId: string,
  options: { updateCreatedAtOnConflict?: boolean } = {},
): Promise<number> {
  const unique = [...new Map(pending.map(row => [row.sourceKey, row])).values()];
  if (unique.length === 0) return 0;
  if (unique.length > 10) throw new Error('Preseed import batches must contain at most 10 rows');

  const prepared = await prepareCanonicalEmbeddingBatch(unique.map(row => row.content), embedder);
  const values: unknown[] = [];
  const tuples = unique.map((row, index) => {
    const base = index * 9;
    values.push(
      row.content,
      `[${prepared.embeddings[index].join(',')}]`,
      row.source,
      row.namespace,
      row.tags,
      row.metadata,
      clientId,
      row.sourceKey,
      row.createdAt ?? null,
    );
    return `(gen_random_uuid(), $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, COALESCE($${base + 9}::timestamptz, NOW()))`;
  });
  const createdAtUpdate = options.updateCreatedAtOnConflict === false ? '' : '\n  created_at = EXCLUDED.created_at,';
  const sql = `INSERT INTO memories (id, content, embedding, source, namespace, tags, metadata, client_id, source_key, created_at)\nVALUES ${tuples.join(',\n')}\nON CONFLICT (source_key) DO UPDATE SET\n  content = EXCLUDED.content,\n  embedding = EXCLUDED.embedding,${createdAtUpdate}\n  updated_at = NOW()`;
  const namespaces = [...new Set(unique.map(row => row.namespace))].sort();

  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    await client.query("SELECT set_config('app.allowed_namespaces', $1, true)", [JSON.stringify(namespaces)]);
    await client.query(sql, values);
    await client.query('COMMIT');
    return unique.length;
  } catch (error) {
    if (began) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
    }
    throw error;
  }
}
