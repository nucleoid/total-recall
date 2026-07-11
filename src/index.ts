import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import { shutdown } from './db.js';
import { validateKey } from './auth.js';
import type { AuthContext } from './types.js';
import { registerTools } from './tools/register.js';

dotenv.config();

const API_KEY = process.env.TOTAL_RECALL_API_KEY || '';

const server = new Server(
  { name: 'total-recall', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

async function getAuth(): Promise<AuthContext> {
  if (!API_KEY) throw new Error('TOTAL_RECALL_API_KEY not set');
  const ctx = await validateKey(API_KEY);
  if (!ctx) throw new Error('Invalid API key');
  return ctx;
}

registerTools(server, getAuth);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[total-recall] MCP server running on stdio');
}

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
