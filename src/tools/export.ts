import { z } from 'zod';
import type { AuthContext } from '../types.js';
import {
  createTransferManifest,
  decodeExportCursor,
  encodeExportCursor,
  exportMemoryPage,
} from '../transfer/export.js';
import { TRANSFER_MAX_PAGE_SIZE } from '../transfer/format.js';
import { logAudit } from '../audit.js';
import { dbScopeFromAuth } from '../db.js';

export const memoryExportSchema = z.object({
  namespaces: z.array(z.string().min(1).max(512)).max(100).optional(),
  include_protected: z.boolean().default(false),
  acknowledge_plaintext: z.boolean().default(false),
  limit: z.number().int().min(1).max(TRANSFER_MAX_PAGE_SIZE).default(50),
  cursor: z.string().max(2048).optional(),
});

export async function memoryExportPage(params: z.infer<typeof memoryExportSchema>, auth: AuthContext) {
  const after = params.cursor ? decodeExportCursor(auth, params.cursor) : undefined;
  const page = await exportMemoryPage(auth, {
    namespaces: params.namespaces,
    includeProtected: params.include_protected,
    acknowledgePlaintext: params.acknowledge_plaintext,
    pageSize: params.limit,
    after,
  });
  await logAudit({
    clientId: auth.keyId, action: 'memory.export', resourceType: 'system',
    resultCount: page.records.length, details: { exported: page.records.length },
  }, dbScopeFromAuth(auth));
  return {
    manifest: params.cursor ? undefined : await createTransferManifest(),
    records: page.records,
    cursor: page.next ? encodeExportCursor(auth, page.next) : null,
  };
}
