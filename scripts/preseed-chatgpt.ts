import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import streamArray, { type StreamArrayItem } from 'stream-json/streamers/stream-array.js';
import { embedBatch } from '../src/embedding.js';
import {
  prepareCanonicalEmbeddingBatch,
  requireEmbeddingIdentityWriter,
  type BatchEmbedder,
} from './lib/preseed-embedding.js';

const DATABASE_URL = process.env.OWNER_DATABASE_URL || 'postgresql://total_recall:total_recall_dev@localhost:5432/total_recall';
const MAX_CONTENT = 4000;
export const DEFAULT_MAX_CONVERSATION_BYTES = 16 * 1024 * 1024;
export const HARD_MAX_CONVERSATION_BYTES = 64 * 1024 * 1024;
const CONVERSATION_FILE = /^conversations(?:-(\d+))?\.json$/;
const TURNS_PER_CHUNK = 5;

interface MappingNode {
  message?: {
    author?: { role: string };
    content?: { content_type: string; parts?: any[] };
    create_time?: number | null;
  } | null;
  parent: string | null;
  children: string[];
}

export interface Conversation {
  title: string;
  create_time: number;
  update_time: number;
  mapping: Record<string, MappingNode>;
  conversation_id: string;
  is_do_not_remember?: boolean | null;
  default_model_slug?: string;
}

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  create_time: number | null;
}

export async function discoverConversationFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`ChatGPT imports directory is not readable: ${directory}`, { cause: error });
  }

  const candidates: Array<{ path: string; realPath: string; suffix: number | null; symlink: boolean }> = [];
  for (const entry of entries) {
    const match = CONVERSATION_FILE.exec(entry.name);
    if (!match) continue;
    const candidate = path.resolve(directory, entry.name);
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      candidates.push({
        path: candidate,
        realPath: await realpath(candidate),
        suffix: match[1] === undefined ? null : Number(match[1]),
        symlink: entry.isSymbolicLink(),
      });
    } catch {
      // A directory entry can disappear while discovery is in progress; it is not importable.
    }
  }

  candidates.sort((left, right) => {
    if (left.suffix === null) return right.suffix === null ? left.path.localeCompare(right.path) : -1;
    if (right.suffix === null) return 1;
    return left.suffix - right.suffix || Number(left.symlink) - Number(right.symlink) || left.path.localeCompare(right.path);
  });
  const seen = new Set<string>();
  const files = candidates.filter(candidate => {
    if (seen.has(candidate.realPath)) return false;
    seen.add(candidate.realPath);
    return true;
  }).map(candidate => candidate.path);

  if (files.length === 0) {
    throw new Error(`No conversation export files found in ${directory}; expected conversations.json or conversations-<digits>.json`);
  }
  return files;
}

