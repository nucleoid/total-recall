import pg from 'pg';
import fs from 'fs';
import * as cheerio from 'cheerio';

const DATABASE_URL = process.env.OWNER_DATABASE_URL || 'postgresql://total_recall:total_recall_dev@localhost:5432/total_recall';
const OLLAMA_URL = 'http://localhost:11434/api/embed';
const HTML_PATH = '/home/fuego/projects/total-recall/imports/gemini-new/Takeout/My Activity/Gemini Apps/MyActivity.html';

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

function htmlToText(html: string): string {
  return html
    .replace(/<h[1-6][^>]*>/gi, '\n### ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<blockquote[^>]*>/gi, '\n> ')
    .replace(/<\/blockquote>/gi, '\n')
    .replace(/<code[^>]*>/gi, '`')
    .replace(/<\/code>/gi, '`')
    .replace(/<pre[^>]*>/gi, '\n```\n')
    .replace(/<\/pre>/gi, '\n```\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<strong[^>]*>/gi, '**')
    .replace(/<\/strong>/gi, '**')
    .replace(/<em[^>]*>/gi, '*')
    .replace(/<\/em>/gi, '*')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&emsp;/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const TS_RE = /^(\w+)\s+(\d+),\s+(\d{4}),\s+(\d+):(\d+):(\d+)\s+(AM|PM)\s+(NZ[DS]T)$/;
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function parseTimestamp(ts: string): string | null {
  const m = ts.match(TS_RE);
  if (!m) return null;
  const month = MONTHS[m[1]];
  if (month === undefined) return null;
  let hour = parseInt(m[4]);
  if (m[7] === 'PM' && hour !== 12) hour += 12;
  if (m[7] === 'AM' && hour === 12) hour = 0;
  const offset = m[8] === 'NZDT' ? 13 : 12;
  const utcMs = Date.UTC(parseInt(m[3]), month, parseInt(m[2]), hour - offset, parseInt(m[5]), parseInt(m[6]));
  return new Date(utcMs).toISOString();
}

interface ParsedConv {
  prompt: string;
  response: string;
  timestamp: string;
  index: number;
}

function parseHTML(htmlContent: string): ParsedConv[] {
  const $ = cheerio.load(htmlContent);
  const results: ParsedConv[] = [];
  let index = 0;

  $('div.outer-cell').each((_, outerEl) => {
    const cc = $(outerEl).find('div.content-cell.mdl-cell--6-col').first();
    if (!cc.length) return;
    const text = cc.text().replace(/\u00a0/g, ' ');
    if (!text.startsWith('Prompted ')) return;

    const cellHtml = cc.html() || '';
    const parts = cellHtml.split(/<br\s*\/?>/);
    if (parts.length < 3) return;

    // Prompt is always first part
    const prompt = parts[0].replace(/&nbsp;/g, ' ').replace(/^Prompted\s*/, '').replace(/<[^>]+>/g, '').trim();
    if (!prompt) return;

    // Find timestamp by scanning parts
    let tsIdx = -1;
    let timestamp: string | null = null;
    for (let i = 1; i < Math.min(parts.length, 5); i++) {
      const clean = parts[i].replace(/<[^>]+>/g, '').trim();
      timestamp = parseTimestamp(clean);
      if (timestamp) { tsIdx = i; break; }
    }
    if (!timestamp || tsIdx < 0) return;

    // Response is everything after the timestamp part
    const responseHtml = parts.slice(tsIdx + 1).join('<br>');
    const response = htmlToText(responseHtml);
    if (response.length < 50) return;

    results.push({ prompt, response, timestamp, index: index++ });
  });

  return results;
}

const UPSERT_SQL = `
INSERT INTO memories (id, content, embedding, source, namespace, tags, metadata, client_id, source_key, created_at)
VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'preseed-gemini', $7, $8)
ON CONFLICT (source_key) DO UPDATE SET
  content = EXCLUDED.content,
  embedding = EXCLUDED.embedding,
  created_at = EXCLUDED.created_at,
  updated_at = NOW()
`;

async function main() {
  console.log('Reading HTML file...');
  const html = fs.readFileSync(HTML_PATH, 'utf-8');

  console.log('Parsing conversations...');
  const conversations = parseHTML(html);
  console.log(`Found ${conversations.length} valid conversations`);

  if (!conversations.length) { console.log('Nothing to import'); return; }

  const client = await pool.connect();
  try {
    let imported = 0, errors = 0;
    const dates: string[] = [];

    for (const conv of conversations) {
      const content = `Q: ${conv.prompt}\n\nA: ${conv.response}`.slice(0, 4000);
      const sourceKey = `gemini-conv:${conv.index}:${conv.timestamp}`;

      try {
        const embedding = await getEmbedding(content);
        const embeddingStr = `[${embedding.join(',')}]`;

        await client.query(UPSERT_SQL, [
          content, embeddingStr, 'gemini-conversation', 'personal',
          '{}',  // empty Postgres text[] array
          JSON.stringify({}), sourceKey, conv.timestamp,
        ]);

        imported++;
        dates.push(conv.timestamp);
        if (imported % 50 === 0) console.log(`  Imported ${imported}/${conversations.length}...`);
        await sleep(100);
      } catch (err: any) {
        errors++;
        if (errors <= 3) console.error(`  Error on conv ${conv.index}: ${err.message}`);
      }
    }

    dates.sort();
    console.log(`\nDone! Imported ${imported} conversations (${errors} errors)`);
    if (dates.length) console.log(`Date range: ${dates[0]} → ${dates[dates.length - 1]}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
