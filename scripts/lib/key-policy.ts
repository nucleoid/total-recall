export const KEY_PERMISSIONS = ['read', 'write', 'delete', 'admin', 'consolidate'] as const;

export function parseStrictDuration(value: string, option: string, allowZero = false): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (!match) throw new Error(`${option} must be an integer duration such as 30d or 12h`);
  const amount = Number(match[1]);
  const multiplier = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd'];
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds) || (allowZero ? amount < 0 : amount <= 0)) {
    throw new Error(`${option} is outside the supported range`);
  }
  return milliseconds;
}

export function parseExpiry(value: string, now = new Date()): Date {
  let expiry: Date;
  if (/^\d+(?:s|m|h|d)$/.test(value)) {
    expiry = new Date(now.getTime() + parseStrictDuration(value, '--expires'));
  } else {
    // Require a full ISO-8601 timestamp with an explicit UTC offset.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new Error('--expires must be an offset-aware ISO-8601 timestamp or duration such as 30d or 12h');
    }
    expiry = new Date(value);
  }
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime()) {
    throw new Error('--expires must resolve to a future instant');
  }
  return expiry;
}

export function parseLimit(value: string | undefined, option: string): number | null {
  if (value === undefined) throw new Error(`${option} is required when its configured default is absent`);
  if (value === 'unlimited') return null;
  if (!/^\d+$/.test(value)) throw new Error(`${option} must be a non-negative integer or "unlimited"`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${option} is outside the supported range`);
  return result;
}

export function parseCsv(value: string, option: string): string[] {
  const entries = value.split(',').map(entry => entry.trim());
  if (entries.length === 0 || entries.some(entry => entry.length === 0)) {
    throw new Error(`${option} must be a comma-separated list of nonempty values`);
  }
  if (new Set(entries).size !== entries.length) throw new Error(`${option} must not contain duplicates`);
  return entries;
}

export function validatePermissions(permissions: string[]): void {
  const allowed = new Set<string>(KEY_PERMISSIONS);
  const invalid = permissions.filter(permission => !allowed.has(permission));
  if (invalid.length > 0) throw new Error(`Unknown permissions: ${invalid.join(', ')}`);
}
