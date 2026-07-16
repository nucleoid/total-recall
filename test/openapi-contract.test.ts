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
    StoreResponse: { id, namespace: 'shared', created: true, deduplicated: false, expires_at: null, idempotency_key_honored: true },
    StoreDocumentResponse: { id, chunks: 2 },
    ForgetResponse: { forgotten: [id], count: 1 },
    Stats: {
      total_memories: 1,
      by_namespace: [{ namespace: 'shared', count: 1 }],
      by_source: [{ source: 'test', count: 1 }],
      total_documents: 0,
      oldest_memory: now,
      newest_memory: now,
    },
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
    },
    MediaEvent: {
      id, service: 'spotify', service_id: 'track:1', event_type: 'play', title: 'Song',
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
});
