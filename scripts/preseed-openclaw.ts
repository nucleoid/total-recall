import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';

const DATABASE_URL = 'postgresql://total_recall:total_recall_dev@localhost:5432/total_recall';
const OLLAMA_URL = 'http://localhost:11434/api/embed';
const WORKSPACE = '/home/fuego/.openclaw/workspace';
const CORTEX_CONTENT = path.join(WORKSPACE, 'projects/cortex/content');

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

interface FileSpec {
  pattern: string;
  namespace: string;
  source: string;
  base: string;
}

const FILE_SPECS: FileSpec[] = [
  { pattern: 'MEMORY.md', namespace: 'personal', source: 'openclaw-memory', base: WORKSPACE },
  { pattern: 'USER.md', namespace: 'personal', source: 'openclaw-user', base: WORKSPACE },
  { pattern: 'TOOLS.md', namespace: 'projects', source: 'openclaw-tools', base: WORKSPACE },
  { pattern: 'HEARTBEAT.md', namespace: 'projects', source: 'openclaw-heartbeat', base: WORKSPACE },
  { pattern: 'AGENTS.md', namespace: 'projects', source: 'openclaw-agents', base: WORKSPACE },
  { pattern: 'IDENTITY.md', namespace: 'personal', source: 'openclaw-identity', base: WORKSPACE },
  { pattern: 'memory/*.md', namespace: 'personal', source: 'openclaw-daily', base: WORKSPACE },
  { pattern: 'journals/*.md', namespace: 'personal', source: 'cortex-journal', base: CORTEX_CONTENT },
  { pattern: 'concepts/*.md', namespace: 'projects', source: 'cortex-concept', base: CORTEX_CONTENT },
  { pattern: 'projects/*.md', namespace: 'projects', source: 'cortex-project', base: CORTEX_CONTENT },
  { pattern: 'documents/*.md', namespace: 'shared', source: 'cortex-document', base: CORTEX_CONTENT },
];

const SECOND_BRAIN_ALT = path.join(WORKSPACE, 'second-brain');

interface Chunk {
  content: string;
  heading: string;
  sourceKey: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

function extractFrontmatter(text: string): { tags: string[]; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { tags: [], body: text };
  const fm = match[1];
  const body = match[2];
  const tagMatch = fm.match(/tags:\s*\[([^\]]*)\]/);
  if (!tagMatch) return { tags: [], body };
  const tags = tagMatch[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  return { tags, body };
}

function chunkMarkdown(content: string, source: string, relPath: string): Chunk[] {
  const { tags, body } = extractFrontmatter(content);
  const now = new Date().toISOString();
  const chunks: Chunk[] = [];

  const sections = body.split(/^(## .+)$/m);

  if (sections.length <= 1) {
    const text = body.trim();
    if (!text || text.length < 10) return [];
    chunks.push({
      content: text,
      heading: '(root)',
      sourceKey: `${source}:${relPath}:(root)`,
      tags,
      metadata: { file: relPath, heading: '(root)', preseed_at: now },
    });
    return chunks;
  }

  const preamble = sections[0].trim();
  if (preamble && preamble.length >= 10) {
    chunks.push({
      content: preamble,
      heading: '(preamble)',
      sourceKey: `${source}:${relPath}:(preamble)`,
      tags,
      metadata: { file: relPath, heading: '(preamble)', preseed_at: now },
    });
  }

  for (let i = 1; i < sections.length; i += 2) {
    const heading = sections[i].trim();
    const sectionBody = (sections[i + 1] || '').trim();
    const fullContent = heading + '\n' + sectionBody;

    if (!sectionBody || sectionBody.length < 5) continue;

    if (fullContent.length > 2000) {
      const subSections = sectionBody.split(/^(### .+)$/m);
      if (subSections.length > 1) {
        const subPre = subSections[0].trim();
        if (subPre && subPre.length >= 10) {
          chunks.push({
            content: heading + '\n' + subPre,
            heading,
            sourceKey: `${source}:${relPath}:${heading}`,
            tags,
            metadata: { file: relPath, heading, preseed_at: now },
          });
        }
        for (let j = 1; j < subSections.length; j += 2) {
          const subHeading = subSections[j].trim();
          const subBody = (subSections[j + 1] || '').trim();
          if (!subBody || subBody.length < 5) continue;
          const subFull = heading + '\n' + subHeading + '\n' + subBody;
          chunks.push({
            content: subFull,
            heading: `${heading} > ${subHeading}`,
            sourceKey: `${source}:${relPath}:${heading}:${subHeading}`,
            tags,
            metadata: { file: relPath, heading: `${heading} > ${subHeading}`, preseed_at: now },
          });
        }
        continue;
      }
    }

    chunks.push({
      content: fullContent,
      heading,
      sourceKey: `${source}:${relPath}:${heading}`,
      tags,
      metadata: { file: relPath, heading, preseed_at: now },
    });
  }

  return chunks;
}

async function getEmbedding(text: string): Promise<number[]> {
  const resp = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: "nomic-embed-text", input: text.slice(0, 8000) }),
  });
  if (!resp.ok) throw new Error(`Ollama error: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as { embeddings: number[][] };
  return data.embeddings[0];
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const UPSERT_SQL = `
INSERT INTO memories (id, content, embedding, source, namespace, tags, metadata, client_id, source_key)
VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'preseed', $7)
ON CONFLICT (source_key) DO UPDATE SET
  content = EXCLUDED.content,
  embedding = EXCLUDED.embedding,
  updated_at = NOW()
`;

async function main() {
  let totalChunks = 0;
  let totalFiles = 0;

  const client = await pool.connect();

  for (const spec of FILE_SPECS) {
    const files = await glob(spec.pattern, { cwd: spec.base, absolute: true });

    if (spec.base === CORTEX_CONTENT && fs.existsSync(SECOND_BRAIN_ALT)) {
      const altFiles = await glob(spec.pattern, { cwd: SECOND_BRAIN_ALT, absolute: true });
      for (const f of altFiles) {
        if (!files.includes(f)) files.push(f);
      }
    }

    for (const filePath of files.sort()) {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf-8');
      if (!content.trim()) {
        console.log(`Skipping empty: ${filePath}`);
        continue;
      }

      const relPath = path.relative(WORKSPACE, filePath);
      const chunks = chunkMarkdown(content, spec.source, relPath);

      if (chunks.length === 0) {
        console.log(`Skipping (no chunks): ${relPath}`);
        continue;
      }

      console.log(`Processing ${relPath}... ${chunks.length} chunks`);
      totalFiles++;

      for (const chunk of chunks) {
        const embedding = await getEmbedding(chunk.content);
        const vectorStr = `[${embedding.join(',')}]`;

        await client.query(UPSERT_SQL, [
          chunk.content,
          vectorStr,
          spec.source,
          spec.namespace,
          chunk.tags,
          JSON.stringify(chunk.metadata),
          chunk.sourceKey,
        ]);

        totalChunks++;
        await sleep(100);
      }
    }
  }

  client.release();
  await pool.end();
  console.log(`\nPre-seed complete: ${totalChunks} chunks from ${totalFiles} files`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
