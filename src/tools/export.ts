import { auditTransferExport, exportMemoryPage, exportPageSchema } from '../transfer/export.js';
import type { AuthContext } from '../types.js';

export { exportPageSchema as memoryExportSchema };

/** Bounded MCP page wrapper; JSONL transport belongs to the REST endpoint/CLI. */
export async function memoryExport(params: unknown, auth: AuthContext) {
  try {
    const result = await exportMemoryPage(exportPageSchema.parse(params), auth);
    await auditTransferExport(auth, result.records.length);
    return result;
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('Permission denied') || error.message.startsWith('Access denied'))) throw error;
    throw new Error('Transfer export failed');
  }
}
