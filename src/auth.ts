import { createHash, randomBytes } from 'node:crypto';
import { queryUnscoped } from './db.js';
import type { AccessLevel, AuthContext } from './types.js';

export const ACCESS_LEVELS = ['normal', 'sensitive', 'secret'] as const satisfies readonly AccessLevel[];

const ACCESS_LEVEL_RANK: Record<AccessLevel, number> = {
  normal: 0,
  sensitive: 1,
  secret: 2,
};

export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === 'string' && (ACCESS_LEVELS as readonly string[]).includes(value);
}

export function canAccessLevel(required: unknown, ceiling: AccessLevel): boolean {
  const requiredLevel = required ?? 'normal';
  if (!isAccessLevel(requiredLevel)) return false;
  return ACCESS_LEVEL_RANK[requiredLevel] <= ACCESS_LEVEL_RANK[ceiling];
}

export function ensureAccessLevelAllowed(required: unknown, ceiling: AccessLevel): void {
  if (!canAccessLevel(required, ceiling)) {
    throw new Error(`Access level denied: requires '${String(required)}', key allows '${ceiling}'`);
  }
}

export function accessLevelSql(column: string, ceiling: string): string {
  return `CASE COALESCE(${column}, 'normal') ` +
    `WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE 3 END ` +
    `<= CASE ${ceiling} WHEN 'normal' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'secret' THEN 2 ELSE -1 END`;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateKey(): string {
  return 'tr_' + randomBytes(32).toString('hex');
}

export async function validateKey(apiKey: string): Promise<AuthContext | null> {
  const hash = hashKey(apiKey);
  const res = await queryUnscoped(
    `UPDATE api_keys SET last_used_at = NOW()
     WHERE key_hash = $1 AND enabled = true
     RETURNING id, name, namespaces, permissions, max_access_level`,
    [hash]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  if (!isAccessLevel(row.max_access_level)) return null;
  return {
    keyId: row.id,
    name: row.name,
    namespaces: row.namespaces,
    permissions: row.permissions,
    maxAccessLevel: row.max_access_level,
  };
}

export function filterNamespaces(
  requested: string[] | undefined,
  allowed: string[]
): string[] {
  if (!requested || requested.length === 0) return allowed;
  return requested.filter((ns) => allowed.includes(ns));
}

export function checkPermission(auth: AuthContext, perm: string): void {
  if (!auth.permissions.includes(perm)) {
    throw new Error(`Permission denied: requires '${perm}'`);
  }
}

export function checkAdminPermission(auth: AuthContext): void {
  checkPermission(auth, 'admin');
}
