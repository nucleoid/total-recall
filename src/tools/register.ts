import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { AuthContext } from '../types.js';
import { dbScopeFromAuth } from '../db.js';
import { checkPermission } from '../auth.js';
import { MAX_MEMORY_TTL_SECONDS, storeSchema, memoryStore } from './store.js';
import { MAX_DOCUMENT_CONTENT_BYTES, storeDocumentSchema, memoryStoreDocument } from './store-document.js';
import { searchSchema, memorySearch } from './search.js';
import { recallSchema, memoryRecall } from './recall.js';
import { listNamespacesSchema, memoryListNamespaces } from './list-namespaces.js';
import { listSchema, memoryList } from './list.js';
import { statsSchema, memoryStats } from './stats.js';
import { forgetSchema, memoryForget } from './forget.js';
import { updateSchema, memoryUpdate } from './update.js';
import { MAX_DELETION_REASON_CHARS, MAX_FORGET_IDS } from '../memory-lifecycle.js';
import { mediaSearchSchema, mediaSearch } from './media-search.js';
import { graphSchema, memoryGraph } from './graph.js';
import {
  agentSubscribeSchema,
  agentListSubscriptionsSchema,
  agentUnsubscribeSchema,
  agentSubscribe,
  agentListSubscriptions,
  agentUnsubscribe,
} from './subscriptions.js';
import { SUBSCRIPTION_DEFAULT_THRESHOLD, SUBSCRIPTION_MAX_NAMESPACES, SUBSCRIPTION_QUERY_MAX_CHARS } from '../subscriptions.js';
import {
  MAX_SESSION_TRANSCRIPT_BYTES,
  memorySessionStatus,
  memoryStoreSession,
  sessionStatusSchema,
  storeSessionSchema,
} from '../session-distillation.js';
import { registerAgent, listAgents } from '../agents.js';
import {
  DOCUMENT_TITLE_MAX_CHARS,
  MEMORY_CONTENT_MAX_CHARS,
  METADATA_MAX_BYTES,
  METADATA_MAX_DEPTH,
  METADATA_MAX_KEYS,
  TAG_MAX_CHARS,
  TAG_MAX_COUNT,
  TEXT_FIELD_MAX_CHARS,
  metadataSchema,
} from '../http-limits.js';

export const agentRegisterSchema = z.object({
  name: z.string().min(1).max(TEXT_FIELD_MAX_CHARS),
  type: z.string().min(1).max(TEXT_FIELD_MAX_CHARS).default('llm'),
  model: z.string().min(1).max(TEXT_FIELD_MAX_CHARS).optional(),
  runtime: z.string().min(1).max(TEXT_FIELD_MAX_CHARS).optional(),
  parent_agent_name: z.string().min(1).max(TEXT_FIELD_MAX_CHARS).optional(),
  metadata: metadataSchema.default({}),
});

const agentListSchema = z.object({});

