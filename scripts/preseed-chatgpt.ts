import pg from 'pg';
import fs from 'fs';
import path from 'path';

const DATABASE_URL = process.env.OWNER_DATABASE_URL || 'postgresql://total_recall:total_recall_dev@localhost:5432/total_recall';
const OLLAMA_URL = 'http://localhost:11434/api/embed';
const IMPORTS_DIR = '/home/fuego/projects/total-recall/imports/chatgpt';
const MAX_CONTENT = 4000;
const TURNS_PER_CHUNK = 5;

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface MappingNode {
  message?: {
    author?: { role: string };
    content?: { content_type: string; parts?: any[] };
    create_time?: number | null;
  } | null;
  parent: string | null;
  children: string[];
}

interface Conversation {
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

function walkConversation(mapping: Record<string, MappingNode>): Turn[] {
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
    const node = mapping[current];
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

function buildChunks(conv: Conversation, turns: Turn[]): { content: string; sourceKey: string; createdAt: string }[] {
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

const UPSERT_SQL = `
INSERT INTO memories (id, content, embedding, source, namespace, tags, metadata, client_id, source_key, created_at)
VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'preseed-chatgpt', $7, $8)
ON CONFLICT (source_key) DO UPDATE SET
  content = EXCLUDED.content,
  embedding = EXCLUDED.embedding,
  created_at = EXCLUDED.created_at,
  updated_at = NOW()
`;

async function main() {
  const allConversations: Conversation[] = [];
  for (let i = 0; i <= 8; i++) {
    const fname = `conversations-${String(i).padStart(3, '0')}.json`;
    const raw = fs.readFileSync(path.join(IMPORTS_DIR, fname), 'utf-8');
    allConversations.push(...JSON.parse(raw));
  }
  console.log(`Loaded ${allConversations.length} conversations`);

  const client = await pool.connect();

  let totalMemories = 0;
  let skipped = 0;
  let minDate = Infinity;
  let maxDate = 0;

  for (let ci = 0; ci < allConversations.length; ci++) {
    const conv = allConversations[ci];

    if (conv.is_do_not_remember === true) { skipped++; continue; }

    const turns = walkConversation(conv.mapping);
    const totalText = turns.map(t => t.text).join(' ');
    if (totalText.length < 100) { skipped++; continue; }

    const userAssistantTurns = turns.filter(t => t.role === 'user' || t.role === 'assistant');
    if (userAssistantTurns.length < 2) { skipped++; continue; }

    if (!conv.title && totalText.length < 200) { skipped++; continue; }

    const chunks = buildChunks(conv, turns);
    if (chunks.length === 0) { skipped++; continue; }

    const metadata = JSON.stringify({
      title: conv.title || 'Untitled',
      model: conv.default_model_slug || null,
    });

    for (const chunk of chunks) {
      const embedding = await getEmbedding(chunk.content);
      const vectorStr = `[${embedding.join(',')}]`;

      await client.query(UPSERT_SQL, [
        chunk.content,
        vectorStr,
        'chatgpt-conversation',
        'personal',
        '{}',
        metadata,
        chunk.sourceKey,
        chunk.createdAt,
      ]);

      totalMemories++;
      await sleep(100);

      const ts = new Date(chunk.createdAt).getTime();
      if (ts < minDate) minDate = ts;
      if (ts > maxDate) maxDate = ts;
    }

    if ((ci + 1) % 50 === 0) {
      console.log(`  Progress: ${ci + 1}/${allConversations.length} conversations, ${totalMemories} memories`);
    }
  }

  client.release();
  await pool.end();

  const from = new Date(minDate).toISOString().split('T')[0];
  const to = new Date(maxDate).toISOString().split('T')[0];
  console.log(`\n✅ Done: ${totalMemories} memories from ${allConversations.length - skipped} conversations (${skipped} skipped)`);
  console.log(`📅 Date range: ${from} → ${to}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
