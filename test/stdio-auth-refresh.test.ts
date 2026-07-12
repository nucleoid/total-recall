import assert from 'node:assert/strict';
import test from 'node:test';
import { createStdioAuthResolver } from '../src/index.js';
import { registerTools } from '../src/tools/register.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AuthContext } from '../src/types.js';

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    keyId: 'key-a',
    name: 'stdio key',
    namespaces: ['alpha'],
    permissions: ['read'],
    maxAccessLevel: 'normal',
    ...overrides,
  };
}

test('stdio auth revalidates the startup key for every tool operation', async () => {
  const seenKeys: string[] = [];
  const results: Array<AuthContext | null> = [
    auth(),
    auth({ namespaces: ['beta'], permissions: ['read', 'write'] }),
    null,
  ];
  const getAuth = createStdioAuthResolver('tr_startup_secret', async (apiKey) => {
    seenKeys.push(apiKey);
    return results.shift() ?? null;
  });

  assert.deepEqual(await getAuth(), auth());
  assert.deepEqual(await getAuth(), auth({ namespaces: ['beta'], permissions: ['read', 'write'] }));
  const rejection = await getAuth().catch((error: unknown) => error);
  assert.match(String(rejection), /Invalid API key/);
  assert.doesNotMatch(String(rejection), /tr_startup_secret/);
  assert.deepEqual(seenKeys, ['tr_startup_secret', 'tr_startup_secret', 'tr_startup_secret']);
});

test('tool auth failures are controlled per-call errors and do not poison recovery', async () => {
  let callHandler: ((request: any) => Promise<any>) | undefined;
  const fakeServer = {
    setRequestHandler(_schema: unknown, handler: (request: any) => Promise<any>) {
      callHandler = handler;
    },
  } as unknown as Server;
  const refreshed = auth({ namespaces: ['fresh'], permissions: ['read', 'write'] });
  let attempts = 0;

  registerTools(fakeServer, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('authentication temporarily unavailable');
    return refreshed;
  });

  assert.ok(callHandler);
  const request = { params: { name: 'unknown_test_tool', arguments: {} } };
  const failed = await callHandler(request);
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /authentication temporarily unavailable/);

  const recovered = await callHandler(request);
  assert.equal(recovered.isError, true);
  assert.equal(recovered.content[0].text, 'Unknown tool: unknown_test_tool');
  assert.equal(attempts, 2);
});