const TOOL_DEFINITIONS = [
  {
    name: 'memory_store',
    description:
      'Store a memory with automatic embedding generation. Near-duplicates in the same namespace, ' +
      'access level, and embedding space reuse and boost the canonical memory by default; the result ' +
      'reports created/deduplicated and similarity. Optional ttl is a positive integer lifetime in seconds; ' +
      'expiring writes bypass semantic dedupe and return their database-computed expires_at. For accurate provenance, pass agent_name identifying ' +
      'the agent storing this memory (e.g. "openclaw", "cursor-dev"). When omitted, the API key name is used as a fallback.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', maxLength: MEMORY_CONTENT_MAX_CHARS, description: `The memory content to store (maximum ${MEMORY_CONTENT_MAX_CHARS} JavaScript characters)` },
        namespace: { type: 'string', description: 'Namespace (default: shared)' },
        source: { type: 'string', description: 'Source identifier' },
        tags: { type: 'array', maxItems: TAG_MAX_COUNT, items: { type: 'string', maxLength: TAG_MAX_CHARS }, description: 'Tags for categorization' },
        metadata: { type: 'object', description: `Additional metadata (maximum ${METADATA_MAX_BYTES} serialized JSON bytes, depth ${METADATA_MAX_DEPTH}, ${METADATA_MAX_KEYS} keys total)` },
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
        idempotency_key: {
          type: 'string',
          description: 'Optional retry key (1-512 characters), scoped only to the authenticated API key. Reusing it updates the same memory, including authorized namespace and access-level moves; keyed responses acknowledge that the key was honored. Keyed stores bypass semantic deduplication.',
        },
        dedupe: {
          type: 'boolean',
          default: true,
          description: 'Set false to force insertion of a semantically similar but distinct memory (default: true). Cannot be true with ttl.',
        },
        ttl: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_MEMORY_TTL_SECONDS,
          description: 'Optional lifetime in seconds. Expiry is computed once using PostgreSQL statement time; omitted means permanent.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_update',
    description: 'Patch an active current memory. Tags and metadata replace their complete values. Optionally link it as the sole durable successor of another current memory.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        id: { type: 'string', format: 'uuid', description: 'Active current memory UUID to patch' },
        content: { type: 'string', minLength: 1, maxLength: MEMORY_CONTENT_MAX_CHARS, description: 'Replacement nonblank content; changed content is re-embedded' },
        tags: { type: 'array', maxItems: TAG_MAX_COUNT, items: { type: 'string', maxLength: TAG_MAX_CHARS }, description: 'Complete replacement tag list' },
        metadata: { type: 'object', description: `Complete replacement metadata object (maximum ${METADATA_MAX_BYTES} serialized JSON bytes)` },
        supersedes: { type: 'string', format: 'uuid', description: 'Current predecessor UUID; creates an immutable one-to-one history link' },
      },
      required: ['id'],
      anyOf: [
        { required: ['content'] },
        { required: ['tags'] },
        { required: ['metadata'] },
        { required: ['supersedes'] },
      ],
    },
  },
  {
    name: 'memory_store_document',
    description: 'Store up to 1 MiB of decoded UTF-8 document content. Markdown headings and paragraph boundaries are preferred; every lossless embedding chunk is at most 2,000 UTF-8 bytes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', maxLength: DOCUMENT_TITLE_MAX_CHARS, description: 'Document title' },
        content: { type: 'string', description: `Nonblank document content (maximum ${MAX_DOCUMENT_CONTENT_BYTES} decoded UTF-8 bytes; embedded losslessly in chunks of at most 2,000 UTF-8 bytes)` },
        namespace: { type: 'string', maxLength: TEXT_FIELD_MAX_CHARS, description: 'Namespace (default: shared)' },
        tags: { type: 'array', maxItems: TAG_MAX_COUNT, items: { type: 'string', maxLength: TAG_MAX_CHARS }, description: 'Tags for categorization' },
        source: { type: 'string', maxLength: TEXT_FIELD_MAX_CHARS, description: 'Source identifier (default: manual)' },
        metadata: { type: 'object', description: `Chunk metadata (maximum ${METADATA_MAX_BYTES} serialized JSON bytes, depth ${METADATA_MAX_DEPTH}, ${METADATA_MAX_KEYS} keys total)` },
        idempotency_key: {
          type: 'string',
          description: 'Optional retry key. Reusing the same key with the same active document returns it; a different/incomplete document conflicts, and visible tombstoned chunks return the stable idempotency_key_tombstoned conflict without restoration.',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'memory_store_session',
    description: 'Atomically store a bounded transcript as an episodic document and enqueue asynchronous durable-fact distillation. Generation remains disabled unless a separate #57 policy and worker are approved.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        transcript: { type: 'string', description: `Nonblank transcript (maximum ${MAX_SESSION_TRANSCRIPT_BYTES} decoded UTF-8 bytes)` },
        namespace: { type: 'string', minLength: 1, maxLength: TEXT_FIELD_MAX_CHARS, description: 'Namespace (default: shared)' },
        access_level: { type: 'string', enum: ['normal', 'sensitive', 'secret'], default: 'normal' },
        session_id: { type: 'string', minLength: 1, maxLength: TEXT_FIELD_MAX_CHARS, description: 'Optional caller session identity; identical retries converge and changed requests conflict' },
        agent_name: { type: 'string', minLength: 1, maxLength: TEXT_FIELD_MAX_CHARS, description: 'Conversation agent provenance; defaults to the authenticated API key name' },
        agent_type: { type: 'string', minLength: 1, maxLength: TEXT_FIELD_MAX_CHARS },
        agent_model: { type: 'string', minLength: 1, maxLength: TEXT_FIELD_MAX_CHARS },
        agent_runtime: { type: 'string', minLength: 1, maxLength: TEXT_FIELD_MAX_CHARS },
      },
      required: ['transcript'],
    },
  },
  {
    name: 'memory_session_status',
    description: 'Inspect an owned transcript distillation run without returning transcript or generated fact content.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: { episode_id: { type: 'string', format: 'uuid', description: 'Episode document UUID returned by memory_store_session' } },
      required: ['episode_id'],
    },
  },
  {
    name: 'memory_search',
    description:
      'Hybrid vector + full-text search across memories. ' +
      'For accurate provenance and recall trace logging, pass agent_name identifying the agent ' +
      'performing the search. When omitted, the API key name is used as a fallback. Each result includes structured provenance; it reports origin and same-key status, not trust.',
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
        valid_at: { type: 'string', format: 'date-time', description: 'Optional offset-aware ISO-8601 instant for half-open historical belief validity [valid_from, valid_to)' },
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
    name: 'memory_graph',
    description: 'Traverse the bounded namespace-scoped entity graph. Returns exact-name seeds, linked active memories, co-occurring entities, edges, indexing completeness, and truncation flags.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        entity: { type: 'string', minLength: 1, maxLength: 256, description: 'Exact entity display name after conservative Unicode/case normalization' },
        type: { type: 'string', enum: ['person', 'project', 'tool', 'place'], description: 'Optional entity type disambiguator' },
        namespaces: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: TEXT_FIELD_MAX_CHARS }, description: 'Namespaces to intersect with the caller ACL' },
        depth: { type: 'integer', minimum: 0, maximum: 3, default: 1, description: 'Co-occurring entity hops (default 1)' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'memory_recall',
    description: 'Recall a specific memory by ID, or all chunks of a document by document_id. Results include structured origin provenance; client-supplied agent labels are not trust assertions.',
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
    description: 'List and browse memories with filters (no vector search). Supports pagination and returns structured origin provenance.',
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
    name: 'memory_forget',
    description: 'Soft-delete matching memories. Selectors combine with AND. Filter-only requests require confirm: true. Requires the explicit delete permission.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        ids: { type: 'array', minItems: 1, maxItems: MAX_FORGET_IDS, uniqueItems: true, items: { type: 'string', format: 'uuid' }, description: 'Memory UUIDs' },
        namespace: { type: 'string', minLength: 1, maxLength: 512, description: 'Namespace selector' },
        before: { type: 'string', format: 'date-time', description: 'Strict created_at boundary (created_at < before)' },
        tags: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 256 }, description: 'Tags selector (AND)' },
        confirm: { type: 'boolean', description: 'Must be true when ids is omitted' },
        reason: { type: 'string', minLength: 1, maxLength: MAX_DELETION_REASON_CHARS, description: 'Optional private deletion reason; never copied into audit output' },
      },
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
    name: 'media_search',
    description:
      'Vector + text search over media activity (viewing/listening history) rolled up from third-party services. ' +
      'Filter by service (spotify, plex, ytmusic, netflix, neon), event type, or date range. ' +
      'Returns rolled-up summary memories from the "media" namespace.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural-language search query' },
        services: { type: 'array', items: { type: 'string' }, description: 'Filter by services (e.g. ["spotify","plex"])' },
        event_types: { type: 'array', items: { type: 'string' }, description: 'Filter by event types (e.g. ["watch","play"])' },
        played_after: { type: 'string', description: 'Offset-aware ISO date-time or YYYY-MM-DD: only return events on/after this instant or UTC day' },
        played_before: { type: 'string', description: 'Offset-aware ISO date-time or YYYY-MM-DD: only return events on/before this instant or UTC day' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Extra tag filters (AND)' },
        limit: { type: 'number', description: 'Max results (default 10, max 50)' },
        threshold: { type: 'number', description: 'Min similarity threshold (default 0.3)' },
        agent_name: { type: 'string', description: 'Agent performing the search; falls back to API key name' },
        session_id: { type: 'string', description: 'Session/conversation ID for grouping operations' },
      },
      required: ['query'],
    },
  },
  {
    name: 'agent_subscribe',
    description: 'Register a durable semantic interest. Matching new normal memories enqueue signed ID-only HTTPS webhook notifications.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: SUBSCRIPTION_QUERY_MAX_CHARS, description: 'Semantic standing query' },
        webhook_url: { type: 'string', format: 'uri', maxLength: 4096, description: 'Public HTTPS callback on port 443; private and reserved destinations are rejected' },
        namespaces: { type: 'array', minItems: 1, maxItems: SUBSCRIPTION_MAX_NAMESPACES, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: TEXT_FIELD_MAX_CHARS }, description: 'Namespaces, each of which must remain in the owner key ACL' },
        threshold: { type: 'number', minimum: 0, maximum: 1, default: SUBSCRIPTION_DEFAULT_THRESHOLD },
        exclude_self: { type: 'boolean', default: true, description: 'Exclude memories written by this subscription owner API key' },
        idempotency_key: { type: 'string', minLength: 1, maxLength: 512, description: 'Required owner-scoped retry key' },
        agent_name: { type: 'string', minLength: 1, maxLength: TEXT_FIELD_MAX_CHARS, description: 'Optional provenance agent already registered to this API key' },
      },
      required: ['query', 'webhook_url', 'idempotency_key'],
    },
  },
  {
    name: 'agent_list_subscriptions',
    description: 'List subscriptions owned by this API key with redacted destinations and delivery counts.',
    inputSchema: { type: 'object' as const, additionalProperties: false, properties: {} },
  },
  {
    name: 'agent_unsubscribe',
    description: 'Disable an owned subscription and cancel its undelivered notifications while retaining history.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: { id: { type: 'string', format: 'uuid', description: 'Owned subscription UUID' } },
      required: ['id'],
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

function sessionToolsEnabled(): boolean {
  return process.env.MEMORY_SESSION_TOOLS_ENABLED !== 'false';
}

export function registerTools(server: Server, getAuth: AuthResolver): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: sessionToolsEnabled()
      ? TOOL_DEFINITIONS
      : TOOL_DEFINITIONS.filter(tool => !['memory_store_session', 'memory_session_status'].includes(tool.name)),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const auth = await getAuth();
      const scope = dbScopeFromAuth(auth);

      switch (name) {
        case 'memory_store': {
          const params = storeSchema.parse(args);
          const result = await memoryStore(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        case 'memory_update': {
          const params = updateSchema.parse(args);
          const result = await memoryUpdate(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        case 'memory_store_document': {
          const params = storeDocumentSchema.parse(args);
          const result = await memoryStoreDocument(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        case 'memory_store_session': {
          if (!sessionToolsEnabled()) throw new Error('Session ingestion tools are disabled by operator policy');
          const params = storeSessionSchema.parse(args);
          const result = await memoryStoreSession(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        case 'memory_session_status': {
          if (!sessionToolsEnabled()) throw new Error('Session ingestion tools are disabled by operator policy');
          const params = sessionStatusSchema.parse(args);
          const result = await memorySessionStatus(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        case 'memory_search': {
          const params = searchSchema.parse(args);
          const results = await memorySearch(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        }
        case 'memory_graph': {
          const params = graphSchema.parse(args);
          const result = await memoryGraph(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
        case 'memory_forget': {
          const params = forgetSchema.parse(args);
          const result = await memoryForget(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        case 'media_search': {
          const params = mediaSearchSchema.parse(args);
          const results = await mediaSearch(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        }
        case 'agent_subscribe': {
          const params = agentSubscribeSchema.parse(args);
          const result = await agentSubscribe(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        case 'agent_list_subscriptions': {
          const params = agentListSubscriptionsSchema.parse(args);
          const result = await agentListSubscriptions(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        case 'agent_unsubscribe': {
          const params = agentUnsubscribeSchema.parse(args);
          const result = await agentUnsubscribe(params, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        case 'agent_register': {
          checkPermission(auth, 'write');
          const params = agentRegisterSchema.parse(args);
          const result = await registerAgent({
            ...params,
            api_key_id: auth.keyId,
          }, auth);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        case 'agent_list': {
          checkPermission(auth, 'read');
          agentListSchema.parse(args);
          const result = await listAgents(auth, scope);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (err: any) {
      const code = typeof err?.code === 'string' ? ` [${err.code}]` : '';
      return { content: [{ type: 'text', text: `Error${code}: ${err.message}` }], isError: true };
    }
  });
}
