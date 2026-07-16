import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { validateKeyReadOnly } from '../src/auth.js';
import { shutdown, withScopedClient } from '../src/db.js';
import {
  buildWebhookPayload,
  cancelUnauthorizedDelivery,
  claimWebhookDelivery,
  deliveryStillAuthorized,
  loadAuthorizedDelivery,
  markDeliveryDelivered,
  markDeliveryFailed,
  webhookWorkerScope,
  WEBHOOK_MAX_ATTEMPTS,
  type AuthorizedDelivery,
  type ClaimedDelivery,
} from '../src/subscriptions.js';
import {
  canonicalJson,
  decryptValue,
  parseEncryptionKeyRing,
  postWebhook,
  resolveWebhookDestination,
  signWebhook,
  type EncryptionKeyRing,
} from '../src/webhooks.js';

dotenv.config();

export interface WebhookWorkerOptions { once: boolean; maxJobs: number; pollMs: number; concurrency: number }
const RETRY_DELAYS_SECONDS = [60, 300, 1_800, 7_200, 43_200] as const;

export function parseWebhookWorkerCli(args: string[], env: NodeJS.ProcessEnv = process.env): WebhookWorkerOptions {
  let once = false;
  let maxJobs = Number.MAX_SAFE_INTEGER;
  let pollMs = 1_000;
  let concurrency = integer(env.WEBHOOK_DELIVERY_CONCURRENCY ?? '4', 'WEBHOOK_DELIVERY_CONCURRENCY', 1, 32);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--once') once = true;
    else if (arg === '--max-jobs') maxJobs = integer(args[++index], arg, 1, 100_000);
    else if (arg === '--poll-ms') pollMs = integer(args[++index], arg, 100, 60_000);
    else if (arg === '--concurrency') concurrency = integer(args[++index], arg, 1, 32);
    else throw new Error(`Unknown webhook delivery option: ${arg}`);
  }
  return { once, maxJobs, pollMs, concurrency };
}

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

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function runWebhookWorker(options: WebhookWorkerOptions, signal: AbortSignal): Promise<{ processed: number }> {
  if (process.env.WEBHOOK_DELIVERY_ENABLED !== 'true') throw new Error('Webhook delivery is disabled by operator policy');
  const ring = parseEncryptionKeyRing(process.env.WEBHOOK_ENCRYPTION_KEYS);
  const rawKey = process.env.WEBHOOK_WORKER_API_KEY?.trim();
  if (!rawKey) throw new Error('WEBHOOK_WORKER_API_KEY is required');
  const auth = await validateKeyReadOnly(rawKey);
  if (!auth) throw new Error('Invalid or disabled webhook worker API key');
  const scope = webhookWorkerScope(auth);
  let processed = 0;

  while (!signal.aborted && processed < options.maxJobs) {
    const capacity = Math.min(options.concurrency, options.maxJobs - processed);
    const claimed = (await Promise.all(Array.from({ length: capacity }, () =>
      withScopedClient(scope, client => claimWebhookDelivery(client))))).filter((job): job is ClaimedDelivery => job !== null);
    if (claimed.length === 0) {
      if (options.once) break;
      await sleep(options.pollMs, signal);
      continue;
    }
    processed += claimed.length;
    await Promise.all(claimed.map(job => processDelivery(scope, job, ring, signal)));
  }
  return { processed };
}

