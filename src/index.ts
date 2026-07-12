import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { shutdown } from './db.js';
import { validateKey } from './auth.js';
import type { AuthContext } from './types.js';
import { registerTools } from './tools/register.js';

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

function isEntrypoint(): boolean {
  return typeof process.argv[1] === 'string' &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isEntrypoint()) {
  process.on('SIGINT', async () => {
    console.error('[total-recall] Shutting down...');
    await shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });

  main().catch((err) => {
    console.error('[total-recall] Fatal:', err);
    process.exit(1);
  });
}
