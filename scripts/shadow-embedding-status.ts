import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { auditShadowPage } from '../src/shadow-embedding-audit.js';
import { readShadowEmbeddingStatus } from '../src/shadow-embedding-status.js';

export function parseShadowStatusArguments(argv: string[]) {
  let database: string | undefined, cursor: string | null = null, audit = false, limit = 100;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error('embedding.duplicate_argument');
    seen.add(flag);
    if (flag === '--audit-page') audit = true;
    else if (['--database', '--cursor', '--limit'].includes(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('embedding.argument_value_required');
      if (flag === '--database') database = value;
      else if (flag === '--cursor') cursor = value;
      else {
        if (!/^\d+$/u.test(value)) throw new Error('embedding.audit_row_limit');
        limit = Number(value);
      }
    } else throw new Error('embedding.unknown_argument');
  }
  if (!database?.trim()) throw new Error('embedding.expected_database_required');
  if (!audit && (cursor !== null || seen.has('--limit'))) throw new Error('embedding.audit_flag_required');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('embedding.audit_row_limit');
  return { database, cursor, audit, limit };
}

async function main() {
  const args = parseShadowStatusArguments(process.argv.slice(2));
  const connectionString = process.env.SHADOW_EMBEDDING_DATABASE_URL;
  if (!connectionString?.trim()) throw new Error('embedding.operator_url_required');
  // No dotenv loading or production DATABASE_URL fallback. Operator access stays on the DB host.
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000,
    statement_timeout: 15_000, query_timeout: 20_000, application_name: 'total-recall-shadow-status' });
  try {
    const client = await pool.connect();
    try {
      const receipt = args.audit ? await auditShadowPage(client, args.database, args.cursor, args.limit)
        : await readShadowEmbeddingStatus(client, args.database);
      console.log(JSON.stringify(receipt, null, 2));
      if (args.audit && 'parents' in receipt && receipt.parents.some(p => p.state !== 'verified_current')) process.exitCode = 2;
    } finally { client.release(); }
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = error instanceof Error && /^embedding\.[a-zA-Z0-9_.]+$/u.test(error.message)
      ? error.message : 'shadow_embedding_status_failed';
    console.error(code); process.exitCode = 1;
  });
}
