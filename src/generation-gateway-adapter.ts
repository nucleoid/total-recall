import { Buffer } from 'node:buffer';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

export interface GenerationGatewayConfig {
  host: string; port: number; bearerToken: string; upstreamEndpoint: string;
  upstreamApiKey: string; allowedAgents: ReadonlySet<string>; timeoutMs: number;
  maxInputBytes: number; maxOutputBytes: number; maxUpstreamResponseBytes: number;
}
type GatewayRequest = { model: string; system: string; input: string; max_output_bytes: number };

/** Load fail-closed config without discovering or reusing embedding credentials. */
export function generationGatewayConfigFromEnv(env: NodeJS.ProcessEnv): GenerationGatewayConfig {
  const allowedAgents = new Set(required(env, 'GENERATION_GATEWAY_ALLOWED_AGENTS').split(',').map(v => v.trim()).filter(Boolean));
  if (!allowedAgents.size || [...allowedAgents].some(value => !/^openclaw\/[a-zA-Z0-9._-]+$/.test(value))) {
    throw new Error('GENERATION_GATEWAY_ALLOWED_AGENTS must contain openclaw/<dedicated-agent-id> targets');
  }
  return {
    host: env.GENERATION_GATEWAY_HOST?.trim() || '127.0.0.1',
    port: integer(env.GENERATION_GATEWAY_PORT ?? '3010', 'GENERATION_GATEWAY_PORT', 1, 65535),
    bearerToken: required(env, 'GENERATION_GATEWAY_BEARER_TOKEN'),
    upstreamEndpoint: openClawUrl(required(env, 'GENERATION_GATEWAY_UPSTREAM_ENDPOINT')),
    upstreamApiKey: required(env, 'GENERATION_GATEWAY_UPSTREAM_API_KEY'), allowedAgents,
    timeoutMs: integer(env.GENERATION_GATEWAY_TIMEOUT_MS ?? '30000', 'GENERATION_GATEWAY_TIMEOUT_MS', 100, 120000),
    maxInputBytes: integer(env.GENERATION_GATEWAY_MAX_INPUT_BYTES ?? '1200000', 'GENERATION_GATEWAY_MAX_INPUT_BYTES', 1, 4000000),
    maxOutputBytes: integer(env.GENERATION_GATEWAY_MAX_OUTPUT_BYTES ?? '131072', 'GENERATION_GATEWAY_MAX_OUTPUT_BYTES', 1, 1000000),
    maxUpstreamResponseBytes: integer(env.GENERATION_GATEWAY_MAX_UPSTREAM_RESPONSE_BYTES ?? '524288', 'GENERATION_GATEWAY_MAX_UPSTREAM_RESPONSE_BYTES', 1024, 4000000),
  };
}

/** Total Recall contract -> official OpenClaw agent-targeting chat endpoint. */
export function createGenerationGatewayServer(config: GenerationGatewayConfig): http.Server {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') return send(response, 200, { status: 'ok' });
      if (request.method !== 'POST' || request.url !== '/v1/generate') return send(response, 404, { error: 'not_found' });
      if (request.headers.authorization !== `Bearer ${config.bearerToken}`) return send(response, 401, { error: 'unauthorized' });
      const generation = parseRequest(await readIncoming(request, config.maxInputBytes + 1024), config);
      return send(response, 200, { output: await callUpstream(generation, config) });
    } catch (error) {
      return send(response, error instanceof GatewayError ? error.status : 502, { error: error instanceof GatewayError ? error.code : 'upstream_error' });
    }
  });
}

export async function listenGenerationGateway(config: GenerationGatewayConfig): Promise<http.Server> {
  const server = createGenerationGatewayServer(config);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}

