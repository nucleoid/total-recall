import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https, { type ServerOptions } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface YtmusicHelperGatewayConfig {
  host: string; port: number; bearerToken: string; python: string; helper: string;
  tls: ServerOptions; timeoutMs: number; maxRequestBytes: number; maxResponseBytes: number;
}

export function createYtmusicHelperGateway(config: YtmusicHelperGatewayConfig): https.Server {
  return https.createServer(config.tls, async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') return send(response, 200, { status: 'ok' });
      if (request.method !== 'POST' || request.url !== '/v1/ytmusic/fetch') return send(response, 404, { error: 'not_found' });
      if (request.headers.authorization !== 'Bearer ' + config.bearerToken) return send(response, 401, { error: 'unauthorized' });
      const body = await readRequest(request, config.maxRequestBytes);
      let parsed: { token?: unknown };
      try { parsed = JSON.parse(body) as { token?: unknown }; }
      catch { throw new GatewayError(400, 'invalid_json'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          Object.keys(parsed).length !== 1 || !parsed.token || typeof parsed.token !== 'object' || Array.isArray(parsed.token)) {
        return send(response, 400, { error: 'invalid_request' });
      }
      const result = await executeHelper(parsed.token, config);
      return send(response, 200, result);
    } catch (error) {
      const code = error instanceof GatewayError ? error.code : 'helper_failed';
      const status = error instanceof GatewayError ? error.status : 502;
      return send(response, status, { error: code });
    }
  });
}

async function executeHelper(token: unknown, config: YtmusicHelperGatewayConfig): Promise<{ stdout: string; stderr: string; code: number }> {
  const directory = await mkdtemp(join(tmpdir(), 'total-recall-ytmusic-'));
  const tokenPath = join(directory, 'token.json');
  try {
    await writeFile(tokenPath, JSON.stringify(token), { mode: 0o600, flag: 'wx' });
    const result = await runProcess(config.python, [config.helper, 'fetch', '--token-file', tokenPath], config.timeoutMs, config.maxResponseBytes);
    try {
      const refreshed = JSON.parse(await readFile(tokenPath, 'utf8'));
      if (JSON.stringify(refreshed) !== JSON.stringify(token)) {
        result.stderr += (result.stderr.endsWith('\n') || !result.stderr ? '' : '\n') +
          JSON.stringify({ token_update: refreshed }) + '\n';
      }
    } catch {
      throw new GatewayError(502, 'token_refresh_invalid');
    }
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runProcess(command: string, args: string[], timeoutMs: number, maxBytes: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new GatewayError(504, 'helper_timeout')); }, timeoutMs);
    const finish = (error?: Error, code = -1) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code });
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { child.kill('SIGKILL'); finish(new GatewayError(502, 'helper_output_too_large')); return; }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.once('error', () => finish(new GatewayError(502, 'helper_unavailable')));
    child.once('close', code => finish(undefined, code ?? -1));
  });
}

async function readRequest(request: AsyncIterable<Buffer | string>, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maxBytes) throw new GatewayError(413, 'request_too_large');
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(response: import('node:http').ServerResponse, status: number, body: Record<string, unknown>): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) });
  response.end(encoded);
}

class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
