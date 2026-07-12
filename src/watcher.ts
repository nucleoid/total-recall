import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { queryUnscoped, shutdown } from './db.js';
import { embed } from './embedding.js';
import { commitPreparedFile, prepareChunks } from './watcher/sync.js';
import { upsertSystemAgent } from './agents.js';
import dotenv from 'dotenv';

dotenv.config();

const WORKSPACE = '/home/fuego/.openclaw/workspace';
const CORTEX_CONTENT = path.join(WORKSPACE, 'projects/cortex/content');
interface WatchSpec {
  paths: string[];
  namespace: string;
  source: string;
}

const WATCH_SPECS: WatchSpec[] = [
  { paths: [path.join(WORKSPACE, 'MEMORY.md')], namespace: 'personal', source: 'openclaw-memory' },
  { paths: [path.join(WORKSPACE, 'USER.md')], namespace: 'personal', source: 'openclaw-user' },
  { paths: [path.join(WORKSPACE, 'IDENTITY.md')], namespace: 'personal', source: 'openclaw-identity' },
  { paths: [path.join(WORKSPACE, 'TOOLS.md')], namespace: 'projects', source: 'openclaw-tools' },
  { paths: [path.join(WORKSPACE, 'HEARTBEAT.md')], namespace: 'projects', source: 'openclaw-heartbeat' },
  { paths: [path.join(WORKSPACE, 'AGENTS.md')], namespace: 'projects', source: 'openclaw-agents' },
  { paths: [path.join(WORKSPACE, 'memory')], namespace: 'personal', source: 'openclaw-daily' },
  { paths: [path.join(CORTEX_CONTENT, 'journals')], namespace: 'personal', source: 'cortex-journal' },
  { paths: [path.join(CORTEX_CONTENT, 'concepts')], namespace: 'projects', source: 'cortex-concept' },
  { paths: [path.join(CORTEX_CONTENT, 'projects')], namespace: 'projects', source: 'cortex-project' },
  { paths: [path.join(CORTEX_CONTENT, 'documents')], namespace: 'shared', source: 'cortex-document' },
];

function resolveSpec(filePath: string): { namespace: string; source: string } | null {
  const abs = path.resolve(filePath);
  for (const spec of WATCH_SPECS) {
    for (const p of spec.paths) {
      if (abs === p || abs.startsWith(p + '/')) {
        return { namespace: spec.namespace, source: spec.source };
      }
    }
  }
  return null;
}

function shouldExclude(filePath: string): boolean {
  if (!filePath.endsWith('.md')) return true;
  if (path.basename(filePath).startsWith('.env')) return true;
  if (filePath.includes('/deliverables/') || filePath.includes('/DELIVERABLE')) return true;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 1_000_000) return true;
  } catch { return true; }
  return false;
}

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
  const tagMatch = match[1].match(/tags:\s*\[([^\]]*)\]/);
  const tags = tagMatch
    ? tagMatch[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    : [];
  return { tags, body: match[2] };
}

function chunkMarkdown(content: string, source: string, relPath: string): Chunk[] {
  const { tags, body } = extractFrontmatter(content);
  const now = new Date().toISOString();
  const chunks: Chunk[] = [];
  const mkKey = (heading: string) => `file-sync:${relPath}:${heading}`;

  const sections = body.split(/^(## .+)$/m);

  if (sections.length <= 1) {
    const text = body.trim();
    if (!text || text.length < 10) return [];
    chunks.push({ content: text, heading: '(root)', sourceKey: mkKey('(root)'), tags, metadata: { file: relPath, heading: '(root)', synced_at: now } });
    return chunks;
  }

  const preamble = sections[0].trim();
  if (preamble && preamble.length >= 10) {
    chunks.push({ content: preamble, heading: '(preamble)', sourceKey: mkKey('(preamble)'), tags, metadata: { file: relPath, heading: '(preamble)', synced_at: now } });
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
          chunks.push({ content: heading + '\n' + subPre, heading, sourceKey: mkKey(heading), tags, metadata: { file: relPath, heading, synced_at: now } });
        }
        for (let j = 1; j < subSections.length; j += 2) {
          const subHeading = subSections[j].trim();
          const subBody = (subSections[j + 1] || '').trim();
          if (!subBody || subBody.length < 5) continue;
          const combined = `${heading} > ${subHeading}`;
          chunks.push({ content: heading + '\n' + subHeading + '\n' + subBody, heading: combined, sourceKey: mkKey(`${heading}:${subHeading}`), tags, metadata: { file: relPath, heading: combined, synced_at: now } });
        }
        continue;
      }
    }

    chunks.push({ content: fullContent, heading, sourceKey: mkKey(heading), tags, metadata: { file: relPath, heading, synced_at: now } });
  }
  return chunks;
}

let watcherAgentId: string | null = null;

async function getStoredHash(filePath: string): Promise<string | null> {
  const res = await queryUnscoped('SELECT content_hash FROM sync_state WHERE file_path = $1', [filePath]);
  return res.rows[0]?.content_hash ?? null;
}

async function processFile(filePath: string): Promise<void> {
  if (shouldExclude(filePath)) return;

  const spec = resolveSpec(filePath);
  if (!spec) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes('DELIVERABLE')) return;

  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const relPath = path.relative(WORKSPACE, filePath);

  const storedHash = await getStoredHash(relPath);
  if (storedHash === hash) return;

  const chunks = chunkMarkdown(content, spec.source, relPath);
  const preparedChunks = await prepareChunks(chunks, embed);

  await commitPreparedFile({
    relPath,
    hash,
    namespace: spec.namespace,
    source: spec.source,
    agentId: watcherAgentId,
    chunks: preparedChunks,
  });
  console.log(`Synced ${relPath}: ${preparedChunks.length} chunks`);
}

const pending = new Map<string, NodeJS.Timeout>();

function debouncedProcess(filePath: string): void {
  const existing = pending.get(filePath);
  if (existing) clearTimeout(existing);
  pending.set(filePath, setTimeout(async () => {
    pending.delete(filePath);
    try {
      await processFile(filePath);
    } catch (err) {
      console.error(`Error processing ${filePath}:`, err);
    }
  }, 500));
}

async function main() {
  const watcherAgent = await upsertSystemAgent({
    name: 'file-watcher',
    type: 'system',
    runtime: 'total-recall-watcher',
  });
  watcherAgentId = watcherAgent.id;

  const watchPaths = WATCH_SPECS.flatMap(s => s.paths);
  console.log(`[watcher] Starting file sync watcher...`);
  console.log(`[watcher] Watching ${watchPaths.length} paths`);

  const watcher = chokidar.watch(watchPaths, {
    persistent: true,
    ignoreInitial: false,
    followSymlinks: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  watcher
    .on('add', (fp) => debouncedProcess(fp))
    .on('change', (fp) => debouncedProcess(fp))
    .on('ready', () => console.log('[watcher] Initial scan complete. Watching for changes...'))
    .on('error', (err) => console.error('[watcher] Error:', err));

  const graceful = async () => {
    console.log('[watcher] Shutting down...');
    await watcher.close();
    await shutdown();
    process.exit(0);
  };
  process.on('SIGINT', graceful);
  process.on('SIGTERM', graceful);
}

main().catch(err => {
  console.error('[watcher] Fatal:', err);
  process.exit(1);
});
