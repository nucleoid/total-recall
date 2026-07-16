import { z } from 'zod';
import type { AuthContext } from '../types.js';
import { importMemoryBatch } from '../transfer/import.js';
import { transferManifestSchema, TRANSFER_MAX_BATCH_SIZE } from '../transfer/format.js';

export const memoryImportSchema = z.object({
  manifest: transferManifestSchema,
  records: z.array(z.unknown()).max(TRANSFER_MAX_BATCH_SIZE),
  dry_run: z.boolean().default(false),
  record_offset: z.number().int().nonnegative().default(0),
});

export async function memoryImportBatch(params: z.infer<typeof memoryImportSchema>, auth: AuthContext) {
  return importMemoryBatch(auth, params.manifest, params.records, {
    dryRun: params.dry_run,
    recordOffset: params.record_offset,
  });
}
