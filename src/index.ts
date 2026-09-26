import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import { shutdownContradictionRuntime } from './contradictions.js';
import { shutdown } from './db.js';
import { validateKey } from './auth.js';
import { consumeRateLimit } from './security.js';
import type { AuthContext } from './types.js';
import { registerTools } from './tools/register.js';
import { isDirectExecution } from './entrypoint.js';

dotenv.config();

const API_KEY = process.env.TOTAL_RECALL_API_KEY || '';

type ValidateKey = typeof validateKey;

export function createStdioAuthResolver(
  apiKey: string,
  validator: ValidateKey = validateKey,
): () => Promise<AuthContext> {
  return async () => {
    if (!apiKey) throw new Error('TOTAL_RECALL_API_KEY not set');
    const ctx = await validator(apiKey);
    if (!ctx) throw new Error('Invalid API key');
    await consumeRateLimit(ctx);
    return ctx;
  };
}

async function main(): Promise<void> {
  const server = new Server(
    { name: 'total-recall', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  registerTools(server, createStdioAuthResolver(API_KEY));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[total-recall] MCP server running on stdio');
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  process.on('SIGINT', async () => {
    console.error('[total-recall] Shutting down...');
    await shutdownContradictionRuntime();
    await shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await shutdownContradictionRuntime();
    await shutdown();
    process.exit(0);
  });

  main().catch((err) => {
    console.error('[total-recall] Fatal:', err);
    process.exit(1);
  });
}
