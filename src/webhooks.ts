import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

export interface EncryptedValue { keyId: string; ciphertext: Buffer; iv: Buffer; tag: Buffer }
export interface EncryptionKeyRing { currentId: string; keys: ReadonlyMap<string, Buffer> }
export interface ResolvedWebhookDestination { url: URL; addresses: ReadonlyArray<{ address: string; family: 4 | 6 }> }
export interface WebhookResponse { status: number; retryAfter?: string }

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.test', '.invalid', '.example', '.onion'];
const MAX_RESPONSE_BYTES_DEFAULT = 16 * 1024;

export function parseEncryptionKeyRing(raw: string | undefined): EncryptionKeyRing {
  if (!raw?.trim()) throw new Error('Memory subscriptions are disabled: WEBHOOK_ENCRYPTION_KEYS is required');
  const keys = new Map<string, Buffer>();
  for (const entry of raw.split(',').map(value => value.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    if (separator < 1) throw new Error('WEBHOOK_ENCRYPTION_KEYS entries must be key-id:base64');
    const id = entry.slice(0, separator);
    const encoded = entry.slice(separator + 1);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id) || keys.has(id)) throw new Error('WEBHOOK_ENCRYPTION_KEYS contains an invalid or duplicate key ID');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error(`Webhook encryption key '${id}' is not canonical base64`);
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error(`Webhook encryption key '${id}' must decode to exactly 32 bytes`);
    keys.set(id, key);
  }
  const currentId = keys.keys().next().value as string | undefined;
  if (!currentId) throw new Error('WEBHOOK_ENCRYPTION_KEYS must contain at least one key');
  return { currentId, keys };
}

export function encryptValue(plaintext: string, ring: EncryptionKeyRing, purpose: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.keys.get(ring.currentId)!, iv);
  cipher.setAAD(Buffer.from(`total-recall:${purpose}:v1`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { keyId: ring.currentId, ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decryptValue(value: EncryptedValue, ring: EncryptionKeyRing, purpose: string): string {
  const key = ring.keys.get(value.keyId);
  if (!key) throw new Error('webhook_crypto_unknown_key');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, value.iv);
    decipher.setAAD(Buffer.from(`total-recall:${purpose}:v1`, 'utf8'));
    decipher.setAuthTag(value.tag);
    return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString('utf8');
  } catch { throw new Error('webhook_crypto_invalid_ciphertext'); }
}

export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(sortJson(value)), 'utf8');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}

export function signWebhook(body: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function verifyWebhookSignature(body: Buffer, secret: string, supplied: string): boolean {
  const expected = signWebhook(body, secret);
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function normalizeWebhookUrl(raw: string): URL {
  if (raw.length > 4096) throw new Error('Webhook URL exceeds 4096 characters');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Webhook URL is invalid'); }
  if (url.protocol !== 'https:') throw new Error('Webhook destination must use HTTPS');
  if (url.username || url.password) throw new Error('Webhook URL must not contain user-info');
  if (url.hash) throw new Error('Webhook URL must not contain a fragment');
  if (url.port && url.port !== '443') throw new Error('Webhook destination must use port 443');
  if (!url.hostname || url.hostname.length > 253) throw new Error('Webhook hostname is invalid');
  const host = unbracket(url.hostname).toLowerCase().replace(/\.$/, '');
  if (url.hostname.endsWith('.')) url.hostname = host;
  if (host === 'localhost' || host === 'metadata.google.internal' || BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    throw new Error('Webhook hostname is not a public destination');
  }
  // WHATWG accepts legacy/octal/hex IPv4. If it normalized an IP literal, only
  // the canonical spelling is accepted so alternate encodings cannot bypass policy.
  if (net.isIP(host)) {
    const rawAuthority = raw.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? '';
    const rawHost = rawAuthority.startsWith('[')
      ? rawAuthority.slice(0, rawAuthority.indexOf(']') + 1)
      : rawAuthority.split(':')[0];
    const expected = net.isIP(host) === 6 ? `[${host}]` : host;
    if (rawHost.toLowerCase() !== expected.toLowerCase()) throw new Error('Webhook IP literal must use canonical notation');
    assertPublicAddress(host);
  }
  url.port = '';
  return url;
}

export function redactWebhookUrl(url: URL | string): string {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  return `${parsed.protocol}//${parsed.host}/…`;
}

export async function resolveWebhookDestination(raw: string): Promise<ResolvedWebhookDestination> {
  const url = normalizeWebhookUrl(raw);
  const hostname = unbracket(url.hostname);
  if (net.isIP(hostname)) {
    assertPublicAddress(hostname);
    return { url, addresses: [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }] };
  }
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await withDeadline(dnsLookup(hostname, { all: true, verbatim: true }), 5_000);
  } catch { throw new Error('Webhook hostname could not be resolved'); }
  if (answers.length === 0) throw new Error('Webhook hostname has no A or AAAA records');
  const addresses = answers.map(answer => {
    if (answer.family !== 4 && answer.family !== 6) throw new Error('Webhook DNS returned an unsupported address family');
    assertPublicAddress(answer.address);
    return { address: answer.address, family: answer.family as 4 | 6 };
  });
  return { url, addresses };
}

