import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { embedBatch } from '../src/embedding.js';
import { assertSafeImportRole, commitImportBatch, type QueryClient } from './lib/preseed-db.js';
import { requireEmbeddingIdentityWriter, type BatchEmbedder } from './lib/preseed-embedding.js';

const BATCH_SIZE = 10;
const TRIVIAL_MESSAGES = new Set(['yes', 'no', 'ok', 'okay', 'thanks', 'thank you', 'yep', 'nope', 'sure', 'got it', 'cool', 'nice', 'great', 'right', 'correct', 'exactly', 'agreed', 'perfect']);

export interface ClaudeImportRow {
  content: string;
  source: 'claude-conversation' | 'claude-memory';
  namespace: 'work';
  tags: string[];
  metadata: string;
  sourceKey: string;
  createdAt: string;
}

export interface ClaudeImportResult {
  rows: ClaudeImportRow[];
  summary: { conversationPairs: number; memoryChunks: number; total: number };
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} export must contain a top-level array`);
  return value;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw new Error(`${context} requires a non-empty ${key}`);
  return value;
}

function extractTags(conversationName: string): string[] {
  const stopWords = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'in', 'on', 'to', 'of', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'how', 'what', 'why', 'when', 'where', 'which', 'that', 'this', 'from', 'by', 'at', 'it', 'its', 'not', 'but', 'if', 'do', 'does', 'did', 'has', 'have', 'had', 'can', 'could', 'will', 'would', 'should', 'may', 'might']);
  return conversationName.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/[\s-]+/)
    .filter(word => word.length > 2 && !stopWords.has(word)).slice(0, 8);
}

function messageText(record: Record<string, unknown>): string {
  if (typeof record.text === 'string' && record.text) return record.text;
  if (!Array.isArray(record.content)) return '';
  return record.content.map(objectRecord)
    .filter((item): item is Record<string, unknown> => item !== null && item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text as string).join('\n');
}

function memoryChunks(text: string): string[] {
  const paragraphs = text.split(/\n\n+/).filter(paragraph => paragraph.trim().length > 20);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > 1000) {
      chunks.push(current.trim());
      current = paragraph;
    } else current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function buildClaudeImport(
  conversationsValue: unknown,
  memoriesValue: unknown,
  memoryFileMtime: Date,
  explicitMemoryTimestamp?: string,
): ClaudeImportResult {
  const conversations = requireArray(conversationsValue, 'Claude conversations');
  const memories = requireArray(memoriesValue, 'Claude memories');
  if (explicitMemoryTimestamp !== undefined && validIso(explicitMemoryTimestamp) === null) {
    throw new Error('Invalid Claude memory timestamp supplied with --memory-timestamp');
  }

  const rows: ClaudeImportRow[] = [];
  let latestConversationDate: string | null = null;
  for (const value of conversations) {
    const conversation = objectRecord(value);
    if (!conversation) throw new Error('Claude conversations entries must be objects');
    for (const candidate of [validIso(conversation.created_at), validIso(conversation.updated_at)]) {
      if (candidate && (latestConversationDate === null || candidate > latestConversationDate)) latestConversationDate = candidate;
    }
    if (conversation.chat_messages === undefined) continue;
    if (!Array.isArray(conversation.chat_messages)) throw new Error('Claude conversation chat_messages must be an array when present');
    for (let index = 0; index < conversation.chat_messages.length - 1; index++) {
      const human = objectRecord(conversation.chat_messages[index]);
      const assistant = objectRecord(conversation.chat_messages[index + 1]);
      if (!human || !assistant || human.sender !== 'human' || assistant.sender !== 'assistant') continue;
      index++;
      const humanText = messageText(human);
      const assistantText = messageText(assistant);
      if (!humanText.trim() || !assistantText.trim()) continue;
      if (TRIVIAL_MESSAGES.has(humanText.trim().toLowerCase().replace(/[.!?,]/g, '')) || assistantText.length < 50) continue;
      const conversationUuid = requiredString(conversation, 'uuid', 'Importable Claude conversation');
      const conversationName = requiredString(conversation, 'name', 'Importable Claude conversation');
      const messageUuid = requiredString(human, 'uuid', 'Importable Claude human message');
      const createdAt = validIso(human.created_at);
      if (!createdAt) throw new Error('Importable Claude human message requires a valid created_at');
      rows.push({
        content: `Q: ${humanText}\n\nA: ${assistantText}`.slice(0, 4000), source: 'claude-conversation', namespace: 'work',
        tags: extractTags(conversationName),
        metadata: JSON.stringify({ conversation_name: conversationName, conversation_uuid: conversationUuid, message_uuid: messageUuid }),
        sourceKey: `claude-conv:${conversationUuid}:${messageUuid}`, createdAt,
      });
    }
  }

  let memoryText = '';
  for (const value of memories) {
    const memory = objectRecord(value);
    if (!memory) throw new Error('Claude memories entries must be objects');
    if (memory.conversations_memory === undefined) continue;
    if (typeof memory.conversations_memory !== 'string') throw new Error('Claude conversations_memory must be a string when present');
    if (memory.conversations_memory.trim()) memoryText += `${memoryText ? '\n\n' : ''}${memory.conversations_memory}`;
  }
  const chunks = memoryChunks(memoryText);
  if (chunks.length > 0) {
    const createdAt = latestConversationDate ?? validIso(explicitMemoryTimestamp)
      ?? (Number.isFinite(memoryFileMtime.getTime()) ? memoryFileMtime.toISOString() : null);
    if (!createdAt) throw new Error('Claude memory timestamp is unavailable; provide --memory-timestamp');
    for (let index = 0; index < chunks.length; index++) {
      rows.push({
        content: chunks[index], source: 'claude-memory', namespace: 'work', tags: ['claude', 'memory', 'profile'],
        metadata: JSON.stringify({ chunk_index: index, total_chunks: chunks.length }),
        sourceKey: `claude-memory:${index}`, createdAt,
      });
    }
  }
  const conversationPairs = rows.filter(row => row.source === 'claude-conversation').length;
  const memoryChunkCount = rows.length - conversationPairs;
  return { rows, summary: { conversationPairs, memoryChunks: memoryChunkCount, total: rows.length } };
}

export interface ClaudeImportOptions { databaseUrl: string; importsDir: string; memoryTimestamp?: string }

export function parseClaudeArguments(args: string[], env: NodeJS.ProcessEnv = process.env): ClaudeImportOptions {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required for Claude import');
  const positional: string[] = [];
  let memoryTimestamp: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--memory-timestamp') {
      const parsed = validIso(args[++index]);
      if (!parsed) throw new Error('--memory-timestamp requires a valid timestamp');
      memoryTimestamp = parsed;
    } else positional.push(args[index]);
  }
  if (positional.length > 1) throw new Error('Provide at most one Claude imports directory');
  const configured = positional[0]?.trim() || env.CLAUDE_IMPORTS_DIR?.trim();
  if (!configured) throw new Error('Provide CLAUDE_IMPORTS_DIR or a CLI imports directory');
  return { databaseUrl, importsDir: path.resolve(configured), ...(memoryTimestamp ? { memoryTimestamp } : {}) };
}

interface PoolClient extends QueryClient { release(): void }
interface ImportPool { connect(): Promise<PoolClient>; end(): Promise<void> }
export interface ClaudeDependencies {
  gate(): void;
  createPool(connectionString: string): ImportPool;
  readFile(file: string): Promise<string>;
  stat(file: string): Promise<{ mtime: Date }>;
  embedBatch: BatchEmbedder;
  log(message: string): void;
}

const defaultDependencies: ClaudeDependencies = {
  gate: requireEmbeddingIdentityWriter,
  createPool: connectionString => new pg.Pool({ connectionString, max: 1 }),
  readFile: file => readFile(file, 'utf8'),
  stat,
  embedBatch,
  log: message => console.log(message),
};

function parseJson(raw: string, label: string): unknown {
  try { return JSON.parse(raw); }
  catch (error) { throw new Error(`${label} export is malformed JSON`, { cause: error }); }
}

export async function executeClaudeImport(
  options: ClaudeImportOptions,
  dependencies: ClaudeDependencies = defaultDependencies,
): Promise<ClaudeImportResult['summary']> {
  dependencies.gate();
  const pool = dependencies.createPool(options.databaseUrl);
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await assertSafeImportRole(client);
    const conversationsFile = path.join(options.importsDir, 'conversations.json');
    const memoriesFile = path.join(options.importsDir, 'memories.json');
    const [conversationsRaw, memoriesRaw] = await Promise.all([
      dependencies.readFile(conversationsFile), dependencies.readFile(memoriesFile),
    ]);
    let memoryMtime = new Date(Number.NaN);
    try { memoryMtime = (await dependencies.stat(memoriesFile)).mtime; } catch { /* explicit timestamp can recover */ }
    const result = buildClaudeImport(
      parseJson(conversationsRaw, 'Claude conversations'),
      parseJson(memoriesRaw, 'Claude memories'),
      memoryMtime,
      options.memoryTimestamp,
    );
    for (let index = 0; index < result.rows.length; index += BATCH_SIZE) {
      await commitImportBatch(result.rows.slice(index, index + BATCH_SIZE), dependencies.embedBatch, client, 'preseed-claude');
    }
    dependencies.log(`Done: ${result.summary.conversationPairs} conversation pairs + ${result.summary.memoryChunks} memory chunks = ${result.summary.total} total`);
    return result.summary;
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  // #41: remain fail-closed before export, provider, or database access until identity storage exists.
  requireEmbeddingIdentityWriter();
  await executeClaudeImport(parseClaudeArguments(args));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('Fatal:', error); process.exitCode = 1; });
}
