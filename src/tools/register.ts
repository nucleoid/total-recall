import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { AuthContext } from '../types.js';
import { setNamespaceContext } from '../db.js';
import { storeSchema, memoryStore } from './store.js';
import { storeDocumentSchema, memoryStoreDocument } from './store-document.js';
import { searchSchema, memorySearch } from './search.js';
import { recallSchema, memoryRecall } from './recall.js';
import { listNamespacesSchema, memoryListNamespaces } from './list-namespaces.js';
import { listSchema, memoryList } from './list.js';
import { statsSchema, memoryStats } from './stats.js';
import { upsertAgent, listAgents } from '../agents.js';

const agentRegisterSchema = z.object({
  name: z.string().min(1),
  type: z.string().default('llm'),
  model: z.string().optional(),
  runtime: z.string().optional(),
  parent_agent_name: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});

const agentListSchema = z.object({});

const TOOL_DEFINITIONS = [
  {
    name: 'memory_store',
    description:
      'Store a memory with automatic embedding generation. ' +
      'For accurate provenance, pass agent_name identifying the agent storing this memory ' +
      '(e.g. "openclaw", "cursor-dev"). When omitted, the API key name is used as a fallback.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The memory content to store' },
        namespace: { type: 'string', description: 'Namespace (default: shared)' },
        source: { type: 'string', description: 'Source identifier' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        metadata: { type: 'object', description: 'Additional metadata' },
        access_level: { type: 'string', enum: ['normal', 'sensitive', 'secret'] },
        agent_name: {
          type: 'string',
          description:
            'Name of the agent storing this memory (e.g. "openclaw", "cursor-dev"). ' +
            'Strongly recommended for provenance. Falls back to the API key name if omitted.',
        },
        agent_type: { type: 'string', description: 'Agent type: llm, system, human, tool (default: llm when agent_name explicit)' },
        agent_model: { type: 'string', description: 'LLM model identifier (e.g. "claude-opus-4-7")' },
        agent_runtime: { type: 'string', description: 'Runtime environment (e.g. "claude-code", "openclaw")' },
        session_id: { type: 'string', description: 'Optional session/conversation ID for grouping related operations' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_store_document',
    description: 'Store a document by chunking it and embedding each chunk. Supports markdown (splits on ## headings) and plain text (splits on paragraphs).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Document title' },
        content: { type: 'string', description: 'Full document content' },
        namespace: { type: 'string', description: 'Namespace (default: shared)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        source: { type: 'string', description: 'Source identifier (default: manual)' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'memory_search',
    description:
      'Hybrid vector + full-text search across memories. ' +
      'For accurate provenance and recall trace logging, pass agent_name identifying the agent ' +
      'performing the search. When omitted, the API key name is used as a fallback.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        namespaces: { type: 'array', items: { type: 'string' }, description: 'Namespaces to search' },
        limit: { type: 'number', description: 'Max results (default 10, max 50)' },
        threshold: { type: 'number', description: 'Min similarity threshold (default 0.3)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (AND)' },
        source: { type: 'string', description: 'Filter by source' },
        after: { type: 'string', description: 'Filter: created after ISO date' },
        before: { type: 'string', description: 'Filter: created before ISO date' },
        agent_name: {
          type: 'string',
          description:
            'Name of the agent performing this search (e.g. "openclaw", "cursor-dev"). ' +
            'Strongly recommended for trace logging. Falls back to the API key name if omitted.',
        },
        session_id: { type: 'string', description: 'Optional session/conversation ID for grouping related operations' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_recall',
    description: 'Recall a specific memory by ID, or all chunks of a document by document_id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Memory UUID' },
        document_id: { type: 'string', description: 'Document UUID to retrieve all chunks' },
      },
    },
  },
  {
    name: 'memory_list',
    description: 'List and browse memories with filters (no vector search). Supports pagination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Filter by namespace' },
        source: { type: 'string', description: 'Filter by source' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (AND)' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
        offset: { type: 'number', description: 'Offset for pagination (default 0)' },
      },
    },
  },
  {
    name: 'memory_list_namespaces',
    description: 'List accessible namespaces and their memory counts.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'memory_stats',
    description: 'Get statistics about the memory store (admin-only).',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'agent_register',
    description: 'Register or update an AI agent for provenance tracking.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Unique agent name' },
        type: { type: 'string', description: 'Agent type: llm, system, human, tool (default: llm)' },
        model: { type: 'string', description: 'Model identifier (e.g. claude-opus-4-6)' },
        runtime: { type: 'string', description: 'Runtime environment (e.g. openclaw, claude-code)' },
        parent_agent_name: { type: 'string', description: 'Name of the parent agent' },
        metadata: { type: 'object', description: 'Additional metadata' },
      },
      required: ['name'],
    },
  },
  {
    name: 'agent_list',
    description: 'List all registered agents with memory counts and last activity.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

type AuthResolver = () => Promise<AuthContext>;

export function registerTools(server: Server, getAuth: AuthResolver): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const auth = await getAuth();
    await setNamespaceContext(auth.namespaces);

    try {
      switch (name) {
        case 'memory_store': {
          const params = storeSchema.parse(args);
          const result = await memoryStore(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        case 'memory_store_document': {
          const params = storeDocumentSchema.parse(args);
          const result = await memoryStoreDocument(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        case 'memory_search': {
          const params = searchSchema.parse(args);
          const results = await memorySearch(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        }
        case 'memory_recall': {
          const params = recallSchema.parse(args);
          const result = await memoryRecall(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        case 'memory_list': {
          const params = listSchema.parse(args);
          const result = await memoryList(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        case 'memory_list_namespaces': {
          const params = listNamespacesSchema.parse(args);
          const result = await memoryListNamespaces(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        case 'memory_stats': {
          const params = statsSchema.parse(args);
          const result = await memoryStats(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        case 'agent_register': {
          const params = agentRegisterSchema.parse(args);
          const result = await upsertAgent({
            ...params,
            api_key_id: auth.keyId,
          });
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        case 'agent_list': {
          agentListSchema.parse(args);
          const result = await listAgents();
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });
}
