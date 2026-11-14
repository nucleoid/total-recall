import { z } from 'zod';
import { accessLevelSql, checkPermission } from '../auth.js';
import { dbScopeFromAuth, withScopedClient } from '../db.js';
import { documentIngestionState } from '../ingestion.js';
import type { AuthContext, DocumentStatus } from '../types.js';

export const documentStatusSchema = z.object({ document_id: z.string().uuid() });
export class DocumentNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'document_not_found';
  constructor() { super('Document not found or access denied'); }
}
export async function memoryDocumentStatus(input: z.infer<typeof documentStatusSchema>, auth: AuthContext): Promise<DocumentStatus> {
  const params = documentStatusSchema.parse(input);
  checkPermission(auth,'read');
  return withScopedClient(dbScopeFromAuth(auth), async client => {
    const document = await client.query(`SELECT d.id FROM documents d WHERE d.id=$1 AND d.client_id=$2::uuid
      AND ${accessLevelSql('d.access_level','$3')}
      AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.document_id=d.id AND NOT (${accessLevelSql('m.access_level','$3')}))`,
    [params.document_id,auth.keyId,auth.maxAccessLevel]);
    if (!document.rows.length) throw new DocumentNotFoundError();
    return documentIngestionState(client,params.document_id);
  });
}