export async function* streamConversations(
  file: string,
  maxConversationBytes = DEFAULT_MAX_CONVERSATION_BYTES,
  openFile: (file: string) => Readable = createReadStream,
): AsyncGenerator<Conversation> {
  const input = openFile(file);
  const values = streamArray.withParserAsStream();
  input.on('error', error => values.destroy(error));
  input.pipe(values);
  let record = 0;
  try {
    for await (const item of values as AsyncIterable<StreamArrayItem>) {
      record++;
      const value = item.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${file}: record ${record} is not a usable conversation object`);
      }
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes > maxConversationBytes) {
        throw new Error(`${file}: record ${record} exceeds maximum conversation size of ${maxConversationBytes} bytes (${bytes} bytes)`);
      }
      yield value as Conversation;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(file)) throw error;
    throw new Error(`${file}: expected a valid top-level root array (near record ${record + 1}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    input.unpipe(values);
    input.destroy();
    values.destroy();
  }
}

export function walkConversation(mapping: Record<string, MappingNode>): Turn[] {
  // Find root node (no parent)
  let rootId: string | null = null;
  for (const [id, node] of Object.entries(mapping)) {
    if (node.parent === null) {
      rootId = id;
      break;
    }
  }
  if (!rootId) return [];

  // Walk following first child path
  const turns: Turn[] = [];
  let current: string | null = rootId;
  while (current) {
    const node: MappingNode | undefined = mapping[current];
    if (!node) break;

    const msg = node.message;
    if (msg?.author?.role && (msg.author.role === 'user' || msg.author.role === 'assistant')) {
      const parts = msg.content?.parts ?? [];
      const textParts = parts.filter((p: any) => typeof p === 'string');
      const text = textParts.join('\n').trim();
      if (text) {
        turns.push({
          role: msg.author.role as 'user' | 'assistant',
          text,
          create_time: msg.create_time ?? null,
        });
      }
    }

    current = node.children?.[0] ?? null;
  }
  return turns;
}

export function buildChunks(conv: Conversation, turns: Turn[]): { content: string; sourceKey: string; createdAt: string }[] {
  const title = conv.title || 'Untitled';
  const chunks: { content: string; sourceKey: string; createdAt: string }[] = [];

  // Group into turn-pairs (user+assistant = 1 pair)
  const pairs: { user: Turn; assistant: Turn }[] = [];
  for (let i = 0; i < turns.length - 1; i++) {
    if (turns[i].role === 'user' && turns[i + 1].role === 'assistant') {
      pairs.push({ user: turns[i], assistant: turns[i + 1] });
      i++;
    }
  }

  if (pairs.length === 0) return [];

  const formatPair = (p: { user: Turn; assistant: Turn }) =>
    `User: ${p.user.text}\nAssistant: ${p.assistant.text}`;

  const fullContent = `[${title}]\n\n` + pairs.map(formatPair).join('\n\n');

  if (fullContent.length <= MAX_CONTENT) {
    const earliestTime = pairs[0].user.create_time ?? conv.create_time;
    chunks.push({
      content: fullContent,
      sourceKey: `chatgpt-conv:${conv.conversation_id}:0`,
      createdAt: new Date(earliestTime * 1000).toISOString(),
    });
  } else {
    for (let i = 0; i < pairs.length; i += TURNS_PER_CHUNK) {
      const group = pairs.slice(i, i + TURNS_PER_CHUNK);
      let content = `[${title}]\n\n` + group.map(formatPair).join('\n\n');
      if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT);

      const earliestTime = group[0].user.create_time ?? conv.create_time;
      const chunkIdx = Math.floor(i / TURNS_PER_CHUNK);
      chunks.push({
        content,
        sourceKey: `chatgpt-conv:${conv.conversation_id}:${chunkIdx}`,
        createdAt: new Date(earliestTime * 1000).toISOString(),
      });
    }
  }

  return chunks;
}

export interface PendingChunk {
  content: string;
  sourceKey: string;
  createdAt: string;
  metadata: string;
}

export interface QueryClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export async function commitChunkBatch(
  pending: PendingChunk[],
  embedder: BatchEmbedder,
  client: QueryClient,
): Promise<number> {
  const unique = [...new Map(pending.map(chunk => [chunk.sourceKey, chunk])).values()];
  if (unique.length === 0) return 0;

  const prepared = await prepareCanonicalEmbeddingBatch(unique.map(chunk => chunk.content), embedder);
  const values: unknown[] = [];
  const rows = unique.map((chunk, index) => {
    const base = index * 11;
    values.push(
      chunk.content,
      `[${prepared.embeddings[index].join(',')}]`,
      'chatgpt-conversation',
      'personal',
      '{}',
      chunk.metadata,
      chunk.sourceKey,
      chunk.createdAt,
      prepared.descriptor.provider,
      prepared.descriptor.model,
      prepared.descriptor.dimensions,
    );
    return `(gen_random_uuid(), $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, 'preseed-chatgpt', $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, 'synced', $${base + 8})`;
  });
  const sql = `INSERT INTO memories (id, content, embedding, source, namespace, tags, metadata, client_id, source_key, created_at, embedding_provider, embedding_model, embedding_dimensions, memory_kind, valid_from)\nVALUES ${rows.join(',\n')}\nON CONFLICT (client_id, source_key) WHERE source_key IS NOT NULL DO UPDATE SET\n  content = EXCLUDED.content,\n  embedding = EXCLUDED.embedding,\n  embedding_provider = EXCLUDED.embedding_provider,\n  embedding_model = EXCLUDED.embedding_model,\n  embedding_dimensions = EXCLUDED.embedding_dimensions,\n  memory_kind = EXCLUDED.memory_kind,\n  created_at = EXCLUDED.created_at,\n  updated_at = NOW()\nWHERE memories.deleted_at IS NULL\n  AND memories.superseded_at IS NULL\n  AND memories.consolidated_into_id IS NULL\nRETURNING id`;

  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    await client.query("SELECT set_config('app.current_namespace', 'personal', true)");
    const result = await client.query(sql, values);
    await client.query('COMMIT');
    const writeResult = result as { command?: string; rowCount?: number };
    const written = writeResult.command === 'INSERT' && typeof writeResult.rowCount === 'number'
      ? writeResult.rowCount
      : unique.length;
    if (written < unique.length) console.warn(`[preseed-chatgpt] Skipped ${unique.length - written} tombstoned or superseded source-key conflict(s)`);
    return written;
  } catch (error) {
    if (began) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
    }
    throw error;
  }
}

