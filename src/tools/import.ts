import { importBatchSchema, importMemoryBatch } from '../transfer/import.js';
import type { AuthContext } from '../types.js';

export { importBatchSchema as memoryImportSchema };

/** Bounded MCP batch wrapper; callers must supply one validated manifest. */
export async function memoryImport(params: unknown, auth: AuthContext) {
  const parsed = importBatchSchema.parse(params);
  try {
    return await importMemoryBatch({
      manifest: parsed.manifest,
      records: parsed.records,
      dry_run: parsed.dry_run,
    }, auth);
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('Permission denied') || error.message.startsWith('Access denied'))) throw error;
    throw new Error('Transfer import failed');
  }
}
