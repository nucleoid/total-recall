import type { ScopedClient } from '../db.js';
import { withScopedClient } from '../db.js';

export interface SyncChunk {
  content: string;
  sourceKey: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface PreparedSyncChunk extends SyncChunk {
  vectorStr: string;
}

export interface FileSyncInput {
  relPath: string;
  hash: string;
  namespace: string;
  source: string;
  agentId: string | null;
  chunks: PreparedSyncChunk[];
}

const UPSERT_SQL = `
INSERT INTO memories (id, content, embedding, source, namespace, tags, metadata, client_id, source_key, agent_id)
VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'file-sync', $7, $8)
ON CONFLICT (source_key) DO UPDATE SET
  content = EXCLUDED.content,
  embedding = EXCLUDED.embedding,
  source = EXCLUDED.source,
  namespace = EXCLUDED.namespace,
  tags = EXCLUDED.tags,
  metadata = EXCLUDED.metadata,
  agent_id = EXCLUDED.agent_id,
  updated_at = NOW()
`;

const UPDATE_HASH_SQL = `
INSERT INTO sync_state (file_path, content_hash, last_synced)
VALUES ($1, $2, NOW())
ON CONFLICT (file_path) DO UPDATE
SET content_hash = $2, last_synced = NOW()
`;

export async function prepareChunks(
  chunks: SyncChunk[],
  embedChunk: (content: string) => Promise<number[]>
): Promise<PreparedSyncChunk[]> {
  const prepared: PreparedSyncChunk[] = [];
  for (const chunk of chunks) {
    const embedding = await embedChunk(chunk.content.slice(0, 8000));
    prepared.push({ ...chunk, vectorStr: `[${embedding.join(',')}]` });
  }
  return prepared;
}

export async function commitPreparedFile(input: FileSyncInput): Promise<void> {
  await withScopedClient(
    { namespaces: [input.namespace], keyId: 'file-sync', isAdmin: false },
    (client) => reconcilePreparedFile(client, input)
  );
}

export async function reconcilePreparedFile(
  client: ScopedClient,
  input: FileSyncInput
): Promise<void> {
  for (const chunk of input.chunks) {
    await client.query(UPSERT_SQL, [
      chunk.content,
      chunk.vectorStr,
      input.source,
      input.namespace,
      chunk.tags,
      JSON.stringify(chunk.metadata),
      chunk.sourceKey,
      input.agentId,
    ]);
  }

  await client.query(UPDATE_HASH_SQL, [input.relPath, input.hash]);
}