export function assertPublicAddress(address: string): void {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a, b, c] = parts;
    const blocked = a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
    if (blocked) throw new Error('Webhook destination resolved to a non-public address');
    return;
  }
  if (family !== 6) throw new Error('Webhook destination did not resolve to an IP address');
  const value = ipv6ToBigInt(address);
  const inPrefix = (prefix: bigint, bits: number) => (value >> BigInt(128 - bits)) === (prefix >> BigInt(128 - bits));
  const mappedPrefix = 0xffffn;
  if ((value >> 32n) === mappedPrefix) {
    const ipv4 = Number(value & 0xffffffffn);
    assertPublicAddress(`${ipv4 >>> 24}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`);
    return;
  }
  if (value === 0n || value === 1n || (value >> 32n) === 0n ||
      inPrefix(0x0100n << 112n, 64) || inPrefix(0xfc00n << 112n, 7) || inPrefix(0xfe80n << 112n, 10) ||
      inPrefix(0xff00n << 112n, 8) || inPrefix(0x2001n << 112n, 23) || inPrefix(0x20010db8n << 96n, 32) ||
      inPrefix(0x3fffn << 112n, 20) || inPrefix(0x0064ff9bn << 96n, 96) ||
      inPrefix(0x0064ff9b0001n << 80n, 48) || inPrefix(0x2002n << 112n, 16)) {
    throw new Error('Webhook destination resolved to a non-public address');
  }
}

function ipv6ToBigInt(input: string): bigint {
  let address = unbracket(input).split('%')[0].toLowerCase();
  const dotted = address.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const bytes = dotted.slice(1).map(Number);
    if (bytes.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('Invalid IPv6 address');
    address = address.slice(0, dotted.index) + `${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) throw new Error('Invalid IPv6 address');
  const parse = (part: string): number[] => part ? part.split(':').map(piece => parseInt(piece, 16)) : [];
  const left = parse(halves[0]);
  const right = parse(halves[1] ?? '');
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(fill).fill(0), ...right];
  if (groups.length !== 8 || groups.some(group => !Number.isInteger(group) || group < 0 || group > 0xffff)) throw new Error('Invalid IPv6 address');
  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n);
}

function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

async function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('deadline exceeded')), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function postWebhook(
  destination: ResolvedWebhookDestination,
  body: Buffer,
  signature: string,
  eventId: string,
  options: { timeoutMs?: number; maxResponseBytes?: number; signal?: AbortSignal } = {},
): Promise<WebhookResponse> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES_DEFAULT;
  if (body.length > 64 * 1024) throw new Error('webhook_payload_too_large');
  const pinned = destination.addresses[Math.floor(Math.random() * destination.addresses.length)];
  return new Promise<WebhookResponse>((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (error?: Error, response?: WebhookResponse) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (error) reject(error); else resolve(response!);
    };
    const request = https.request(destination.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
        'user-agent': 'total-recall-webhooks/1',
        'x-total-recall-event-id': eventId,
        'x-total-recall-signature': signature,
      },
      timeout: timeoutMs,
      maxRedirects: 0,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    } as https.RequestOptions, response => {
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) request.destroy(new Error('webhook_response_too_large'));
      });
      response.on('end', () => finish(undefined, {
        status: response.statusCode ?? 0,
        retryAfter: Array.isArray(response.headers['retry-after']) ? response.headers['retry-after'][0] : response.headers['retry-after'],
      }));
      response.on('error', error => finish(error));
    });
    deadline = setTimeout(() => request.destroy(new Error('webhook_timeout')), timeoutMs);
    request.on('timeout', () => request.destroy(new Error('webhook_timeout')));
    request.on('error', error => finish(error));
    const abort = () => request.destroy(new Error('webhook_aborted'));
    options.signal?.addEventListener('abort', abort, { once: true });
    request.on('close', () => options.signal?.removeEventListener('abort', abort));
    request.end(body);
  });
}
