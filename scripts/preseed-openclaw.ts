import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { glob } from 'glob';
import pg from 'pg';
import { embedBatch } from '../src/embedding.js';
import { assertSafeImportRole, commitImportBatch, type ImportMemoryRow, type QueryClient } from './lib/preseed-db.js';
import { requireEmbeddingIdentityWriter, type BatchEmbedder } from './lib/preseed-embedding.js';

const BATCH_SIZE = 10;

interface FileSpec {
  pattern: string;
  namespace: 'personal' | 'projects' | 'shared';
  source: string;
  base: 'workspace' | 'cortex';
}

const FILE_SPECS: FileSpec[] = [
  { pattern: 'MEMORY.md', namespace: 'personal', source: 'openclaw-memory', base: 'workspace' },
  { pattern: 'USER.md', namespace: 'personal', source: 'openclaw-user', base: 'workspace' },
  { pattern: 'TOOLS.md', namespace: 'projects', source: 'openclaw-tools', base: 'workspace' },
  { pattern: 'HEARTBEAT.md', namespace: 'projects', source: 'openclaw-heartbeat', base: 'workspace' },
  { pattern: 'AGENTS.md', namespace: 'projects', source: 'openclaw-agents', base: 'workspace' },
  { pattern: 'IDENTITY.md', namespace: 'personal', source: 'openclaw-identity', base: 'workspace' },
  { pattern: 'memory/*.md', namespace: 'personal', source: 'openclaw-daily', base: 'workspace' },
  { pattern: 'journals/*.md', namespace: 'personal', source: 'cortex-journal', base: 'cortex' },
  { pattern: 'concepts/*.md', namespace: 'projects', source: 'cortex-concept', base: 'cortex' },
  { pattern: 'projects/*.md', namespace: 'projects', source: 'cortex-project', base: 'cortex' },
  { pattern: 'documents/*.md', namespace: 'shared', source: 'cortex-document', base: 'cortex' },
];

