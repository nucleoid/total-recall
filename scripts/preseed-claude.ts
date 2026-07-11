import pg from 'pg';
import fs from 'fs';
import path from 'path';

const DATABASE_URL = 'postgresql://total_recall:total_recall_dev@localhost:5432/total_recall';
const OLLAMA_URL = 'http://localhost:11434/api/embed';
const IMPORTS_DIR = '/home/fuego/projects/total-recall/imports/claude';

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const TRIVIAL_MESSAGES = new Set(['yes', 'no', 'ok', 'okay', 'thanks', 'thank you', 'yep', 'nope', 'sure', 'got it', 'cool', 'nice', 'great', 'right', 'correct', 'exactly', 'agreed', 'perfect']);

interface ChatMessage {
  uuid: string;
  text: string;
  content: { type: string; text: string }[];
  sender: 'human' | 'assistant';
  created_at: string;
  updated_at: string;
}

interface Conversation {
  uuid: string;
  name: string;
  summary: string;
  created_at: string;
  updated_at: string;
  chat_messages: ChatMessage[];
}

interface MemoryExport {
  conversations_memory: string;
  account_uuid: string;
}

async function getEmbedding(text: string): Promise<number[]> {
  const resp = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: text.slice(0, 8000) }),
  });
  if (!resp.ok) throw new Error(`Ollama error: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as { embeddings: number[][] };
  return data.embeddings[0];
}

function extractTags(conversationName: string): string[] {
  const stopWords = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'in', 'on', 'to', 'of', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'how', 'what', 'why', 'when', 'where', 'which', 'that', 'this', 'from', 'by', 'at', 'it', 'its', 'not', 'but', 'if', 'do', 'does', 'did', 'has', 'have', 'had', 'can', 'could', 'will', 'would', 'should', 'may', 'might']);
  return conversationName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s-]+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 8);
}

function getMessageText(msg: ChatMessage): string {
  if (msg.text) return msg.text;
  if (msg.content?.length) {
    return msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  }
  return '';
}

const UPSERT_SQL = `
INSERT INTO memories (id, content, embedding, source, namespace, tags, metadata, client_id, source_key, created_at)
VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'preseed-claude', $7, $8)
ON CONFLICT (source_key) DO UPDATE SET
  content = EXCLUDED.content,
  embedding = EXCLUDED.embedding,
  created_at = EXCLUDED.created_at,
  updated_at = NOW()
`;

async function importConversations(client: pg.PoolClient): Promise<number> {
  const raw = fs.readFileSync(path.join(IMPORTS_DIR, 'conversations.json'), 'utf-8');
  const conversations: Conversation[] = JSON.parse(raw);
  let count = 0;

  for (const conv of conversations) {
    const msgs = conv.chat_messages;
    if (msgs.length < 2) {
      console.log(`  Skip "${conv.name}" (${msgs.length} msgs)`);
      continue;
    }

    const tags = extractTags(conv.name);
    let pairCount = 0;

    for (let i = 0; i < msgs.length - 1; i++) {
      const human = msgs[i];
      const assistant = msgs[i + 1];

      if (human.sender !== 'human' || assistant.sender !== 'assistant') continue;
      i++; // skip assistant on next iteration

      const humanText = getMessageText(human);
      const assistantText = getMessageText(assistant);

      // Filter trivial exchanges
      if (TRIVIAL_MESSAGES.has(humanText.trim().toLowerCase().replace(/[.!?,]/g, ''))) continue;
      if (assistantText.length < 50) continue;

      let content = `Q: ${humanText}\n\nA: ${assistantText}`;
      if (content.length > 4000) content = content.slice(0, 4000);

      const sourceKey = `claude-conv:${conv.uuid}:${human.uuid}`;
      const metadata = {
        conversation_name: conv.name,
        conversation_uuid: conv.uuid,
        message_uuid: human.uuid,
      };

      const embedding = await getEmbedding(content);
      const vectorStr = `[${embedding.join(',')}]`;

      await client.query(UPSERT_SQL, [
        content, vectorStr, 'claude-conversation', 'work',
        tags, JSON.stringify(metadata), sourceKey, human.created_at,
      ]);

      pairCount++;
      count++;
      await sleep(100);
    }

    console.log(`  "${conv.name}" → ${pairCount} pairs`);
  }

  return count;
}

async function importMemories(client: pg.PoolClient, latestDate: string): Promise<number> {
  const raw = fs.readFileSync(path.join(IMPORTS_DIR, 'memories.json'), 'utf-8');
  const entries: MemoryExport[] = JSON.parse(raw);
  const memoryText = entries[0].conversations_memory;

  // Chunk on paragraph boundaries
  const paragraphs = memoryText.split(/\n\n+/).filter(p => p.trim().length > 20);
  let count = 0;

  // Group small paragraphs together (~500-1000 chars per chunk)
  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if (current && (current.length + p.length) > 1000) {
      chunks.push(current.trim());
      current = p;
    } else {
      current = current ? current + '\n\n' + p : p;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  for (let i = 0; i < chunks.length; i++) {
    const sourceKey = `claude-memory:${i}`;
    const embedding = await getEmbedding(chunks[i]);
    const vectorStr = `[${embedding.join(',')}]`;

    await client.query(UPSERT_SQL, [
      chunks[i], vectorStr, 'claude-memory', 'work',
      ['claude', 'memory', 'profile'],
      JSON.stringify({ chunk_index: i, total_chunks: chunks.length }),
      sourceKey, latestDate,
    ]);

    count++;
    await sleep(100);
  }

  console.log(`  Memory document → ${count} chunks`);
  return count;
}

async function main() {
  const client = await pool.connect();

  console.log('=== Importing Claude conversations ===');
  const convCount = await importConversations(client);

  // Find latest conversation date for memory timestamp
  const raw = fs.readFileSync(path.join(IMPORTS_DIR, 'conversations.json'), 'utf-8');
  const conversations: Conversation[] = JSON.parse(raw);
  const latestDate = conversations.reduce((max, c) => c.updated_at > max ? c.updated_at : max, conversations[0].created_at);

  console.log('\n=== Importing Claude memories ===');
  const memCount = await importMemories(client, latestDate);

  client.release();
  await pool.end();

  console.log(`\n✅ Done: ${convCount} conversation pairs + ${memCount} memory chunks = ${convCount + memCount} total`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