export interface ImportSummary {
  files: number;
  conversationsAccepted: number;
  conversationsSkipped: number;
  chunksCommitted: number;
  minDate: string | null;
  maxDate: string | null;
}

export interface ImportOptions {
  maxConversationBytes?: number;
  onPendingSize?: (size: number) => void;
}

export async function importConversationFiles(
  files: string[],
  client: QueryClient,
  embedder: BatchEmbedder,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const pending: PendingChunk[] = [];
  const summary: ImportSummary = {
    files: files.length,
    conversationsAccepted: 0,
    conversationsSkipped: 0,
    chunksCommitted: 0,
    minDate: null,
    maxDate: null,
  };

  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    const committed = await commitChunkBatch(batch, embedder, client);
    summary.chunksCommitted += committed;
    for (const chunk of batch) {
      if (summary.minDate === null || chunk.createdAt < summary.minDate) summary.minDate = chunk.createdAt;
      if (summary.maxDate === null || chunk.createdAt > summary.maxDate) summary.maxDate = chunk.createdAt;
    }
  };

  for (const file of files) {
    for await (const conv of streamConversations(file, options.maxConversationBytes)) {
      if (
        conv.is_do_not_remember === true
        || typeof conv.conversation_id !== 'string'
        || !conv.conversation_id
        || !conv.mapping
        || typeof conv.mapping !== 'object'
        || !Number.isFinite(conv.create_time)
      ) {
        summary.conversationsSkipped++;
        continue;
      }

      const turns = walkConversation(conv.mapping);
      const totalText = turns.map(turn => turn.text).join(' ');
      const userAssistantTurns = turns.filter(turn => turn.role === 'user' || turn.role === 'assistant');
      if (totalText.length < 100 || userAssistantTurns.length < 2 || (!conv.title && totalText.length < 200)) {
        summary.conversationsSkipped++;
        continue;
      }

      const chunks = buildChunks(conv, turns);
      if (chunks.length === 0) {
        summary.conversationsSkipped++;
        continue;
      }
      summary.conversationsAccepted++;
      const metadata = JSON.stringify({ title: conv.title || 'Untitled', model: conv.default_model_slug || null });
      for (const chunk of chunks) {
        pending.push({ ...chunk, metadata });
        options.onPendingSize?.(pending.length);
        if (pending.length === 10) await flush();
      }
    }
  }
  await flush();
  return summary;
}

export function parseImportArguments(args: string[], env: NodeJS.ProcessEnv = process.env): { directory: string; maxConversationBytes: number } {
  let directory: string | undefined;
  let maxConversationBytes = DEFAULT_MAX_CONVERSATION_BYTES;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--max-conversation-bytes') {
      const value = args[++index];
      if (value === undefined) throw new Error('--max-conversation-bytes requires a value');
      maxConversationBytes = Number(value);
    } else if (argument.startsWith('--max-conversation-bytes=')) {
      maxConversationBytes = Number(argument.slice(argument.indexOf('=') + 1));
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (directory === undefined) {
      directory = argument;
    } else {
      throw new Error('Provide only one ChatGPT imports directory');
    }
  }
  directory ??= env.CHATGPT_IMPORTS_DIR?.trim();
  if (!directory) throw new Error('Provide CHATGPT_IMPORTS_DIR or a CLI imports directory');
  if (!Number.isSafeInteger(maxConversationBytes) || maxConversationBytes <= 0 || maxConversationBytes > HARD_MAX_CONVERSATION_BYTES) {
    throw new Error(`--max-conversation-bytes must be a positive integer no greater than ${HARD_MAX_CONVERSATION_BYTES}`);
  }
  return { directory: path.resolve(directory), maxConversationBytes };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { directory, maxConversationBytes } = parseImportArguments(args);

  // #41 requires this fail-closed gate before reading exports or doing provider/database work until #9 lands.
  requireEmbeddingIdentityWriter();

  const files = await discoverConversationFiles(directory);
  if (maxConversationBytes > DEFAULT_MAX_CONVERSATION_BYTES) {
    console.warn(`Warning: a ${maxConversationBytes}-byte conversation can require substantially more Node heap while parsed`);
  }

  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    const summary = await importConversationFiles(files, client, embedBatch, { maxConversationBytes });
    console.log(`Done: ${summary.files} files, ${summary.conversationsAccepted} conversations accepted, ${summary.conversationsSkipped} skipped, ${summary.chunksCommitted} chunks committed`);
    console.log(summary.minDate === null ? 'Date range: none' : `Date range: ${summary.minDate.slice(0, 10)} → ${summary.maxDate!.slice(0, 10)}`);
  } finally {
    client?.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exitCode = 1;
  });
}
