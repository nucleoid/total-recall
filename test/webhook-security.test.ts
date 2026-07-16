import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPublicAddress,
  canonicalJson,
  decryptValue,
  encryptValue,
  normalizeWebhookUrl,
  parseEncryptionKeyRing,
  signWebhook,
  verifyWebhookSignature,
} from '../src/webhooks.js';

const key = Buffer.alloc(32, 7).toString('base64');

test('webhook key ring encrypts with current and decrypts with retained keys', () => {
  const ring = parseEncryptionKeyRing(`current:${key},previous:${Buffer.alloc(32, 8).toString('base64')}`);
  const encrypted = encryptValue('https://hooks.example.net/secret', ring, 'webhook-url');
  assert.equal(encrypted.keyId, 'current');
  assert.equal(decryptValue(encrypted, ring, 'webhook-url'), 'https://hooks.example.net/secret');
  assert.throws(() => decryptValue(encrypted, ring, 'signing-secret'), /invalid_ciphertext/);
  assert.throws(() => parseEncryptionKeyRing('short:YWJj'), /canonical base64|32 bytes/);
});

test('canonical payload signatures cover exact sorted bytes', () => {
  const body = canonicalJson({ z: 1, a: { y: 2, x: 3 } });
  assert.equal(body.toString(), '{"a":{"x":3,"y":2},"z":1}');
  const signature = signWebhook(body, 'receiver-secret');
  assert.ok(verifyWebhookSignature(body, 'receiver-secret', signature));
  assert.equal(verifyWebhookSignature(Buffer.from(`${body.toString()}\n`), 'receiver-secret', signature), false);
});

test('URL normalization rejects callback confusion and non-public literals', () => {
  const rejected = [
    'http://hooks.example.com/x',
    'https://user@hooks.example.com/x',
    'https://hooks.example.com:8443/x',
    'https://hooks.example.com/x#fragment',
    'https://localhost/x',
    'https://127.1/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://192.0.2.2/x',
  ];
  for (const url of rejected) assert.throws(() => normalizeWebhookUrl(url), /Webhook/);
  assert.equal(normalizeWebhookUrl('https://hooks.example.com:443/path?q=1').toString(), 'https://hooks.example.com/path?q=1');
});

test('all private, link-local, documentation, mapped, and metadata address examples are blocked', () => {
  for (const address of ['0.0.0.0', '10.2.3.4', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.31.0.1', '192.168.1.1', '192.0.2.1', '198.51.100.2', '203.0.113.8', '224.0.0.1',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:192.168.1.1']) {
    assert.throws(() => assertPublicAddress(address), /non-public/);
  }
  assert.doesNotThrow(() => assertPublicAddress('8.8.8.8'));
  assert.doesNotThrow(() => assertPublicAddress('2606:4700:4700::1111'));
});
