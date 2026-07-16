import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type express from 'express';
import { ZodError } from 'zod';
import { checkPermission } from '../auth.js';
import type { AuthContext } from '../types.js';
import { MAX_EXPORT_PAGE_RECORDS, auditTransferExport, exportMemoryPage, exportPageSchema } from './export.js';
import {
  MAX_TRANSFER_BATCH_RECORDS,
  MAX_TRANSFER_COMPRESSED_BYTES,
  MAX_TRANSFER_LINE_BYTES,
  MAX_TRANSFER_RECORDS,
  MAX_TRANSFER_UNCOMPRESSED_BYTES,
  encodeJsonLine,
  parseJsonLine,
  parseTransferManifest,
  parseTransferMemoryRecord,
  type TransferManifest,
  type TransferMemoryRecord,
} from './format.js';
import { importMemoryBatch, type ImportBatchResult } from './import.js';

export type TransferAuthenticator = (
  req: express.Request,
  res: express.Response,
) => Promise<AuthContext | null>;

export async function handleTransferExport(
  req: express.Request,
  res: express.Response,
  authenticate: TransferAuthenticator,
): Promise<void> {
  try {
    const auth = await authenticate(req, res);
    if (!auth) return;
    checkPermission(auth, 'export');
    const query = exportPageSchema.parse({
      namespaces: parseNamespaces(req.query.namespace),
      include_sensitive: parseBoolean(req.query.include_sensitive, false, 'include_sensitive'),
      acknowledge_plaintext_sensitive: parseBoolean(req.query.acknowledge_plaintext_sensitive, false, 'acknowledge_plaintext_sensitive'),
      limit: MAX_EXPORT_PAGE_RECORDS,
    });

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="total-recall-memory-feed.jsonl"');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    let cursor: string | undefined;
    let count = 0;
    let wroteManifest = false;
    do {
      if (req.destroyed || res.destroyed) return;
      const page = await exportMemoryPage({ ...query, cursor }, auth);
      if (!wroteManifest) {
        if (!await writeResponseLine(res, encodeJsonLine(page.manifest))) return;
        wroteManifest = true;
      }
      for (const record of page.records) {
        if (req.destroyed || res.destroyed) return;
        if (!await writeResponseLine(res, encodeJsonLine(record))) return;
        count++;
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    await auditTransferExport(auth, count);
    res.end();
  } catch (error) {
    sendTransferError(res, error);
  }
}

export async function handleTransferImport(
  req: express.Request,
  res: express.Response,
  authenticate: TransferAuthenticator,
): Promise<void> {
  const aggregate = emptyImportResult();
  let lastCommittedLine = 1;
  let lastCommittedRecord = 0;
  let currentLine = 0;
  let uncommittedBatchRecords = 0;
  try {
    const auth = await authenticate(req, res);
    if (!auth) return;
    checkPermission(auth, 'import');
    const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/x-ndjson' && contentType !== 'application/ndjson') {
      res.status(415).json({ code: 'unsupported_media_type' });
      return;
    }
    const encoding = String(req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding !== 'identity' && encoding !== 'gzip') {
      res.status(415).json({ code: 'unsupported_content_encoding' });
      return;
    }
    const dryRun = parseBoolean(req.query.dry_run, false, 'dry_run');
    aggregate.committed = !dryRun;
    const controller = new AbortController();
    req.once('aborted', () => controller.abort(new Error('Import request aborted')));
    res.once('close', () => {
      if (!res.writableEnded) controller.abort(new Error('Import response disconnected'));
    });

    let manifest: TransferManifest | undefined;
    let batch: TransferMemoryRecord[] = [];
    let batchEndLine = 1;
    const seen = new Set<string>();

    const commit = async () => {
      if (!manifest || batch.length === 0) return;
      uncommittedBatchRecords = batch.length;
      const result = await importMemoryBatch({ manifest, records: batch, dry_run: dryRun }, auth, { signal: controller.signal });
      addImportResult(aggregate, result);
      if (!dryRun) {
        lastCommittedLine = batchEndLine;
        lastCommittedRecord += batch.length;
      }
      batch = [];
      uncommittedBatchRecords = 0;
    };

    for await (const line of ndjsonLines(req, encoding === 'gzip')) {
      currentLine++;
      const value = parseJsonLine(line, currentLine, currentLine === 1);
      if (currentLine === 1) {
        manifest = parseTransferManifest(value);
        continue;
      }
      if (!manifest) throw new Error('Line 1 must be a transfer manifest');
      uncommittedBatchRecords = batch.length + 1;
      const record = parseTransferMemoryRecord(value);
      if (seen.has(record.source_key)) throw new Error(`Line ${currentLine} repeats a source_key`);
      seen.add(record.source_key);
      if (seen.size > MAX_TRANSFER_RECORDS) throw new Error(`Transfer exceeds ${MAX_TRANSFER_RECORDS} records`);
      batch.push(record);
      batchEndLine = currentLine;
      if (batch.length === MAX_TRANSFER_BATCH_RECORDS) await commit();
    }
    if (currentLine === 0) throw new Error('Transfer input is empty');
    if (!manifest) throw new Error('Line 1 must be a transfer manifest');
    await commit();

    res.status(200).json({
      ...aggregate,
      dry_run: dryRun,
      last_committed_line: dryRun ? null : lastCommittedLine,
      last_committed_record: dryRun ? null : lastCommittedRecord,
    });
  } catch (error) {
    if (res.headersSent) return;
    if (uncommittedBatchRecords > 0) aggregate.failed += uncommittedBatchRecords;
    const clientError = error instanceof ZodError || isInputError(error);
    const status = error instanceof Error && error.message.includes(' exceeds ')
      ? 413
      : permissionError(error) ? 403 : clientError ? 400 : 500;
    res.status(status).json({
      error: contentFreeError(error),
      line: currentLine || null,
      last_committed_line: lastCommittedRecord > 0 ? lastCommittedLine : null,
      last_committed_record: lastCommittedRecord,
      ...aggregate,
    });
  }
}

async function* ndjsonLines(req: express.Request, gzip: boolean): AsyncGenerator<Buffer> {
  let compressed = 0;
  let uncompressed = 0;
  const compressedCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressed += chunk.length;
      if (compressed > MAX_TRANSFER_COMPRESSED_BYTES) callback(new Error(`Compressed transfer exceeds ${MAX_TRANSFER_COMPRESSED_BYTES} bytes`));
      else callback(null, chunk);
    },
  });
  let source: NodeJS.ReadableStream = req.pipe(compressedCounter);
  if (gzip) source = source.pipe(createGunzip());

  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for await (const raw of source as AsyncIterable<Buffer | string>) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    uncompressed += chunk.length;
    if (uncompressed > MAX_TRANSFER_UNCOMPRESSED_BYTES) throw new Error(`Transfer exceeds ${MAX_TRANSFER_UNCOMPRESSED_BYTES} decoded bytes`);
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let newline: number;
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      let line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length > MAX_TRANSFER_LINE_BYTES) throw new Error(`Transfer line exceeds ${MAX_TRANSFER_LINE_BYTES} bytes`);
      yield line;
    }
    if (pending.length > MAX_TRANSFER_LINE_BYTES) throw new Error(`Transfer line exceeds ${MAX_TRANSFER_LINE_BYTES} bytes`);
  }
  if (pending.length > 0) yield pending;
}

