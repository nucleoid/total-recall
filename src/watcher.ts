import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  buildWatchSpecs,
  exclusionReason,
  matchWatchSpec,
  resolveWorkspaceFile,
  resolveWorkspaceRoot,
} from './watcher/paths.js';
import { queryUnscoped, shutdown } from './db.js';
import { embed } from './embedding.js';
import { commitIfCurrent, commitPreparedFile, prepareChunks } from './watcher/sync.js';
import { PathWorkQueue, type PathWork } from './watcher/queue.js';
import { shutdownWatcher } from './watcher/lifecycle.js';
import { upsertSystemAgent } from './agents.js';
import dotenv from 'dotenv';

dotenv.config();

const WORKSPACE = resolveWorkspaceRoot(process.env.OPENCLAW_WORKSPACE, fs.statSync);
const WATCH_SPECS = buildWatchSpecs(WORKSPACE);

function shouldExclude(filePath: string, relPath: string): boolean {
  if (exclusionReason(relPath.split('/').join(path.sep))) return true;
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

function fingerprintFile(filePath: string): Promise<string | null> {
  return fs.promises.readFile(filePath, 'utf8')
    .then((content) => crypto.createHash('sha256').update(content).digest('hex'))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
}

async function processFile(filePath: string, work: PathWork): Promise<void> {
  const spec = matchWatchSpec(filePath, WATCH_SPECS);
  if (!spec) return;

  const identity = resolveWorkspaceFile(WORKSPACE, filePath);
  const { absolutePath, relativePath: relPath } = identity;
  if (shouldExclude(absolutePath, relPath)) return;

  const content = fs.readFileSync(absolutePath, 'utf-8');
  if (content.includes('DELIVERABLE')) return;
  const hash = crypto.createHash('sha256').update(content).digest('hex');

  const storedHash = await getStoredHash(relPath);
  if (storedHash === hash) return;

  const chunks = chunkMarkdown(content, spec.source, relPath);
  const preparedChunks = await prepareChunks(chunks, embed);

  const committed = await commitIfCurrent({
    filePath: absolutePath,
    preparedFingerprint: hash,
    readFingerprint: fingerprintFile,
    work,
    commit: async () => {
      await commitPreparedFile({
        relPath,
        hash,
        namespace: spec.namespace,
        source: spec.source,
        agentId: watcherAgentId,
        chunks: preparedChunks,
      });
      return true;
    },
  });
  if (committed) console.log(`Synced ${relPath}: ${preparedChunks.length} chunks`);
}

async function main() {
  const watcherAgent = await upsertSystemAgent({
    name: 'file-watcher',
    type: 'system',
    runtime: 'total-recall-watcher',
  });
  watcherAgentId = watcherAgent.id;

  const watchPaths = WATCH_SPECS.map(spec => spec.path);
  console.log(`[watcher] Starting file sync watcher...`);
  console.log(`[watcher] Watching ${watchPaths.length} paths`);

  const queue = new PathWorkQueue(processFile);
  const watcher = chokidar.watch(watchPaths, {
    persistent: true,
    ignoreInitial: false,
    followSymlinks: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  const enqueue = (filePath: string) => queue.enqueue(resolveWorkspaceFile(WORKSPACE, filePath).absolutePath);
  watcher
    .on('add', enqueue)
    .on('change', enqueue)
    // #27 will reconcile deletion; queueing now makes unlink/add storms converge on final state.
    .on('unlink', enqueue)
    .on('ready', () => console.log('[watcher] Initial scan complete. Watching for changes...'))
    .on('error', (err) => console.error('[watcher] Error:', err));

  const graceful = async () => {
    console.log('[watcher] Shutting down...');
    try {
      await shutdownWatcher({
        closeWatcher: () => watcher.close(),
        queue,
        shutdownDatabase: shutdown,
        timeoutMs: 30_000,
      });
      process.exit(0);
    } catch (error) {
      console.error('[watcher] Graceful shutdown failed:', error);
      process.exit(1);
    }
  };
  process.on('SIGINT', graceful);
  process.on('SIGTERM', graceful);
}

main().catch(err => {
  console.error('[watcher] Fatal:', err);
  process.exit(1);
});
