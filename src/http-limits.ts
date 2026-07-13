import { z } from 'zod';

export const KIBIBYTE = 1024;
export const MEBIBYTE = 1024 * KIBIBYTE;

/**
 * The largest decoded document is 1 MiB. In the worst case, JSON encodes each
 * input byte as a six-byte escape (for example U+0000 becomes `\u0000`). The
 * remaining bounded fields fit comfortably in the rest of this 8 MiB envelope.
 */
export const JSON_BODY_LIMIT_BYTES = 8 * MEBIBYTE;

export const MEMORY_CONTENT_MAX_CHARS = 100_000;
export const TEXT_FIELD_MAX_CHARS = 512;
export const DOCUMENT_TITLE_MAX_CHARS = 512;
export const TAG_MAX_COUNT = 100;
export const TAG_MAX_CHARS = 256;

/** The metadata budget is measured on JSON.stringify(metadata), in UTF-8 bytes. */
export const METADATA_MAX_BYTES = 64 * KIBIBYTE;
export const METADATA_MAX_DEPTH = 16;
export const METADATA_MAX_KEYS = 1_000;

function metadataMetrics(value: unknown): { depth: number; keys: number } {
  const active = new Set<object>();

  function visit(node: unknown, depth: number): { depth: number; keys: number } {
    if (node === null || typeof node !== 'object') return { depth, keys: 0 };
    if (active.has(node)) throw new Error('Metadata must not contain cycles');
    active.add(node);

    let maxDepth = depth;
    let keys = 0;
    if (Array.isArray(node)) {
      for (const child of node) {
        const metrics = visit(child, depth + 1);
        maxDepth = Math.max(maxDepth, metrics.depth);
        keys += metrics.keys;
      }
    } else {
      const entries = Object.entries(node);
      keys += entries.length;
      for (const [, child] of entries) {
        const metrics = visit(child, depth + 1);
        maxDepth = Math.max(maxDepth, metrics.depth);
        keys += metrics.keys;
      }
    }
    active.delete(node);
    return { depth: maxDepth, keys };
  }

  return visit(value, 0);
}

export const metadataSchema = z.record(z.unknown()).superRefine((metadata, ctx) => {
  let serialized: string | undefined;
  let metrics: { depth: number; keys: number };
  try {
    serialized = JSON.stringify(metadata);
    metrics = metadataMetrics(metadata);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Metadata must be JSON-serializable' });
    return;
  }

  if (serialized === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Metadata must be JSON-serializable' });
    return;
  }
  if (Buffer.byteLength(serialized, 'utf8') > METADATA_MAX_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Metadata must not exceed ${METADATA_MAX_BYTES} serialized JSON bytes` });
  }
  if (metrics.depth > METADATA_MAX_DEPTH) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Metadata must not exceed depth ${METADATA_MAX_DEPTH}` });
  }
  if (metrics.keys > METADATA_MAX_KEYS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Metadata must not exceed ${METADATA_MAX_KEYS} keys` });
  }
});

export function validateMetadataInRequest(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;
  if (!Object.prototype.hasOwnProperty.call(value, 'metadata')) return true;

  // Callers pass the known REST body or MCP tool arguments object. Validate
  // only that schema slot: unknown fields are stripped later by Zod and must
  // not become alternate metadata envelopes merely because of their key names.
  return metadataSchema.safeParse((value as Record<string, unknown>).metadata).success;
}