async function writeResponseLine(res: express.Response, line: string): Promise<boolean> {
  if (res.write(line)) return true;
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(true); };
    const onClose = () => { cleanup(); resolve(false); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

function parseNamespaces(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  const namespaces = values.flatMap(item => String(item).split(',')).map(item => item.trim());
  if (namespaces.some(item => !item) || new Set(namespaces).size !== namespaces.length) throw new Error('Invalid namespace filter');
  return namespaces;
}

function parseBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid ${field}: expected true or false`);
}

function emptyImportResult(): ImportBatchResult {
  return { inserted: 0, updated: 0, skipped: 0, conflicted: 0, denied: 0, failed: 0, embedding_calls: 0, committed: true };
}

function addImportResult(target: ImportBatchResult, value: ImportBatchResult): void {
  target.inserted += value.inserted;
  target.updated += value.updated;
  target.skipped += value.skipped;
  target.conflicted += value.conflicted;
  target.denied += value.denied;
  target.failed += value.failed;
  target.embedding_calls += value.embedding_calls;
  target.committed &&= value.committed;
}

function sendTransferError(res: express.Response, error: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const status = error instanceof ZodError || isInputError(error) ? 400 : permissionError(error) ? 403 : 500;
  res.status(status).json({ error: contentFreeError(error) });
}

function permissionError(error: unknown): boolean {
  return error instanceof Error && (error.message.startsWith('Permission denied') || error.message.startsWith('Access denied'));
}

function isInputError(error: unknown): boolean {
  return error instanceof Error && /^(Invalid |Line |Transfer |Unsupported |Duplicate |Sensitive export)/.test(error.message);
}

function contentFreeError(error: unknown): string {
  if (error instanceof ZodError) return 'Invalid transfer record';
  if (!(error instanceof Error)) return 'Transfer failed';
  // Validation messages contain only field names, boundaries, line numbers, or
  // source keys. Database/provider details remain server-side.
  if (isInputError(error) || permissionError(error)) return error.message;
  console.error('[total-recall] transfer failed', error instanceof Error ? error.name : 'unknown');
  return 'Transfer failed';
}
