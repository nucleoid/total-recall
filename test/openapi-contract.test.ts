import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { getRestRouteInventory } from '../src/server.js';
import { agentRegisterSchema } from '../src/tools/register.js';
import { forgetSchema } from '../src/tools/forget.js';
import { mediaSearchSchema } from '../src/tools/media-search.js';
import { searchSchema } from '../src/tools/search.js';
import { storeDocumentSchema } from '../src/tools/store-document.js';
import { storeSchema } from '../src/tools/store.js';
import { publicMediaEventBatchSchema } from '../src/media.js';
import {
  auditQuerySchema,
  mediaEventsQuerySchema,
  mediaRollupSchema,
  tracesQuerySchema,
} from '../src/http-schemas.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

async function document(): Promise<any> {
  return parse(await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8'));
}

test('OpenAPI 3.1 document validates and has unique stable operation IDs', async () => {
  const file = fileURLToPath(new URL('../openapi.yaml', import.meta.url));
  const api = await SwaggerParser.validate(file) as any;
  assert.equal(api.openapi, '3.1.0');

  const operationIds: string[] = [];
  for (const pathItem of Object.values(api.paths ?? {}) as any[]) {
    for (const [method, operation] of Object.entries(pathItem ?? {}) as [string, any][]) {
      if (HTTP_METHODS.has(method)) operationIds.push(operation.operationId);
    }
  }
  assert.equal(operationIds.every((id) => typeof id === 'string' && id.length > 0), true);
  assert.equal(new Set(operationIds).size, operationIds.length);
  assert.equal(operationIds.includes('searchMemories'), true);
  assert.equal(operationIds.includes('storeMemory'), true);
  assert.equal(operationIds.includes('storeDocument'), true);
});

test('documented operations exactly match registration-derived non-MCP REST routes', async () => {
  const api = await document();
  const documented = Object.entries(api.paths).flatMap(([path, pathItem]: [string, any]) =>
    Object.keys(pathItem)
      .filter((method) => HTTP_METHODS.has(method))
      .map((method) => `${method.toUpperCase()} ${path}`)
  ).sort();

  assert.deepEqual(documented, getRestRouteInventory());
  assert.equal(documented.some((route) => route.endsWith(' /mcp')), false);
  assert.deepEqual(api.paths['/health'].get.security, []);
  assert.deepEqual(api.security, [{ bearerAuth: [] }]);
});

test('representative requests satisfy shared runtime and published schemas', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const now = '2026-07-16T00:00:00.000Z';
  const event = {
    service: 'spotify', event_type: 'play', title: 'Song', played_at: now,
  };
  const fixtures: Array<[string, unknown, { parse: (value: unknown) => unknown }]> = [
    ['SearchRequest', { query: 'remember', namespaces: ['shared'], tags: ['test'], after: now }, searchSchema],
    ['StoreRequest', { content: 'remember this', metadata: { source: 'fixture' } }, storeSchema],
    ['StoreDocumentRequest', { title: 'Fixture', content: 'Document text', source: 'test' }, storeDocumentSchema],
    ['ForgetRequest', { ids: [id], reason: 'contract fixture' }, forgetSchema],
    ['AgentRegistration', { name: 'contract-agent', type: 'llm' }, agentRegisterSchema],
    ['MediaSearchRequest', { query: 'song', services: ['spotify'], played_after: now }, mediaSearchSchema],
    ['MediaEventInput', event, { parse: (value) => publicMediaEventBatchSchema.parse({ events: [value] }).events[0] }],
  ];

  const openapiPath = fileURLToPath(new URL('../openapi.yaml', import.meta.url));
  const dereferenced = await SwaggerParser.dereference(openapiPath) as any;
  const AjvConstructor = Ajv2020 as any;
  const ajv = new AjvConstructor({ strict: false, allErrors: true });
  (addFormats as any)(ajv);

  for (const [name, fixture, runtimeSchema] of fixtures) {
    assert.doesNotThrow(() => runtimeSchema.parse(fixture), `${name} runtime schema`);
    const validate = ajv.compile(dereferenced.components.schemas[name]);
    assert.equal(validate(fixture), true, `${name}: ${ajv.errorsText(validate.errors)}`);
  }

  assert.deepEqual(tracesQuerySchema.parse({}), { limit: 20, offset: 0 });
  assert.deepEqual(auditQuerySchema.parse({}), { limit: 50, offset: 0 });
  assert.deepEqual(mediaEventsQuerySchema.parse({}), { limit: 50, offset: 0 });
  assert.deepEqual(mediaRollupSchema.parse({}), { batch_size: 50 });
});

