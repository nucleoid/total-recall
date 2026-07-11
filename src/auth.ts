import { createHash, randomBytes } from 'node:crypto';
import { queryUnscoped } from './db.js';
import type { AuthContext } from './types.js';

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
     RETURNING id, name, namespaces, permissions`,
    [hash]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    keyId: row.id,
    name: row.name,
    namespaces: row.namespaces,
    permissions: row.permissions,
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
