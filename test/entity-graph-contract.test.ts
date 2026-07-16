import assert from 'node:assert/strict';
import test from 'node:test';
import { graphSchema } from '../src/tools/graph.js';
import { GRAPH_MAX_DEPTH, GRAPH_MAX_EDGES, GRAPH_MAX_ENTITIES, GRAPH_MAX_MEMORIES } from '../src/entities.js';

test('memory_graph input is strict and bounded', () => {
  assert.deepEqual(graphSchema.parse({ entity: 'Project X' }), { entity: 'Project X', depth: 1 });
  assert.equal(graphSchema.parse({ entity: 'Alice', type: 'person', depth: GRAPH_MAX_DEPTH }).type, 'person');
  assert.throws(() => graphSchema.parse({ entity: 'x', type: 'company' }));
  assert.throws(() => graphSchema.parse({ entity: 'x', depth: GRAPH_MAX_DEPTH + 1 }));
  assert.throws(() => graphSchema.parse({ entity: 'x', extra: true }));
  assert.deepEqual([GRAPH_MAX_ENTITIES, GRAPH_MAX_MEMORIES, GRAPH_MAX_EDGES], [100, 500, 1_000]);
});
