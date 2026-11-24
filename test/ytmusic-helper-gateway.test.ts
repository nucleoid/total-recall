import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createYtmusicHelperGateway } from '../src/ytmusic-helper-gateway.js';

function request(port: number, authorization: string, body: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const call = https.request({
      host: '127.0.0.1', port, path: '/v1/ytmusic/fetch', method: 'POST',
      rejectUnauthorized: false,
      headers: { authorization, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    call.once('error', reject); call.end(body);
  });
}

test('private helper gateway authenticates, bounds, executes, and returns refreshed token privately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ytmusic-helper-test-'));
  const helper = join(directory, 'helper.mjs');
  await writeFile(helper, `import { readFileSync, writeFileSync } from 'node:fs';
const tokenPath = process.argv[process.argv.indexOf('--token-file') + 1];
const token = JSON.parse(readFileSync(tokenPath, 'utf8'));
writeFileSync(tokenPath, JSON.stringify({ ...token, refreshed: true }));
process.stdout.write(JSON.stringify({ items: [] }));
`);
  const fixture = new URL('./fixtures/local-embedding-tls/', import.meta.url);
  const server = createYtmusicHelperGateway({
    host: '127.0.0.1', port: 0, bearerToken: 'test-token',
    python: process.execPath, helper,
    tls: {
      cert: await readFile(new URL('server-cert.pem', fixture)),
      key: await readFile(new URL('server-key.pem', fixture)),
    },
    timeoutMs: 5000, maxRequestBytes: 4096, maxResponseBytes: 4096,
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  try {
    assert.equal((await request(address.port, 'Bearer wrong', '{}')).status, 401);
    const response = await request(address.port, 'Bearer test-token', JSON.stringify({ token: { cookie: 'private' } }));
    assert.equal(response.status, 200);
    assert.equal(response.body.code, 0);
    assert.deepEqual(JSON.parse(response.body.stdout), { items: [] });
    const refresh = response.body.stderr.trim().split('\n').map(JSON.parse).find((value: any) => value.token_update);
    assert.deepEqual(refresh.token_update, { cookie: 'private', refreshed: true });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
