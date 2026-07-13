import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import {
  buildWatchSpecs,
  exclusionReason,
  matchWatchSpec,
  resolveWorkspaceFile,
  resolveWorkspaceRoot,
} from './watcher/paths.js';
import { queryUnscoped, shutdown } from './db.js';
import { embed } from './embedding.js';
import {
  commitIfCurrent,
  commitPreparedFile,
  deleteObservedFile,
  fingerprintContent,
  prepareChunks,
} from './watcher/sync.js';
import { PathWorkQueue, type PathWork } from './watcher/queue.js';
import { shutdownWatcher } from './watcher/lifecycle.js';
import { chunkMarkdown } from './watcher/chunking.js';
import { upsertSystemAgent } from './agents.js';
import dotenv from 'dotenv';

dotenv.config();

const WORKSPACE = resolveWorkspaceRoot(process.env.OPENCLAW_WORKSPACE, fs.statSync);
const WATCH_SPECS = buildWatchSpecs(WORKSPACE);

let watcherAgentId: string | null = null;

async function getStoredHash(filePath: string): Promise<string | null> {
  const res = await queryUnscoped('SELECT content_hash FROM sync_state WHERE file_path = $1', [filePath]);
  return res.rows[0]?.content_hash ?? null;
}

function fingerprintFile(filePath: string): Promise<string | null> {
  return fs.promises.readFile(filePath, 'utf8')
    .then(fingerprintContent)
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
  if (exclusionReason(relPath.split('/').join(path.sep))) return;

  const commitAbsence = () => commitIfCurrent({
    filePath: absolutePath,
    preparedFingerprint: null,
    readFingerprint: fingerprintFile,
    work,
    commit: () => deleteObservedFile({ relPath, namespace: spec.namespace }),
  });

  try {
    if (fs.statSync(absolutePath).size > 1_000_000) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await commitAbsence();
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(absolutePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await commitAbsence();
    return;
  }
  if (content.includes('DELIVERABLE')) return;
  const hash = fingerprintContent(content);

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
