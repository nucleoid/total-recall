import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import test from 'node:test';
import { createPinnedWebhookLookup, postWebhook, selectPinnedWebhookAddress } from '../src/webhooks.js';

const fixture = new URL('./fixtures/local-embedding-tls/', import.meta.url);

test('pinned lookup honors Node 24 all mode without changing address or family', async () => {
  const lookup = createPinnedWebhookLookup({ address: '203.0.113.77', family: 4 });
  let synchronous = true;
  const allPromise = new Promise<unknown>((resolve, reject) => lookup('ignored.example', { all: true },
    (error, address, family) => {
      assert.equal(synchronous, false);
      error ? reject(error) : resolve({ address, family });
    }));
  synchronous = false;
  const all = await allPromise;
  assert.deepEqual(all, { address: [{ address: '203.0.113.77', family: 4 }], family: undefined });
  let scalarSynchronous = true;
  const onePromise = new Promise<unknown>((resolve, reject) => lookup('ignored.example', { all: false },
    (error, address, family) => {
      assert.equal(scalarSynchronous, false);
      error ? reject(error) : resolve({ address, family });
    }));
  scalarSynchronous = false;
  const one = await onePromise;
  assert.deepEqual(one, { address: '203.0.113.77', family: 4 });
});

test('pin selection prefers reviewed IPv4 without introducing another address', () => {
  const addresses = [
    { address: '2606:4700:4700::1111', family: 6 as const },
    { address: '104.16.1.2', family: 4 as const },
    { address: '104.16.1.3', family: 4 as const },
  ];
  assert.deepEqual(selectPinnedWebhookAddress(addresses, () => 0), addresses[1]);
  assert.deepEqual(selectPinnedWebhookAddress(addresses, () => 0.999), addresses[2]);
  assert.deepEqual(selectPinnedWebhookAddress([addresses[0]], () => 0), addresses[0]);
  assert.throws(() => selectPinnedWebhookAddress([]), /no_validated_address/);
});

test('real HTTPS request pins the socket while preserving TLS servername', async t => {
  const [cert, key] = await Promise.all([
    readFile(new URL('server-cert.pem', fixture)),
    readFile(new URL('server-key.pem', fixture)),
  ]);
  let servername: string | false | undefined;
  let remoteAddress: string | undefined;
  const server = https.createServer({ cert, key }, (request, response) => {
    remoteAddress = request.socket.remoteAddress;
    response.writeHead(204).end();
  });
  server.on('secureConnection', socket => { servername = socket.servername; });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const pinned = createPinnedWebhookLookup({ address: '127.0.0.1', family: 4 });
  let lookupAll: boolean | undefined;
  const lookup: LookupFunction = (hostname, options, callback) => {
    lookupAll = options.all;
    pinned(hostname, options, callback);
  };
  const status = await new Promise<number>((resolve, reject) => {
    const request = https.request(`https://localhost:${address.port}/webhook`, {
      method: 'POST', ca: cert, lookup,
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end('{}');
  });
  assert.equal(status, 204);
  assert.equal(servername, 'localhost');
  assert.ok(remoteAddress === '127.0.0.1' || remoteAddress === '::ffff:127.0.0.1');
  if (Number(process.versions.node.split('.')[0]) >= 24) assert.equal(lookupAll, true);
});

test('unreachable pinned HTTPS socket rejects without an unhandled TLS error', async () => {
  await assert.rejects(postWebhook({
    url: new URL('https://localhost:1/webhook'),
    addresses: [{ address: '127.0.0.1', family: 4 }],
  }, Buffer.from('{}'), 'sha256=test', '00000000-0000-4000-8000-000000000001', {
    timeoutMs: 1_000,
  }), error => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ECONNREFUSED' || (error as Error).message === 'webhook_timeout';
  });
});
