import { z } from 'zod';
import { accessLevelSql } from './auth.js';
import { dbScopeFromAuth, withScopedClient } from './db.js';
import { AuthorizationError, ForgetLimitError } from './errors.js';
import { logAudit } from './audit.js';
import type { AuthContext, ForgetResult } from './types.js';

export const MAX_FORGET_IDS = 100;
export const MAX_FORGET_ROWS = 100;
export const MAX_DELETION_REASON_CHARS = 512;
export const ACTIVE_MEMORY_PREDICATE = 'deleted_at IS NULL';

const uuid = z.string().uuid().transform(value => value.toLowerCase());

export const forgetSchema = z.object({
  ids: z.array(uuid).min(1).max(MAX_FORGET_IDS).optional(),
  namespace: z.string().trim().min(1).max(512).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  tags: z.array(z.string().min(1).max(256)).min(1).max(100).optional(),
  confirm: z.boolean().optional(),
  reason: z.string().trim().min(1).max(MAX_DELETION_REASON_CHARS).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.ids && !value.namespace && !value.before && !value.tags) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one forget selector is required' });
  }
  if (value.ids && new Set(value.ids).size !== value.ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ids'], message: 'Duplicate memory IDs are not allowed' });
  }
  if (!value.ids && value.confirm !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirm'], message: 'confirm must be true for filter-only forget requests' });
  }
  if (value.before && new Date(value.before).getTime() > Date.now()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['before'], message: 'before cannot be in the future' });
  }
});

export type NormalizedForgetParams = z.infer<typeof forgetSchema>;

interface ForgetRow {
  id: string;
  namespace: string;
}

/** Soft-delete authorized active memories and their audit records atomically. */
export async function forgetMemories(
  input: unknown,
  auth: AuthContext,
): Promise<ForgetResult> {
  const params = forgetSchema.parse(input);
  if (!auth.permissions.includes('delete')) {
    throw new AuthorizationError("Permission denied: requires 'delete'");
  }

  if (params.namespace && !auth.namespaces.includes(params.namespace)) {
    throw new AuthorizationError(`Access denied to namespace '${params.namespace}'`);
  }

  return withScopedClient(dbScopeFromAuth(auth), async client => {
    const values: unknown[] = [auth.namespaces, auth.maxAccessLevel];
    const conditions = [
      'm.deleted_at IS NULL',
      'm.namespace = ANY($1::text[])',
      accessLevelSql('m.access_level', '$2'),
    ];
    const parameter = (value: unknown, cast = '') => {
      values.push(value);
      return `$${values.length}${cast}`;
    };

    if (params.ids) conditions.push(`m.id = ANY(${parameter(params.ids, '::uuid[]')})`);
    if (params.namespace) conditions.push(`m.namespace = ${parameter(params.namespace)}`);
    if (params.before) conditions.push(`m.created_at < ${parameter(params.before, '::timestamptz')}`);
    if (params.tags) conditions.push(`m.tags @> ${parameter(params.tags, '::text[]')}`);

    const selected = await client.query<ForgetRow>(
      `SELECT m.id, m.namespace
       FROM memories m
       WHERE ${conditions.join(' AND ')}
       ORDER BY m.id
       LIMIT ${MAX_FORGET_ROWS + 1}
       FOR UPDATE`,
      values,
    );
    if (selected.rows.length > MAX_FORGET_ROWS) throw new ForgetLimitError(MAX_FORGET_ROWS);
    if (selected.rows.length === 0) return { forgotten: [], count: 0 };

    const ids = selected.rows.map(row => row.id);
    const updated = await client.query<ForgetRow>(
      `UPDATE memories
       SET deleted_at = statement_timestamp(),
           deleted_by_client_id = $2::uuid,
           deletion_reason = $3
       WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
       RETURNING id, namespace`,
      [ids, auth.keyId, params.reason ?? null],
    );

    const byId = new Map(updated.rows.map(row => [row.id, row]));
    const forgotten = ids.filter(id => byId.has(id));
    for (const id of forgotten) {
      const row = byId.get(id)!;
      await logAudit({
        clientId: auth.keyId,
        action: 'memory.forget',
        namespace: row.namespace,
        memoryId: row.id,
      }, dbScopeFromAuth(auth), client);
    }
    return { forgotten, count: forgotten.length };
  });
}
