import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as cheerio from 'cheerio';
import pg from 'pg';
import { embedBatch } from '../src/embedding.js';
import { prepareCanonicalEmbeddingBatch, requireEmbeddingIdentityWriter, type BatchEmbedder } from './lib/preseed-embedding.js';

const DEFAULT_DATABASE_URL = 'postgresql://total_recall:total_recall_dev@localhost:5432/total_recall';
const SOURCE = 'gemini-conversation';
const CLIENT_ID = 'preseed-gemini';
const NAMESPACE = 'personal';
const BATCH_SIZE = 10;
const MAX_FAILURES_REPORTED = 10;

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
const NAMED_OFFSET_MINUTES: Record<string, number> = { Z: 0, UTC: 0, GMT: 0, NZST: 12 * 60, NZDT: 13 * 60 };
const TIMESTAMP_RE = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)\s+(\S+)$/;

export type TimestampResult = { ok: true; iso: string } | { ok: false; reason: string };

function parseOffset(zone: string): number | null {
  if (Object.hasOwn(NAMED_OFFSET_MINUTES, zone)) return NAMED_OFFSET_MINUTES[zone];
  const match = zone.match(/^(?:UTC|GMT)?([+-])(\d{2})(?::?(\d{2}))?$/);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  if (minutes > 59 || hours > 14 || (hours === 14 && minutes !== 0)) return null;
  return (match[1] === '+' ? 1 : -1) * (hours * 60 + minutes);
}

export function parseGeminiTimestamp(input: string): TimestampResult {
  const match = input.trim().match(TIMESTAMP_RE);
  if (!match) return { ok: false, reason: `Unsupported timestamp syntax: ${input.trim()}` };
  const month = MONTHS[match[1]];
  if (month === undefined) return { ok: false, reason: `Unsupported month or locale: ${match[1]}` };
  const day = Number(match[2]);
  const year = Number(match[3]);
  const hour12 = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour12 < 1 || hour12 > 12 || minute > 59 || second > 59) return { ok: false, reason: `Invalid clock time: ${input.trim()}` };
  const offsetMinutes = parseOffset(match[8]);
  if (offsetMinutes === null) return { ok: false, reason: `Unsupported or invalid timezone: ${match[8]}` };
  const hour = (hour12 % 12) + (match[7] === 'PM' ? 12 : 0);
  const calendarMs = Date.UTC(year, month, day, hour, minute, second);
  const calendar = new Date(calendarMs);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month || calendar.getUTCDate() !== day) {
    return { ok: false, reason: `Invalid calendar date: ${input.trim()}` };
  }
  return { ok: true, iso: new Date(calendarMs - offsetMinutes * 60_000).toISOString() };
}

function htmlToText(html: string): string {
  return html
    .replace(/<h[1-6][^>]*>/gi, '\n### ').replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '')
    .replace(/<p[^>]*>/gi, '\n').replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<blockquote[^>]*>/gi, '\n> ')
    .replace(/<\/blockquote>/gi, '\n').replace(/<code[^>]*>/gi, '`').replace(/<\/code>/gi, '`')
    .replace(/<pre[^>]*>/gi, '\n```\n').replace(/<\/pre>/gi, '\n```\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n').replace(/<strong[^>]*>/gi, '**').replace(/<\/strong>/gi, '**')
    .replace(/<em[^>]*>/gi, '*').replace(/<\/em>/gi, '*').replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&emsp;/g, '  ').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildPersistedContent(prompt: string, response: string): string {
  return `Q: ${prompt}\n\nA: ${response}`.slice(0, 4000);
}

export function createGeminiSourceKey(content: string, timestamp: string): string {
  const digest = createHash('sha256').update(`v2\0${content}\0${timestamp}`, 'utf8').digest('hex');
  return `gemini-conv:v2:${digest}`;
}

export interface GeminiConversation { content: string; timestamp: string; sourceKey: string }
export interface TimestampFailure { candidate: number; value: string; reason: string }
export interface ParseSummary {
  candidates: number;
  accepted: GeminiConversation[];
  skipped: number;
  unsupportedTimestamps: number;
  timestampFailures: TimestampFailure[];
}

export function parseGeminiHtml(htmlContent: string): ParseSummary {
  const $ = cheerio.load(htmlContent);
  const summary: ParseSummary = { candidates: 0, accepted: [], skipped: 0, unsupportedTimestamps: 0, timestampFailures: [] };
  $('div.outer-cell').each((_, outerEl) => {
    const cc = $(outerEl).find('div.content-cell.mdl-cell--6-col').first();
    const text = cc.text().replace(/\u00a0/g, ' ');
    if (!cc.length || !text.startsWith('Prompted ')) return;
    const candidate = ++summary.candidates;
    const parts = (cc.html() ?? '').split(/<br\s*\/?>/i);
    const prompt = htmlToText(parts[0] ?? '').replace(/^Prompted\s*/, '').trim();
    let timestamp: string | undefined;
    let timestampIndex = -1;
    let failure: TimestampFailure | undefined;
    for (let index = 1; index < Math.min(parts.length, 5); index++) {
      const value = htmlToText(parts[index] ?? '').trim();
      const parsed = parseGeminiTimestamp(value);
      if (parsed.ok) { timestamp = parsed.iso; timestampIndex = index; break; }
      if (/\d{4}|(?:AM|PM)/.test(value)) {
        failure = { candidate, value: '(redacted unsupported timestamp)', reason: parsed.reason.split(':', 1)[0] };
      }
    }
    if (!timestamp || timestampIndex < 0) {
      summary.skipped++;
      summary.unsupportedTimestamps++;
      const diagnostic = failure ?? {
        candidate,
        value: '(missing or unrecognized timestamp)',
        reason: 'Unsupported timestamp: no explicitly parseable calendar, clock, and timezone were found',
      };
      if (summary.timestampFailures.length < MAX_FAILURES_REPORTED) summary.timestampFailures.push(diagnostic);
      return;
    }
    const response = htmlToText(parts.slice(timestampIndex + 1).join('<br>'));
    if (!prompt || response.length < 50) { summary.skipped++; return; }
    const content = buildPersistedContent(prompt, response);
    summary.accepted.push({ content, timestamp, sourceKey: createGeminiSourceKey(content, timestamp) });
  });
  return summary;
}