async function processDelivery(
  scope: ReturnType<typeof webhookWorkerScope>,
  claimed: ClaimedDelivery,
  ring: EncryptionKeyRing,
  signal: AbortSignal,
): Promise<void> {
  const delivery = await withScopedClient(scope, client => loadAuthorizedDelivery(client, claimed.id));
  if (!delivery) {
    await withScopedClient(scope, client => cancelUnauthorizedDelivery(client, claimed.id));
    metric('cancelled');
    return;
  }
  let url: string;
  let secret: string;
  try {
    url = decryptValue(delivery.encryptedUrl, ring, 'webhook-url');
    secret = decryptValue(delivery.encryptedSecret, ring, 'signing-secret');
  } catch {
    await terminal(scope, delivery, 'crypto_error');
    return;
  }

  let destination;
  try { destination = await resolveWebhookDestination(url); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('could not be resolved') || message.includes('no A or AAAA')) await retry(scope, delivery, 'dns_error', claimed.attempts);
    else await terminal(scope, delivery, 'destination_blocked');
    return;
  }
  // DNS can take time. Revocation and unsubscribe win if observed immediately
  // before connect; a request already on the wire cannot be recalled.
  if (!await withScopedClient(scope, client => deliveryStillAuthorized(client, delivery.deliveryId))) {
    await withScopedClient(scope, client => cancelUnauthorizedDelivery(client, delivery.deliveryId));
    metric('cancelled');
    return;
  }

  const body = canonicalJson(buildWebhookPayload(delivery));
  try {
    const response = await postWebhook(destination, body, signWebhook(body, secret), delivery.eventId, {
      timeoutMs: envInteger('WEBHOOK_DELIVERY_TIMEOUT_MS', 5_000, 100, 30_000),
      maxResponseBytes: envInteger('WEBHOOK_MAX_RESPONSE_BYTES', 16_384, 1, 1_048_576),
      signal,
    });
    if (response.status >= 200 && response.status < 300) {
      await withScopedClient(scope, client => markDeliveryDelivered(client, delivery, response.status));
      metric('delivered');
    } else if (isRetryableStatus(response.status) && deliveryAttemptCanRetry(delivery, claimed)) {
      await withScopedClient(scope, client => markDeliveryFailed(client, delivery, {
        errorCode: `http_${response.status}`, httpStatus: response.status,
        retryAt: retryAtForAttempt(claimed.attempts, response.retryAfter), terminal: false,
      }));
      metric('retry');
    } else {
      await withScopedClient(scope, client => markDeliveryFailed(client, delivery, {
        errorCode: response.status >= 300 && response.status < 400 ? 'redirect_rejected' : `http_${response.status || 0}`,
        httpStatus: response.status || undefined, terminal: true,
      }));
      metric('dead');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = message.includes('timeout') ? 'network_timeout' : message.includes('response_too_large') ? 'response_too_large' :
      message.includes('aborted') ? 'aborted' : 'network_error';
    if (deliveryAttemptCanRetry(delivery, claimed) && code !== 'response_too_large') await retry(scope, delivery, code, claimed.attempts);
    else await terminal(scope, delivery, code);
  }
}

function deliveryAttemptCanRetry(_delivery: AuthorizedDelivery, claimed: ClaimedDelivery): boolean {
  return claimed.attempts < WEBHOOK_MAX_ATTEMPTS;
}
async function retry(scope: ReturnType<typeof webhookWorkerScope>, delivery: AuthorizedDelivery, code: string, attempts = 1): Promise<void> {
  await withScopedClient(scope, client => markDeliveryFailed(client, delivery, {
    errorCode: code, retryAt: retryAtForAttempt(attempts, undefined), terminal: attempts >= WEBHOOK_MAX_ATTEMPTS,
  }));
  metric(attempts >= WEBHOOK_MAX_ATTEMPTS ? 'dead' : 'retry');
}
async function terminal(scope: ReturnType<typeof webhookWorkerScope>, delivery: AuthorizedDelivery, code: string): Promise<void> {
  await withScopedClient(scope, client => markDeliveryFailed(client, delivery, { errorCode: code, terminal: true }));
  metric('dead');
}
function metric(outcome: string): void { console.warn(`[webhook-delivery] outcome=${outcome}`); }
function integer(raw: string | undefined, name: string, min: number, max: number): number {
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function envInteger(name: string, fallback: number, min: number, max: number): number {
  return integer(process.env[name] ?? String(fallback), name, min, max);
}
async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); done(); };
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function main(): Promise<void> {
  const options = parseWebhookWorkerCli(process.argv.slice(2));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { console.log('[webhook-delivery] stopped', await runWebhookWorker(options, controller.signal)); }
  finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await shutdown();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('[webhook-delivery] failed:', error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
