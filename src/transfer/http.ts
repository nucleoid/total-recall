import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  TRANSFER_MAX_COMPRESSED_BYTES,
  TRANSFER_MAX_LINE_BYTES,
  TRANSFER_MAX_RECORDS,
  TRANSFER_MAX_UNCOMPRESSED_BYTES,
  TransferFormatError,
  TransferLimitError,
} from './format.js';

export async function* parseNdjsonRequest(
  request: IncomingMessage,
  encoding: 'identity' | 'gzip',
  signal?: AbortSignal,
): AsyncGenerator<{ line: number; value: unknown }> {
  let compressedBytes = 0;
  async function* raw(): AsyncGenerator<Buffer> {
    for await (const chunk of request) {
      if (signal?.aborted) throw signal.reason ?? new Error('Import cancelled');
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      compressedBytes += bytes.length;
      const encodedLimit = encoding === 'gzip' ? TRANSFER_MAX_COMPRESSED_BYTES : TRANSFER_MAX_UNCOMPRESSED_BYTES;
      if (compressedBytes > encodedLimit) throw new TransferLimitError('encoded transfer exceeds byte limit');
      yield bytes;
    }
  }

  const stream: AsyncIterable<Buffer> = encoding === 'gzip'
    ? Readable.from(raw()).pipe(createGunzip())
    : raw();
  let pending: Buffer = Buffer.alloc(0);
  let uncompressedBytes = 0;
  let line = 0;
  let records = 0;
  for await (const chunk of stream) {
    if (signal?.aborted) throw signal.reason ?? new Error('Import cancelled');
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    uncompressedBytes += bytes.length;
    if (uncompressedBytes > TRANSFER_MAX_UNCOMPRESSED_BYTES) throw new TransferLimitError('uncompressed transfer exceeds byte limit');
    pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
    let newline: number;
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      const rawLine = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      line += 1;
      records += 1;
      if (records > TRANSFER_MAX_RECORDS + 1) throw new TransferLimitError('transfer exceeds record limit', line);
      yield { line, value: parseLine(rawLine, line) };
    }
    if (pending.length > TRANSFER_MAX_LINE_BYTES) throw new TransferLimitError('line exceeds byte limit', line + 1);
  }
  if (pending.length > 0) {
    line += 1;
    records += 1;
    if (records > TRANSFER_MAX_RECORDS + 1) throw new TransferLimitError('transfer exceeds record limit', line);
    yield { line, value: parseLine(pending, line) };
  }
}

function parseLine(input: Buffer, line: number): unknown {
  let bytes = input;
  if (bytes.length > TRANSFER_MAX_LINE_BYTES) throw new TransferLimitError('line exceeds byte limit', line);
  if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, -1);
  if (line === 1 && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
  }
  if (bytes.length === 0) throw new TransferFormatError('blank lines are not allowed', line);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new TransferFormatError('invalid UTF-8', line); }
  try { return JSON.parse(text); }
  catch { throw new TransferFormatError('invalid JSON', line); }
}