export interface GeminiQueryClient { query(text: string, values?: unknown[]): Promise<unknown> }
export interface ImportSummary extends ParseSummary { imported: number; exitCode: 0 | 1 }

async function commitBatch(rows: GeminiConversation[], client: GeminiQueryClient, embedder: BatchEmbedder): Promise<number> {
  const unique = [...new Map(rows.map(row => [row.sourceKey, row])).values()];
  const prepared = await prepareCanonicalEmbeddingBatch(unique.map(row => row.content), embedder);
  const values: unknown[] = [];
  const tuples = unique.map((row, index) => {
    const base = index * 11;
    values.push(
      row.content,
      `[${prepared.embeddings[index].join(',')}]`,
      SOURCE,
      NAMESPACE,
      '{}',
      JSON.stringify({}),
      row.sourceKey,
      row.timestamp,
      prepared.descriptor.provider,
      prepared.descriptor.model,
      prepared.descriptor.dimensions,
    );
    return `(gen_random_uuid(), $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, '${CLIENT_ID}', $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
  });
  const sql = `INSERT INTO memories (id, content, embedding, source, namespace, tags, metadata, client_id, source_key, created_at, embedding_provider, embedding_model, embedding_dimensions)\nVALUES ${tuples.join(',\n')}\nON CONFLICT (source_key) DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding, embedding_provider = EXCLUDED.embedding_provider, embedding_model = EXCLUDED.embedding_model, embedding_dimensions = EXCLUDED.embedding_dimensions, created_at = EXCLUDED.created_at, updated_at = NOW() WHERE memories.deleted_at IS NULL AND memories.superseded_at IS NULL RETURNING id`;
  let began = false;
  try {
    await client.query('BEGIN'); began = true;
    await client.query("SELECT set_config('app.current_namespace', 'personal', true)");
    const result = await client.query(sql, values);
    await client.query('COMMIT');
    const writeResult = result as { command?: string; rowCount?: number };
    const written = writeResult.command === 'INSERT' && typeof writeResult.rowCount === 'number'
      ? writeResult.rowCount
      : unique.length;
    if (written < unique.length) console.warn(`[preseed-gemini] Skipped ${unique.length - written} tombstoned or superseded source-key conflict(s)`);
    return written;
  } catch (error) {
    if (began) try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  }
}

export async function importGeminiHtml(html: string, client: GeminiQueryClient, embedder: BatchEmbedder): Promise<ImportSummary> {
  const parsed = parseGeminiHtml(html);
  let imported = 0;
  const unique = [...new Map(parsed.accepted.map(row => [row.sourceKey, row])).values()];
  if (unique.length > 0) {
    for (let index = 0; index < unique.length; index += BATCH_SIZE) {
      const batch = unique.slice(index, index + BATCH_SIZE);
      imported += await commitBatch(batch, client, embedder);
    }
  }
  return { ...parsed, imported, exitCode: parsed.unsupportedTimestamps > 0 ? 1 : 0 };
}

export function parseGeminiImportPath(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  if (args.length > 1) throw new Error('Provide at most one Gemini Takeout HTML path');
  const configured = args[0]?.trim() || env.GEMINI_TAKEOUT_HTML_PATH?.trim();
  if (!configured) throw new Error('Provide GEMINI_TAKEOUT_HTML_PATH or a CLI HTML path');
  return path.resolve(configured);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const htmlPath = parseGeminiImportPath(args);
  // #41: fail closed before export, embedding-provider, or database access until identity storage exists.
  requireEmbeddingIdentityWriter();
  const html = fs.readFileSync(htmlPath, 'utf8');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || DEFAULT_DATABASE_URL, max: 1 });
  let client: pg.PoolClient | undefined;
  try {
    const parsed = parseGeminiHtml(html);
    if (parsed.candidates > 0 && parsed.accepted.length === 0 && parsed.unsupportedTimestamps > 0) {
      reportSummary({ ...parsed, imported: 0, exitCode: 1 });
      process.exitCode = 1;
      return;
    }
    client = await pool.connect();
    const summary = await importGeminiHtml(html, client, embedBatch);
    reportSummary(summary);
    if (summary.exitCode !== 0) process.exitCode = summary.exitCode;
  } finally {
    client?.release();
    await pool.end();
  }
}

function reportSummary(summary: ImportSummary): void {
  console.log(`Gemini candidates: ${summary.candidates}; accepted: ${summary.accepted.length}; skipped: ${summary.skipped}; imported: ${summary.imported}`);
  for (const failure of summary.timestampFailures) console.error(`Unsupported timestamp (candidate ${failure.candidate}): ${failure.value} — ${failure.reason}`);
  if (summary.unsupportedTimestamps > summary.timestampFailures.length) console.error(`${summary.unsupportedTimestamps - summary.timestampFailures.length} additional timestamp failures omitted`);
  if (summary.candidates === 0) console.log('Nothing to import (empty export)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('Fatal:', error); process.exitCode = 1; });
}