function parseRequest(body: string, config: GenerationGatewayConfig): GatewayRequest {
  let value: unknown; try { value = JSON.parse(body); } catch { throw new GatewayError(400, 'invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError(400, 'invalid_request');
  const r = value as Record<string, unknown>; const allowed = ['input', 'max_output_bytes', 'model', 'system', 'tools'];
  if (Object.keys(r).some(k => !allowed.includes(k)) || ['input','max_output_bytes','model','system'].some(k => !(k in r))) throw new GatewayError(400, 'invalid_request');
  if (typeof r.model !== 'string' || !config.allowedAgents.has(r.model)) throw new GatewayError(403, 'agent_not_allowed');
  if (typeof r.system !== 'string' || typeof r.input !== 'string') throw new GatewayError(400, 'invalid_request');
  if (r.tools !== undefined && (!Array.isArray(r.tools) || r.tools.length)) throw new GatewayError(400, 'tools_not_allowed');
  if (!Number.isSafeInteger(r.max_output_bytes) || (r.max_output_bytes as number) < 1 || (r.max_output_bytes as number) > config.maxOutputBytes) throw new GatewayError(400, 'invalid_output_limit');
  if (Buffer.byteLength(r.system) + Buffer.byteLength(r.input) > config.maxInputBytes) throw new GatewayError(413, 'input_too_large');
  return { model: r.model, system: r.system, input: r.input, max_output_bytes: r.max_output_bytes as number };
}

async function callUpstream(request: GatewayRequest, config: GenerationGatewayConfig): Promise<string> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.upstreamEndpoint, { method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${config.upstreamApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: request.model, messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.input }], tool_choice: 'none', stream: false, max_completion_tokens: Math.max(1, Math.ceil(request.max_output_bytes / 4)) }) });
    if (!response.ok) throw new GatewayError(502, 'upstream_status');
    const body = await readFetch(response, config.maxUpstreamResponseBytes); let value: unknown;
    try { value = JSON.parse(body); } catch { throw new GatewayError(502, 'upstream_invalid_json'); }
    const output = extractText(value);
    if (Buffer.byteLength(output) > request.max_output_bytes) throw new GatewayError(502, 'upstream_output_too_large');
    return output;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new GatewayError(504, 'upstream_timeout');
    throw new GatewayError(502, 'upstream_unavailable');
  } finally { clearTimeout(timeout); }
}

function extractText(value: unknown): string {
  const choices = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).choices : undefined;
  if (!Array.isArray(choices) || choices.length !== 1) throw new GatewayError(502, 'upstream_invalid_response');
  const choice = choices[0]; const message = choice && typeof choice === 'object' && !Array.isArray(choice) ? (choice as Record<string, unknown>).message : undefined;
  const content = message && typeof message === 'object' && !Array.isArray(message) ? (message as Record<string, unknown>).content : undefined;
  if (typeof content !== 'string') throw new GatewayError(502, 'upstream_invalid_response'); return content;
}
async function readIncoming(request: IncomingMessage, max: number): Promise<string> { const chunks: Buffer[]=[]; let bytes=0; for await (const chunk of request) { const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk); bytes+=b.length; if(bytes>max) throw new GatewayError(413,'request_too_large'); chunks.push(b); } return Buffer.concat(chunks).toString('utf8'); }
async function readFetch(response: Response, max: number): Promise<string> { if(!response.body)return ''; const reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let bytes=0; while(true){const {done,value}=await reader.read(); if(done)break; bytes+=value.length; if(bytes>max){await reader.cancel();throw new GatewayError(502,'upstream_response_too_large');}chunks.push(value);} return Buffer.concat(chunks).toString('utf8'); }
function send(response: ServerResponse, status: number, body: Record<string, unknown>): void { const encoded=JSON.stringify(body); response.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}); response.end(encoded); }
function required(env: NodeJS.ProcessEnv,name:string):string{const v=env[name]?.trim();if(!v)throw new Error(`${name} is required`);return v;}
function openClawUrl(raw:string):string{const u=new URL(raw);const loopbackHttp=u.protocol==='http:'&&u.hostname==='127.0.0.1';if((u.protocol!=='https:'&&!loopbackHttp)||u.username||u.password||u.hash||u.search||u.pathname!=='/v1/chat/completions')throw new Error('GENERATION_GATEWAY_UPSTREAM_ENDPOINT must be HTTPS, or canonical loopback http://127.0.0.1, with path /v1/chat/completions and no credentials, query, or fragment');return u.toString();}
function integer(raw:string,name:string,min:number,max:number):number{if(!/^\d+$/.test(raw))throw new Error(`${name} must be an integer from ${min} to ${max}`);const v=Number(raw);if(!Number.isSafeInteger(v)||v<min||v>max)throw new Error(`${name} must be an integer from ${min} to ${max}`);return v;}
class GatewayError extends Error { constructor(readonly status:number,readonly code:string){super(code);} }
