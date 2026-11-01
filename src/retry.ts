/**
 * Shared bounded exponential backoff for durable workers (webhook delivery,
 * memory ingestion). The schedule is capped at twelve hours, honors a
 * Retry-After header when the provider supplies one, and adds positive jitter
 * so synchronized retries never make Retry-After early.
 */
export const RETRY_DELAYS_SECONDS = [60, 300, 1_800, 7_200, 43_200] as const;

export function retryAtForAttempt(attempts: number, retryAfter: string | undefined, now = new Date()): Date {
  const base = RETRY_DELAYS_SECONDS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_SECONDS.length - 1)];
  let requested = 0;
  if (retryAfter?.trim()) {
    if (/^\d+$/.test(retryAfter.trim())) requested = Number(retryAfter.trim());
    else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) requested = Math.ceil((date - now.getTime()) / 1_000);
    }
  }
  const delay = Math.min(43_200, Math.max(base, Number.isFinite(requested) ? requested : 0));
  // Positive bounded jitter avoids synchronized retries without making Retry-After early.
  const jittered = Math.min(43_200, delay + Math.floor(Math.random() * Math.max(1, delay * 0.2)));
  return new Date(now.getTime() + jittered * 1_000);
}
