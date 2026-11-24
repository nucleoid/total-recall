import assert from 'node:assert/strict';
import test from 'node:test';
import { createGenerationGatewayServer, generationGatewayConfigFromEnv, type GenerationGatewayConfig } from '../src/generation-gateway-adapter.js';

const config: GenerationGatewayConfig = {
  host: '127.0.0.1', port: 0, bearerToken: 'worker-secret',
  upstreamEndpoint: 'https://approved.invalid/v1/chat/completions', upstreamApiKey: 'upstream-secret',
  allowedAgents: new Set(['openclaw/total-recall-synthesis']), timeoutMs: 1000, maxInputBytes: 1024,
  maxOutputBytes: 256, maxUpstreamResponseBytes: 4096,
};

async function withServer(run: (url: string) => Promise<void>): Promise<void> {
  const server = createGenerationGatewayServer(config);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  try { await run('http://127.0.0.1:' + address.port); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('gateway config requires an OpenClaw agent and rejects non-loopback HTTP', () => {
  assert.throws(() => generationGatewayConfigFromEnv({}), /GENERATION_GATEWAY_ALLOWED_AGENTS/);
  assert.throws(() => generationGatewayConfigFromEnv({
    GENERATION_GATEWAY_ALLOWED_AGENTS: 'openclaw/total-recall-synthesis', GENERATION_GATEWAY_BEARER_TOKEN: 'x',
    GENERATION_GATEWAY_UPSTREAM_ENDPOINT: 'http://local.invalid/v1/chat/completions', GENERATION_GATEWAY_UPSTREAM_API_KEY: 'y',
  }), /canonical loopback/);
  const parsed = generationGatewayConfigFromEnv({
    GENERATION_GATEWAY_ALLOWED_AGENTS: 'openclaw/total-recall-synthesis', GENERATION_GATEWAY_BEARER_TOKEN: 'x',
    GENERATION_GATEWAY_UPSTREAM_ENDPOINT: 'http://127.0.0.1:18789/v1/chat/completions', GENERATION_GATEWAY_UPSTREAM_API_KEY: 'y',
  });
  assert.equal(parsed.upstreamEndpoint, 'http://127.0.0.1:18789/v1/chat/completions');
});

test('adapter authenticates, rejects tools, and targets a bounded dedicated OpenClaw agent', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    upstreamBody = JSON.parse(String(init?.body));
    assert.equal((init?.headers as Record<string,string>).authorization, 'Bearer upstream-secret');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'bounded output' } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    await withServer(async url => {
      const unauthorized = await originalFetch(url + '/v1/generate', { method: 'POST', body: '{}' });
      assert.equal(unauthorized.status, 401);
      const tools = await originalFetch(url + '/v1/generate', { method: 'POST', headers: { authorization: 'Bearer worker-secret' },
        body: JSON.stringify({ model: 'openclaw/total-recall-synthesis', system: 's', input: 'i', max_output_bytes: 64, tools: [{ type: 'function' }] }) });
      assert.equal(tools.status, 400); assert.deepEqual(await tools.json(), { error: 'tools_not_allowed' });
      const response = await originalFetch(url + '/v1/generate', { method: 'POST', headers: { authorization: 'Bearer worker-secret' },
        body: JSON.stringify({ model: 'openclaw/total-recall-synthesis', system: 'system', input: 'input', max_output_bytes: 64, tools: [] }) });
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { output: 'bounded output' });
      assert.equal(upstreamBody?.model, 'openclaw/total-recall-synthesis');
      assert.equal(upstreamBody?.max_completion_tokens, 16);
      assert.equal(upstreamBody?.tool_choice, 'none');
      assert.equal(upstreamBody?.stream, false);
      assert.equal('tools' in (upstreamBody ?? {}), false);
    });
  } finally { globalThis.fetch = originalFetch; }
});
