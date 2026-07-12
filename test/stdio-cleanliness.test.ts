import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const entrypoint = path.join(repoRoot, 'dist', 'index.js');
const providerAnnouncement = /^\[embedding\] (?:Using Gemini API \(.+?, \d+d\)|No GEMINI_API_KEY found, falling back to Ollama \(.+?\))$/gm;

function waitFor(
  child: ChildProcessWithoutNullStreams,
  condition: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
    const check = () => {
      if (!condition()) return;
      clearTimeout(deadline);
      child.stdout.off('data', check);
      child.stderr.off('data', check);
      resolve();
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    check();
  });
}

async function startServer(overrides: NodeJS.ProcessEnv): Promise<{
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  cleanup: () => Promise<void>;
}> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'total-recall-stdio-'));
  const child = spawn(process.execPath, [entrypoint], {
    cwd,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      DATABASE_URL: 'postgres://invalid:invalid@127.0.0.1:1/invalid',
      TOTAL_RECALL_API_KEY: '',
      ...overrides,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    cleanup: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise<void>((resolve) => child.once('exit', () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function parseProtocolOutput(raw: string): any[] {
  return raw.split('\n').filter(Boolean).map((line) => {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0');
    return message;
  });
}

for (const provider of [
  {
    name: 'Gemini',
    env: { GEMINI_API_KEY: 'test-secret', EMBEDDING_MODEL: 'test-model', EMBEDDING_DIMENSIONS: '768' },
    announcement: '[embedding] Using Gemini API (test-model, 768d)',
  },
  {
    name: 'Ollama',
    env: { GEMINI_API_KEY: '', OLLAMA_MODEL: 'test-ollama' },
    announcement: '[embedding] No GEMINI_API_KEY found, falling back to Ollama (test-ollama)',
  },
]) {
  test(`stdio startup and protocol output remain clean with ${provider.name}`, async () => {
    const server = await startServer(provider.env);
    try {
      await waitFor(server.child, () => server.stderr().includes('MCP server running on stdio'), 'server startup');
      assert.equal(server.stdout(), '', 'stdout must be empty before the first MCP request');
      assert.equal(server.stderr().match(providerAnnouncement)?.length, 1);
      assert.match(server.stderr(), new RegExp(provider.announcement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(server.stderr(), /test-secret|generativelanguage\.googleapis\.com/);

      send(server.child, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'stdio-cleanliness-test', version: '1.0.0' },
        },
      });
      send(server.child, { jsonrpc: '2.0', method: 'notifications/initialized' });
      send(server.child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

      await waitFor(
        server.child,
        () => parseProtocolOutput(server.stdout()).some((message) => message.id === 2),
        'initialize/list-tools responses',
      );
      const messages = parseProtocolOutput(server.stdout());
      assert.ok(messages.some((message) => message.id === 1 && message.result));
      assert.ok(messages.some((message) => message.id === 2 && Array.isArray(message.result?.tools)));
    } finally {
      await server.cleanup();
    }
  });
}

test('missing API key errors remain JSON-RPC-only on stdout', async () => {
  const server = await startServer({ GEMINI_API_KEY: '' });
  try {
    await waitFor(server.child, () => server.stderr().includes('MCP server running on stdio'), 'server startup');
    send(server.child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    send(server.child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    send(server.child, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_stats', arguments: {} } });

    await waitFor(
      server.child,
      () => parseProtocolOutput(server.stdout()).some((message) => message.id === 2),
      'missing-key error response',
    );
    const error = parseProtocolOutput(server.stdout()).find((message) => message.id === 2);
    assert.equal(error?.result?.isError, true, 'missing key should produce an MCP tool error');
    assert.match(error.result.content[0].text, /TOTAL_RECALL_API_KEY not set/);
  } finally {
    await server.cleanup();
  }
});

test('invalid API key failures remain JSON-RPC-only on stdout', async () => {
  const server = await startServer({ GEMINI_API_KEY: '', TOTAL_RECALL_API_KEY: 'tr_invalid' });
  try {
    await waitFor(server.child, () => server.stderr().includes('MCP server running on stdio'), 'server startup');
    send(server.child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    send(server.child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    send(server.child, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_stats', arguments: {} } });

    await waitFor(
      server.child,
      () => parseProtocolOutput(server.stdout()).some((message) => message.id === 2),
      'invalid-key error response',
      8_000,
    );
    const error = parseProtocolOutput(server.stdout()).find((message) => message.id === 2);
    assert.equal(error?.result?.isError, true, 'invalid key should produce an MCP tool error');
    assert.doesNotMatch(JSON.stringify(error), /tr_invalid/);
  } finally {
    await server.cleanup();
  }
});

test('npm test rebuilds the child-process entrypoint before exercising it', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts?.pretest, 'npm run build');
});

async function resolveLocalImport(importer: string, specifier: string): Promise<string> {
  const rawTarget = fileURLToPath(new URL(specifier, pathToFileURL(importer)));
  const candidates = specifier.endsWith('.js')
    ? [rawTarget.replace(/\.js$/, '.ts')]
    : [rawTarget, `${rawTarget}.ts`, path.join(rawTarget, 'index.ts')];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next supported local TypeScript resolution shape.
    }
  }
  throw new Error(`Unresolved relative import ${specifier} from ${path.relative(repoRoot, importer)}`);
}

test('stdio transitive source graph has no unapproved direct stdout diagnostics', async () => {
  const pending = [path.join(repoRoot, 'src', 'index.ts')];
  const visited = new Set<string>();
  const violations: string[] = [];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await fs.readFile(file, 'utf8');
    const stdoutConsoleMethods = [...source.matchAll(/console\.(\w+)\s*\(/g)]
      .map((match) => match[1])
      .filter((method) => method !== 'error' && method !== 'warn');
    if (stdoutConsoleMethods.length > 0 || /process\.stdout(?:\.|\[)/.test(source)) {
      violations.push(`${path.relative(repoRoot, file)} (${stdoutConsoleMethods.join(', ') || 'process.stdout'})`);
    }
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g)) {
      pending.push(await resolveLocalImport(file, match[1]));
    }
  }

  assert.deepEqual(violations, [], `stdout writes found in: ${violations.join(', ')}`);
});
