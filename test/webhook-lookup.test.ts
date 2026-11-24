import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import test from 'node:test';
import { createPinnedWebhookLookup } from '../src/webhooks.js';

const fixture = new URL('./fixtures/local-embedding-tls/', import.meta.url);

test('pinned lookup honors Node 24 all mode without changing address or family', async () => {
  const lookup = createPinnedWebhookLookup({ address: '203.0.113.77', family: 4 });
  const all = await new Promise<unknown>((resolve, reject) => lookup('ignored.example', { all: true },
    (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(all, { address: [{ address: '203.0.113.77', family: 4 }], family: undefined });
  const one = await new Promise<unknown>((resolve, reject) => lookup('ignored.example', { all: false },
    (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(one, { address: '203.0.113.77', family: 4 });
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