export interface Chunk {
  content: string;
  heading: string;
  sourceKey: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

function extractFrontmatter(text: string): { tags: string[]; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { tags: [], body: text };
  const tagMatch = match[1].match(/tags:\s*\[([^\]]*)\]/);
  const tags = tagMatch
    ? tagMatch[1].split(',').map(tag => tag.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    : [];
  return { tags, body: match[2] };
}

export function chunkMarkdown(content: string, source: string, relPath: string, now = new Date().toISOString()): Chunk[] {
  const { tags, body } = extractFrontmatter(content);
  const chunks: Chunk[] = [];
  const add = (text: string, heading: string, keyHeading: string) => chunks.push({
    content: text,
    heading,
    sourceKey: `${source}:${relPath}:${keyHeading}`,
    tags,
    metadata: { file: relPath, heading, preseed_at: now },
  });
  const sections = body.split(/^(## .+)$/m);
  if (sections.length <= 1) {
    const text = body.trim();
    if (text.length >= 10) add(text, '(root)', '(root)');
    return chunks;
  }
  const preamble = sections[0].trim();
  if (preamble.length >= 10) add(preamble, '(preamble)', '(preamble)');
  for (let index = 1; index < sections.length; index += 2) {
    const heading = sections[index].trim();
    const sectionBody = (sections[index + 1] || '').trim();
    if (!sectionBody || sectionBody.length < 5) continue;
    const fullContent = `${heading}\n${sectionBody}`;
    if (fullContent.length > 2000) {
      const subSections = sectionBody.split(/^(### .+)$/m);
      if (subSections.length > 1) {
        const subPreamble = subSections[0].trim();
        if (subPreamble.length >= 10) add(`${heading}\n${subPreamble}`, heading, heading);
        for (let subIndex = 1; subIndex < subSections.length; subIndex += 2) {
          const subHeading = subSections[subIndex].trim();
          const subBody = (subSections[subIndex + 1] || '').trim();
          if (subBody.length < 5) continue;
          add(`${heading}\n${subHeading}\n${subBody}`, `${heading} > ${subHeading}`, `${heading}:${subHeading}`);
        }
        continue;
      }
    }
    add(fullContent, heading, heading);
  }
  return chunks;
}

export interface OpenClawOptions {
  databaseUrl: string;
  workspace: string;
  cortexContent: string;
  secondBrain: string;
}

export function parseOpenClawArguments(args: string[], env: NodeJS.ProcessEnv = process.env): OpenClawOptions {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required for OpenClaw import');
  if (args.length > 1) throw new Error('Provide at most one OpenClaw workspace path');
  const configured = args[0]?.trim() || env.OPENCLAW_WORKSPACE?.trim();
  if (!configured) throw new Error('Provide OPENCLAW_WORKSPACE or a CLI workspace path');
  const workspace = path.resolve(configured);
  return {
    databaseUrl,
    workspace,
    cortexContent: path.resolve(env.OPENCLAW_CORTEX_CONTENT?.trim() || path.join(workspace, 'projects/cortex/content')),
    secondBrain: path.resolve(env.OPENCLAW_SECOND_BRAIN?.trim() || path.join(workspace, 'second-brain')),
  };
}

interface PoolClient extends QueryClient { release(): void }
interface ImportPool { connect(): Promise<PoolClient>; end(): Promise<void> }
interface FileInfo { isDirectory(): boolean }
interface GlobOptions { cwd: string; absolute: boolean }
export interface OpenClawDependencies {
  gate(): void;
  createPool(connectionString: string): ImportPool;
  stat(file: string): Promise<FileInfo>;
  glob(pattern: string, options: GlobOptions): Promise<string[]>;
  realpath(file: string): Promise<string>;
  readFile(file: string): Promise<string>;
  embedBatch: BatchEmbedder;
  now(): string;
  log(message: string): void;
}

const defaultDependencies: OpenClawDependencies = {
  gate: requireEmbeddingIdentityWriter,
  createPool: connectionString => new pg.Pool({ connectionString, max: 1 }),
  stat,
  glob,
  realpath,
  readFile: file => readFile(file, 'utf8'),
  embedBatch,
  now: () => new Date().toISOString(),
  log: message => console.log(message),
};

async function directoryExists(directory: string, dependencies: OpenClawDependencies): Promise<boolean> {
  try { return (await dependencies.stat(directory)).isDirectory(); } catch { return false; }
}

export async function executeOpenClawImport(
  options: OpenClawOptions,
  dependencies: OpenClawDependencies = defaultDependencies,
): Promise<{ files: number; chunks: number }> {
  dependencies.gate();
  const pool = dependencies.createPool(options.databaseUrl);
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await assertSafeImportRole(client);
    if (!await directoryExists(options.workspace, dependencies)) {
      throw new Error(`OpenClaw workspace is not a readable directory: ${options.workspace}`);
    }
    const hasSecondBrain = await directoryExists(options.secondBrain, dependencies);
    const seen = new Set<string>();
    const rows: ImportMemoryRow[] = [];
    let files = 0;
    const now = dependencies.now();
    for (const spec of FILE_SPECS) {
      const base = spec.base === 'workspace' ? options.workspace : options.cortexContent;
      const candidates = await dependencies.glob(spec.pattern, { cwd: base, absolute: true });
      if (spec.base === 'cortex' && hasSecondBrain) {
        candidates.push(...await dependencies.glob(spec.pattern, { cwd: options.secondBrain, absolute: true }));
      }
      for (const file of candidates.sort()) {
        const canonical = await dependencies.realpath(file);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        const content = await dependencies.readFile(file);
        if (!content.trim()) { dependencies.log(`Skipping empty: ${file}`); continue; }
        const relPath = path.relative(options.workspace, file);
        const chunks = chunkMarkdown(content, spec.source, relPath, now);
        if (chunks.length === 0) { dependencies.log(`Skipping (no chunks): ${relPath}`); continue; }
        files++;
        dependencies.log(`Processing ${relPath}... ${chunks.length} chunks`);
        for (const chunk of chunks) rows.push({
          content: chunk.content,
          source: spec.source,
          namespace: spec.namespace,
          tags: chunk.tags,
          metadata: JSON.stringify(chunk.metadata),
          sourceKey: chunk.sourceKey,
        });
      }
    }
    for (let index = 0; index < rows.length; index += BATCH_SIZE) {
      await commitImportBatch(rows.slice(index, index + BATCH_SIZE), dependencies.embedBatch, client, 'preseed', {
        updateCreatedAtOnConflict: false,
      });
    }
    dependencies.log(`Pre-seed complete: ${rows.length} chunks from ${files} files`);
    return { files, chunks: rows.length };
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  // #41: remain fail-closed before workspace, provider, or database access until identity storage exists.
  requireEmbeddingIdentityWriter();
  await executeOpenClawImport(parseOpenClawArguments(args));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('Fatal:', error); process.exitCode = 1; });
}
