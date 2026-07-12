import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('MCP, OpenAPI, README, and spec document decoded and embedding chunk limits', () => {
  const register = source('../src/tools/register.ts');
  const openapi = source('../openapi.yaml');
  const readme = source('../README.md');
  const spec = source('../SPEC.md');

  for (const [name, text] of Object.entries({ register, openapi, readme, spec })) {
    assert.match(text, /1 MiB/i, `${name} must disclose the decoded content limit`);
    assert.match(text, /2,?000 UTF-8 byte/i, `${name} must disclose the embedding chunk limit`);
  }

  assert.match(openapi, /"400":\s*\n\s*description:.*decoded/is);
  assert.match(openapi, /"413":\s*\n\s*description:.*(?:transport|envelope)/is);
  assert.doesNotMatch(
    openapi.match(/content:\s*\n\s*type: string[\s\S]*?namespace:/)?.[0] ?? '',
    /maxLength:/,
    'OpenAPI character maxLength must not misrepresent the UTF-8-byte rule'
  );
});
