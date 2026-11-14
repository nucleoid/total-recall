export function parseMemoryDedupeThreshold(value: string | undefined): number {
  if (value === undefined) return 0.95;
  if (value.trim() === '') throw new Error('MEMORY_DEDUPE_THRESHOLD must be a number between 0 and 1');
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('MEMORY_DEDUPE_THRESHOLD must be a number between 0 and 1');
  }
  return threshold;
}

/** Validated once when the store runtime starts. */
export const MEMORY_DEDUPE_THRESHOLD = parseMemoryDedupeThreshold(process.env.MEMORY_DEDUPE_THRESHOLD);