test('representative runtime response fixtures satisfy the published schemas', async () => {
  const openapiPath = fileURLToPath(new URL('../openapi.yaml', import.meta.url));
  const dereferenced = await SwaggerParser.dereference(openapiPath) as any;
  const AjvConstructor = Ajv2020 as any;
  const ajv = new AjvConstructor({ strict: false, allErrors: true });
  (addFormats as any)(ajv);
  const id = '00000000-0000-4000-8000-000000000001';
  const now = '2026-07-16T00:00:00.000Z';
  const fixtures: Record<string, unknown> = {
    Health: { status: 'ok', version: '1.0.0' },
    StoreResponse: {
      id, namespace: 'shared', created: true, deduplicated: false, expires_at: null, idempotency_key_honored: true,
      state: 'queued', accepted_at: now,
    },
    StoreDocumentResponse: { id, chunks: 2 },
    ForgetResponse: { forgotten: [id], count: 1 },
    Stats: {
      total_memories: 1,
      by_namespace: [{ namespace: 'shared', count: 1 }],
      by_source: [{ source: 'test', count: 1 }],
      total_documents: 0,
      oldest_memory: now,
      newest_memory: now,
      ingestion: {
        depth: { pending: 2, processing: 1, retry_wait: 1, ready: 40, deduplicated: 3, embedding_failed: 1, cancelled: 0 },
        queued: 4, oldest_pending_age_seconds: 125.5, next_retry_at: now,
        attempts_histogram: [{ attempts: 0, count: 2 }, { attempts: 3, count: 2 }],
        failure_categories: { transient: 1, rate_limited: 0, provider_auth: 0, input_rejected: 1, space_mismatch: 0, expired: 0 },
        inline: { attempted: 10, ready: 8, deduplicated: 1, queued: 1 },
        worker: { paused: false, last_seen_at: now },
      },
    },
    IngestionQueueStats: {
      depth: { pending: 0, processing: 0, retry_wait: 0, ready: 0, deduplicated: 0, embedding_failed: 0, cancelled: 0 },
      queued: 0, oldest_pending_age_seconds: null, next_retry_at: null, attempts_histogram: [],
      failure_categories: { transient: 0, rate_limited: 0, provider_auth: 0, input_rejected: 0, space_mismatch: 0, expired: 0 },
      inline: { attempted: 0, ready: 0, deduplicated: 0, queued: 0 },
      worker: { paused: false, last_seen_at: null },
    },
    IngestionStats: {
      enabled: true,
      depth: { pending: 2, processing: 1, retry_wait: 1, ready: 40, deduplicated: 3, embedding_failed: 1, cancelled: 0 },
      queued: 4, oldest_pending_age_seconds: 7200, next_retry_at: now,
      attempts_histogram: [{ attempts: 0, count: 2 }, { attempts: 1, count: 1 }, { attempts: 12, count: 1 }],
      failure_categories: { transient: 1, rate_limited: 0, provider_auth: 0, input_rejected: 1, space_mismatch: 0, expired: 0 },
      inline: { attempted: 10, ready: 8, deduplicated: 1, queued: 1 },
      worker: { paused: true, last_seen_at: now },
    },
    IngestionRequeueResponse: {
      memory_id: id, namespace: 'shared', status: 'pending', previous_status: 'embedding_failed', previous_attempts: 12, requeued_at: now,
    },
    IngestionPauseState: { paused: true },
    Agent: {
      id, name: 'test', type: 'llm', model: null, runtime: null,
      parent_agent_id: null, api_key_id: id, metadata: {}, first_seen_at: now,
      last_seen_at: now, memory_count: 1, last_memory_at: now,
    },
    RecallTrace: {
      id, session_id: null, agent_id: id, client_id: id, query_text: 'query',
      memory_ids: [id], result_count: 1, scores: [{ id, final: 1 }],
      duration_ms: 4, created_at: now, agent_name: 'test',
    },
    AuditRecord: {
      id: '9007199254740993', client_id: id, action: 'memory.store', namespace: 'shared',
      memory_id: id, query_text: null, result_count: null, created_at: now,
      agent_id: id, session_id: null, agent_name: 'test',
    },
    SearchResult: {
      id, content: 'remember this', metadata: { source: 'fixture' }, tags: ['test'],
      source: 'test', namespace: 'shared', created_at: now, event_at: null, expires_at: null,
      relevance_score: 1, relevance_base_score: 1, decay_rate: 0.01,
      updated_at: now, accessed_at: now, access_count: 2, access_level: 'normal',
      client_id: id, memory_kind: 'semantic', valid_from: now, valid_to: null,
      supersedes_id: null, superseded_at: null, superseded_by_id: null,
      is_superseded: false, revision: 0, vec_score: null, text_score: 0.8,
      base_score: 1.1, relevance: 1, final_score: 1.1,
      ingestion: { state: 'queued' },
    },
    MemoryRecord: {
      id, content: 'remember this', source: 'test', namespace: 'shared', tags: ['test'], metadata: {},
      access_level: 'normal', client_id: id, agent_id: null, session_id: null, document_id: null, chunk_index: null,
      created_at: now, updated_at: now, accessed_at: now, access_count: 0, relevance_score: 1,
      memory_kind: 'semantic', valid_from: now, valid_to: null, supersedes_id: null, superseded_at: null,
      revision: 0, expires_at: null, consolidated_into_id: null, provenance: null,
      ingestion: {
        state: 'deduplicated', accepted_at: now, ready_at: now, attempts: 1, next_retry_at: null,
        failure_category: null, canonical_memory_id: id, similarity: 0.97,
      },
    },
    MemoryIngestion: {
      state: 'embedding_failed', accepted_at: now, ready_at: null, attempts: 12, next_retry_at: null,
      failure_category: 'transient', canonical_memory_id: null, similarity: null,
    },
    MediaEvent: {
      id, service: 'spotify', source_id: 'default', event_key: 'play:track:1', service_id: 'track:1', event_type: 'play', title: 'Song',
      artist: null, album: null, show: null, season: null, episode: null, year: null,
      genres: [], duration_ms: null, played_ms: null, completed: null, played_at: now,
      metadata: {}, client_id: id, agent_id: null, memory_id: null, created_at: now,
    },
    MediaUpsertResult: { inserted: 1, skipped: 0, ids: [id] },
    MediaRollupResult: { rolled: 1, failed: 0, errors: [] },
  };

  for (const [name, fixture] of Object.entries(fixtures)) {
    const validate = ajv.compile(dereferenced.components.schemas[name]);
    assert.equal(validate(fixture), true, `${name}: ${ajv.errorsText(validate.errors)}`);
  }

  // The gate-off memory_stats shape (no ingestion block) remains valid, and the
  // queue schemas reject the states a client must never see.
  const { ingestion: _ingestion, ...gateOffStats } = fixtures.Stats as Record<string, unknown>;
  assert.equal(ajv.compile(dereferenced.components.schemas.Stats)(gateOffStats), true);
  const validateRequeue = ajv.compile(dereferenced.components.schemas.IngestionRequeueResponse);
  assert.equal(validateRequeue({ ...(fixtures.IngestionRequeueResponse as object), previous_status: 'ready' }), false);
  assert.equal(validateRequeue({ ...(fixtures.IngestionRequeueResponse as object), status: 'ready' }), false);
  const validateStats = ajv.compile(dereferenced.components.schemas.IngestionStats);
  const { enabled: _enabled, ...withoutGate } = fixtures.IngestionStats as Record<string, unknown>;
  assert.equal(validateStats(withoutGate), false, 'the REST response always reports the gate');
});
